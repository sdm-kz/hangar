using System.Diagnostics;
using System.Text;
using ClaudeWeb.Contract;

namespace ClaudeWeb.Server.Sessions.Shells;

/// <summary>One shell the host machine can run, as offered in the "+" menu of a session's tab bar.</summary>
/// <remarks>
/// <see cref="Id"/> is the stable handle the browser sends back to open a tab; <see cref="Kind"/> is
/// the family, which is all the UI needs to pick an icon (several WSL distributions share one).
/// </remarks>
public sealed record ShellOption(
    /// <summary>Stable id: "cmd" | "powershell" | "pwsh" | "gitbash" | "wsl:&lt;distro&gt;" on Windows; "bash" | "zsh" | "fish" | "pwsh" | "sh" elsewhere.</summary>
    string Id,
    /// <summary>What the menu shows, e.g. "PowerShell 7" or "Ubuntu-24.04 (WSL)".</summary>
    string Label,
    /// <summary>Family, for the icon: "cmd" | "powershell" | "pwsh" | "bash" | "wsl" (and "zsh" | "fish" | "sh" off Windows).</summary>
    string Kind,
    /// <summary>Where it was found (an exe path, or the distribution name) — shown as a tooltip.</summary>
    string Detail);

/// <summary>How to actually launch a shell: what to spawn in the pseudoconsole, and with what.</summary>
/// <param name="Arguments">
/// Already-quoted tokens on Windows: they are joined with spaces into a verbatim command line rather
/// than being quoted again per-argument. Elsewhere each token is one argv entry as it stands. See
/// <see cref="ShellCatalog.Quote"/>.
/// </param>
public sealed record ShellLaunch(
    string FileName,
    IReadOnlyList<string> Arguments,
    IReadOnlyDictionary<string, string> ExtraEnvironment);

/// <summary>
/// What shells this machine can offer, and how to start each one attached to a pseudoconsole.
/// </summary>
/// <remarks>
/// <para>Detection is by probing the filesystem (and, for WSL, by asking <c>wsl.exe</c> for its
/// distributions), so a machine without PowerShell 7, Git or WSL simply offers fewer entries rather
/// than offering a tab that fails to open. The result is cached briefly — the WSL probe spawns a
/// process, and the "+" menu is opened far more often than a distribution is installed.</para>
/// <para>Every launch goes out as a <b>verbatim</b> command line (see
/// <c>PtySpawnRequest.VerbatimArguments</c>): <c>wsl.exe</c> parses its own command line and treats a
/// quoted <c>"-d"</c> as a command to run rather than as its distribution flag, which is what
/// per-argument quoting produces.</para>
/// </remarks>
public static class ShellCatalog
{
    /// <summary>How long a detection result is reused before the machine is probed again.</summary>
    private static readonly TimeSpan CacheFor = TimeSpan.FromMinutes(2);

    /// <summary>How long <c>wsl.exe --list</c> gets before it is killed and treated as "no WSL".</summary>
    private const int ProbeTimeoutMs = 5000;

    private static readonly object Lock = new();
    private static IReadOnlyList<ShellOption>? _cached;
    private static DateTime _cachedAt;

    /// <summary>Every shell available on this machine, best first (the default is <see cref="DefaultId"/>).</summary>
    public static IReadOnlyList<ShellOption> Available(bool refresh = false)
    {
        lock (Lock)
        {
            if (!refresh && _cached is not null && DateTime.UtcNow - _cachedAt < CacheFor) return _cached;
        }
        // Probing spawns wsl.exe, so it happens OUTSIDE the lock: holding it across a slow (or
        // wedged) WSL would stall every other caller, and CreateAsync comes through here too — a
        // hung probe would then block opening a cmd tab as surely as a WSL one. Two callers racing
        // costs one duplicated probe, which is cheaper than that.
        var found = Detect();
        lock (Lock)
        {
            _cached = found;
            _cachedAt = DateTime.UtcNow;
            return found;
        }
    }

    /// <summary>
    /// The shell a new tab opens with when the browser has no preference yet: the newest PowerShell
    /// present, else whatever else was found. PowerShell over cmd because it is what a Windows
    /// developer's own terminal opens with, and cmd is always there as the floor.
    /// </summary>
    public static string DefaultId
    {
        get
        {
            var available = Available();
            // On Linux and macOS, the user's own login shell leads the list (see DetectUnix).
            string[] preferred = OperatingSystem.IsWindows()
                ? ["pwsh", "powershell", "cmd", "gitbash"]
                : [];
            foreach (var id in preferred)
                if (available.Any(o => o.Id == id)) return id;
            return available.Count > 0 ? available[0].Id : OperatingSystem.IsWindows() ? "cmd" : "sh";
        }
    }

    /// <summary>The option with this id, or null when it is unknown (or has since been uninstalled).</summary>
    public static ShellOption? Find(string? id) =>
        string.IsNullOrWhiteSpace(id) ? null : Available().FirstOrDefault(o => o.Id == id);

    /// <summary>
    /// What to spawn for <paramref name="option"/> in <paramref name="workingDirectory"/>. Throws when
    /// the shell's executable has gone missing since it was detected.
    /// </summary>
    public static ShellLaunch LaunchFor(ShellOption option, string workingDirectory)
    {
        var env = new Dictionary<string, string>();
        switch (option.Kind)
        {
            case "wsl":
            {
                // The distribution is the part of the id after "wsl:". `--cd` takes the WINDOWS path
                // and translates it (/mnt/c/…), so the tab opens where the session is working. The
                // flag order matters as much as the quoting: wsl.exe stops parsing at the first token
                // it doesn't recognise and hands everything after it to the distro as a command line.
                var distro = option.Id["wsl:".Length..];
                return new ShellLaunch(
                    WslPath ?? "wsl.exe",
                    new[] { "-d", Quote(distro), "--cd", Quote(workingDirectory) },
                    env);
            }
            case "bash":
                // Git for Windows' bin\bash.exe is the MSYS launcher: --login runs /etc/profile, which
                // is what puts the unix tools on PATH (on Linux and macOS, the profile is where a PATH the
                // daemon's unit never had comes from). CHERE_INVOKING keeps MSYS in the folder we start it
                // in rather than cd-ing to $HOME, which is the whole point of a per-folder tab; elsewhere
                // nothing reads it.
                env["CHERE_INVOKING"] = "1";
                env["TERM"] = "xterm-256color";
                // Shell integration (see PowerShellIntegration): bash takes both hooks from the
                // environment. PROMPT_COMMAND runs before each prompt with the last command's status
                // still in $?; PS0 is printed as a command starts. A profile that sets a
                // PROMPT_COMMAND of its own replaces this one, and the tab then goes without marks.
                env["PROMPT_COMMAND"] = """printf '\033]133;D;%s\007\033]133;A\007' "$?" """.TrimEnd();
                env["PS0"] = @"\e]133;C\a";
                return new ShellLaunch(option.Detail, new[] { "--login", "-i" }, env);
            case "pwsh":
            case "powershell":
                // -NoExit runs the integration once the profile has set its prompt up, and leaves the
                // shell interactive. Encoded rather than run from a file, so execution policy, which
                // governs script files, has nothing to say about it.
                // -Login (Unix only, and only as the first argument) reads the profile the way a login
                // shell does: under systemd or launchd, that is where PATH comes from.
                return new ShellLaunch(option.Detail,
                    OperatingSystem.IsWindows()
                        ? new[] { "-NoLogo", "-NoExit", "-EncodedCommand", EncodedPowerShellIntegration }
                        : new[] { "-Login", "-NoLogo", "-NoExit", "-EncodedCommand", EncodedPowerShellIntegration },
                    env);
            case "cmd":
                // cmd has no hook before a command runs, only its prompt: that gets the "prompt is up"
                // mark, and the pty host takes Enter at that prompt as the start of a command.
                env["PROMPT"] = @"$E]133;A$E\" +
                    (Environment.GetEnvironmentVariable("PROMPT") is { Length: > 0 } prompt ? prompt : "$P$G");
                return new ShellLaunch(option.Detail, Array.Empty<string>(), env);
            case "zsh":
            case "fish":
            case "sh":
                // Login shells, as macOS's Terminal opens them: the profile is what fills in a PATH
                // that a daemon started by systemd or launchd was never given.
                return new ShellLaunch(option.Detail, new[] { "-l" }, env);
            default:
                return new ShellLaunch(option.Detail, Array.Empty<string>(), env);
        }
    }

    // ---- SSH ------------------------------------------------------------------------------------

    /// <summary>The <see cref="ShellOption.Id"/> an SSH shell carries; it is never in <see cref="Available"/>.</summary>
    public const string SshId = "ssh";

    /// <summary>
    /// The ssh client to run: whatever is on PATH, else Windows' own OpenSSH, else the one Git ships.
    /// Null when the machine has none.
    /// </summary>
    public static string? SshPath => !OperatingSystem.IsWindows()
        ? FirstExisting(Which("ssh"), "/usr/bin/ssh", "/usr/local/bin/ssh", "/opt/homebrew/bin/ssh")
        : FirstExisting(
        Which("ssh.exe"),
        Path.Combine(System32, "OpenSSH", "ssh.exe"),
        Which("git.exe") is { } git && Path.GetDirectoryName(Path.GetDirectoryName(git)) is { } root
            ? Path.Combine(root, "usr", "bin", "ssh.exe")
            : null,
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "usr", "bin", "ssh.exe"));

    /// <summary>
    /// A connection's host, user and port as typed, with the shorthands anyone who uses ssh will type
    /// ("user@host" in the host field, "host:2222") pulled apart the way the remote files tab does.
    /// </summary>
    private static (string Host, string? User, int Port) SplitTarget(RemoteConnection c)
    {
        var host = c.Host.Trim();
        var user = string.IsNullOrWhiteSpace(c.User) ? null : c.User.Trim();
        var at = host.LastIndexOf('@');
        if (at > 0)
        {
            user ??= host[..at];
            host = host[(at + 1)..];
        }
        var port = c.Port;
        // Not a bare IPv6 literal, which is full of colons — only one in brackets can carry a port.
        var m = System.Text.RegularExpressions.Regex.Match(host, @"^(?:\[([^\]]+)\]|([^:\[\]]+)):(\d{1,5})$");
        if (m.Success)
        {
            host = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
            if (port <= 0) port = int.Parse(m.Groups[3].Value);
        }
        return (host.Trim('[', ']'), user, port);
    }

    /// <summary>Where a connection goes, for a tab's tooltip: "user@host:port", each part only when given.</summary>
    public static string SshTarget(RemoteConnection c)
    {
        var (host, user, port) = SplitTarget(c);
        // An IPv6 literal goes back in brackets, or its port reads as one more group of it.
        if (host.Contains(':')) host = $"[{host}]";
        return $"{(user is null ? "" : user + "@")}{host}{(port > 0 ? ":" + port : "")}";
    }

    /// <summary>
    /// The ssh command line for a connection. What is left blank is left to ssh, so the server
    /// user's <c>~/.ssh/config</c> fills it in exactly as it would in a terminal of their own.
    /// </summary>
    public static ShellLaunch LaunchSsh(string exe, RemoteConnection c)
    {
        var (host, user, port) = SplitTarget(c);
        var keyPath = c.Auth == "key" && !string.IsNullOrWhiteSpace(c.KeyPath) ? c.KeyPath.Trim() : null;
        // Whatever reaches ssh as an option is a way to run a command on this machine
        // (`-oProxyCommand=…`), so nothing typed here may become one. A leading dash is the obvious
        // way; the less obvious ones belong to Git's MSYS ssh, which splits its command line on
        // newlines too, takes ' as a quote and expands wildcards — so none of that is let through.
        if (host.Length == 0 || host.StartsWith('-') || host.Any(ch => char.IsWhiteSpace(ch) || char.IsControl(ch) || "'\"*?[]".Contains(ch)))
            throw new ArgumentException($"Not a host name: {c.Host}");
        if (user is not null && (user.StartsWith('-') || user.Any(ch => char.IsWhiteSpace(ch) || char.IsControl(ch) || "'\"*?[]".Contains(ch))))
            throw new ArgumentException($"Not a user name: {user}");
        if (keyPath is not null && keyPath.Any(char.IsControl))
            throw new ArgumentException($"Not a key file path: {keyPath}");
        if (port > 65535) throw new ArgumentException($"Port {port} is out of range.");

        var args = new List<string>();
        if (port > 0) args.AddRange(["-p", port.ToString()]);
        if (user is not null) args.AddRange(["-l", Quote(user)]);
        if (keyPath is not null) args.AddRange(["-i", Quote(keyPath)]);
        // The end of the options, so nothing from the host on can be read as one.
        args.Add("--");
        args.Add(Quote(host));
        return new ShellLaunch(exe, args, new Dictionary<string, string> { ["TERM"] = "xterm-256color" });
    }

    /// <summary>
    /// Shell integration for PowerShell, 5.1 and 7: the FinalTerm / VS Code OSC 133 marks the pty
    /// host follows to tell a running command from an idle prompt. <c>D;&lt;exit&gt;</c> and
    /// <c>A</c> go out before each prompt, <c>C</c> once a line has been accepted. The profile's own
    /// prompt is wrapped, not replaced, and gets the last command's <c>$?</c> and
    /// <c>$LASTEXITCODE</c> back as they were, so a prompt that shows a failure still sees one.
    /// </summary>
    internal const string PowerShellIntegration = """
        if (-not $global:__cwIntegration) {
            $global:__cwIntegration = $true
            $global:__cwPrompt = $function:prompt
            function global:prompt {
                $ok = $global:?
                $code = $global:LASTEXITCODE
                $exit = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }
                [Console]::Write("$([char]27)]133;D;$exit$([char]7)$([char]27)]133;A$([char]7)")
                $global:LASTEXITCODE = $code
                if (-not $ok) { Write-Error 'failed' -ErrorAction Ignore }
                & $global:__cwPrompt
            }
            if (Get-Command PSConsoleHostReadLine -ErrorAction Ignore) {
                $global:__cwReadLine = $function:PSConsoleHostReadLine
                function global:PSConsoleHostReadLine {
                    $line = & $global:__cwReadLine
                    [Console]::Write("$([char]27)]133;C$([char]7)")
                    $line
                }
            }
        }
        """;

    private static readonly string EncodedPowerShellIntegration =
        Convert.ToBase64String(Encoding.Unicode.GetBytes(PowerShellIntegration));

    /// <summary>
    /// Quote one token of a verbatim command line, the way a person typing it would: only when it
    /// holds a space, a tab or a quote of its own. Leaving the simple ones bare is not cosmetic —
    /// <c>wsl.exe</c> matches its flags against the raw text, and <c>"-d"</c> is not <c>-d</c>. Off
    /// Windows there is no command line, and the token comes back unchanged.
    /// </summary>
    public static string Quote(string arg)
    {
        // Off Windows there is no command line to quote for: each token reaches execvp() as one argv
        // entry, and quotes added here would arrive as part of the argument.
        if (!OperatingSystem.IsWindows()) return arg;
        if (arg.Length > 0 && arg.IndexOfAny([' ', '\t', '"']) < 0) return arg;
        // A run of backslashes before the closing quote would escape it, so double those (and only
        // those) — the CommandLineToArgvW rule.
        var sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"') { sb.Append('\\', backslashes * 2 + 1).Append('"'); }
            else { sb.Append('\\', backslashes).Append(c); }
            backslashes = 0;
        }
        return sb.Append('\\', backslashes * 2).Append('"').ToString();
    }

    // ---- Detection ------------------------------------------------------------------------------

    private static string System32 => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.Windows), "System32");

    private static string? WslPath
    {
        get
        {
            var p = Path.Combine(System32, "wsl.exe");
            return File.Exists(p) ? p : null;
        }
    }

    private static IReadOnlyList<ShellOption> Detect()
    {
        if (!OperatingSystem.IsWindows()) return DetectUnix();

        var found = new List<ShellOption>();

        // PowerShell 7+ first: it is the one a Windows developer actually lives in, and it is the
        // default a new tab picks (see DefaultId).
        if (FirstExisting(
                Which("pwsh.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PowerShell", "7", "pwsh.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "PowerShell", "6", "pwsh.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "WindowsApps", "pwsh.exe"))
            is { } pwsh)
            found.Add(new ShellOption("pwsh", "PowerShell", "pwsh", pwsh));

        if (FirstExisting(Path.Combine(System32, "WindowsPowerShell", "v1.0", "powershell.exe")) is { } winps)
            found.Add(new ShellOption("powershell", "Windows PowerShell", "powershell", winps));

        if (FirstExisting(Environment.GetEnvironmentVariable("ComSpec"), Path.Combine(System32, "cmd.exe")) is { } cmd)
            found.Add(new ShellOption("cmd", "Command Prompt", "cmd", cmd));

        if (GitBash() is { } bash)
            found.Add(new ShellOption("gitbash", "Git Bash", "bash", bash));

        foreach (var distro in WslDistributions())
            found.Add(new ShellOption($"wsl:{distro}", $"{distro} (WSL)", "wsl", distro));

        return found;
    }

    /// <summary>The shells a Linux or macOS machine offers, its user's login shell first.</summary>
    private static readonly (string Id, string Label)[] UnixShells =
    [
        ("bash", "Bash"), ("zsh", "Zsh"), ("fish", "Fish"), ("pwsh", "PowerShell"), ("sh", "sh"),
    ];

    private static IReadOnlyList<ShellOption> DetectUnix()
    {
        var found = new List<ShellOption>();
        foreach (var (id, label) in UnixShells)
        {
            if (FirstExisting(Which(id), $"/bin/{id}", $"/usr/bin/{id}", $"/usr/local/bin/{id}", $"/opt/homebrew/bin/{id}") is { } path)
                // The id doubles as the kind: LaunchFor's "bash" and "pwsh" cases carry the shell
                // integration, and the rest open plain.
                found.Add(new ShellOption(id, label, id, path));
        }

        // A daemon under systemd or launchd may have no SHELL at all; the passwd entry still names it.
        var login = Path.GetFileName(Environment.GetEnvironmentVariable("SHELL") is { Length: > 0 } shell ? shell
            : PasswdShell() ?? (OperatingSystem.IsMacOS() ? "zsh" : ""));
        var mine = found.FindIndex(o => o.Id == login);
        if (mine > 0)
        {
            var option = found[mine];
            found.RemoveAt(mine);
            found.Insert(0, option);
        }
        return found;
    }

    /// <summary>This user's shell from <c>/etc/passwd</c> (Linux; macOS keeps users in Directory Services).</summary>
    private static string? PasswdShell()
    {
        try
        {
            var prefix = Environment.UserName + ":";
            var line = File.ReadLines("/etc/passwd").FirstOrDefault(l => l.StartsWith(prefix, StringComparison.Ordinal));
            return line?.Split(':') is { Length: >= 7 } fields ? fields[6] : null;
        }
        catch { return null; }
    }

    /// <summary>Git for Windows' bash launcher, wherever Git was installed.</summary>
    private static string? GitBash()
    {
        // An installed git.exe pins the install root: it sits in <root>\cmd or <root>\bin, and the
        // launcher we want is always <root>\bin\bash.exe.
        if (Which("git.exe") is { } git)
        {
            var root = Path.GetDirectoryName(Path.GetDirectoryName(git));
            if (root is not null && FirstExisting(Path.Combine(root, "bin", "bash.exe")) is { } fromGit)
                return fromGit;
        }
        return FirstExisting(
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Git", "bin", "bash.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Git", "bin", "bash.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Git", "bin", "bash.exe"));
    }

    /// <summary>
    /// The installed WSL distributions, or nothing when WSL isn't set up. Best-effort throughout: a
    /// machine with the wsl.exe stub but no distribution installed answers with an error, and a shell
    /// menu is not worth failing a request over.
    /// </summary>
    private static IReadOnlyList<string> WslDistributions()
    {
        if (WslPath is not { } wsl) return Array.Empty<string>();
        try
        {
            var psi = new ProcessStartInfo(wsl, "--list --quiet")
            {
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                // wsl.exe writes UTF-16LE, not the console code page — decoded as UTF-8 every name
                // comes back interleaved with NULs ("U b u n t u").
                StandardOutputEncoding = Encoding.Unicode,
            };
            using var p = Process.Start(psi);
            if (p is null) return Array.Empty<string>();
            // Read both pipes asynchronously and wait on the PROCESS, never on a read. A blocking
            // ReadToEnd() returns only when the pipe closes, so a wedged wsl.exe (a stuck
            // LxssManager, a VM mid-start — the ordinary WSL failure) would hang here forever and
            // the timeout below would never be reached. Draining stderr matters for its own reason:
            // an undrained pipe that fills stops the child dead.
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(ProbeTimeoutMs))
            {
                try { p.Kill(entireProcessTree: true); } catch { }
                return Array.Empty<string>();
            }
            // The timed overload can return before the readers have drained; the wait below covers
            // that, and a grandchild still holding the pipe open costs us the answer, not the thread.
            if (!Task.WhenAll(stdout, stderr).Wait(1000) || !stdout.IsCompletedSuccessfully)
                return Array.Empty<string>();
            if (p.ExitCode != 0) return Array.Empty<string>();

            return stdout.Result
                .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(l => l.Trim('\r', '\0', '﻿').Trim())
                .Where(l => l.Length > 0)
                // Docker Desktop's utility distributions are plumbing, not shells anyone opens a tab in.
                .Where(l => !l.StartsWith("docker-desktop", StringComparison.OrdinalIgnoreCase))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToArray();
        }
        catch { return Array.Empty<string>(); }
    }

    private static string? FirstExisting(params string?[] candidates) =>
        candidates.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c) && File.Exists(c));

    /// <summary>The first <paramref name="exe"/> on PATH, the way the shell would resolve it.</summary>
    private static string? Which(string exe)
    {
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "")
                     .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            try
            {
                var full = Path.Combine(dir.Trim().Trim('"'), exe);
                if (File.Exists(full)) return full;
            }
            catch { /* a malformed PATH entry is not our problem */ }
        }
        return null;
    }
}
