using System.Diagnostics;
using System.Text;

namespace ClaudeWeb.Server.Sessions.Shells;

/// <summary>One shell the host machine can run, as offered in the "+" menu of a session's tab bar.</summary>
/// <remarks>
/// <see cref="Id"/> is the stable handle the browser sends back to open a tab; <see cref="Kind"/> is
/// the family, which is all the UI needs to pick an icon (several WSL distributions share one).
/// </remarks>
public sealed record ShellOption(
    /// <summary>Stable id: "cmd" | "powershell" | "pwsh" | "gitbash" | "wsl:&lt;distro&gt;".</summary>
    string Id,
    /// <summary>What the menu shows, e.g. "PowerShell 7" or "Ubuntu-24.04 (WSL)".</summary>
    string Label,
    /// <summary>Family, for the icon: "cmd" | "powershell" | "pwsh" | "bash" | "wsl".</summary>
    string Kind,
    /// <summary>Where it was found (an exe path, or the distribution name) — shown as a tooltip.</summary>
    string Detail);

/// <summary>How to actually launch a shell: what to spawn in the pseudoconsole, and with what.</summary>
/// <param name="Arguments">
/// Already-quoted tokens: they are joined with spaces into a verbatim command line rather than being
/// quoted again per-argument. See <see cref="ShellCatalog.Quote"/>.
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
            foreach (var id in new[] { "pwsh", "powershell", "cmd", "gitbash" })
                if (available.Any(o => o.Id == id)) return id;
            return available.Count > 0 ? available[0].Id : "cmd";
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
                // is what puts the unix tools on PATH. CHERE_INVOKING keeps it in the folder we start
                // it in rather than cd-ing to $HOME, which is the whole point of a per-folder tab.
                env["CHERE_INVOKING"] = "1";
                env["TERM"] = "xterm-256color";
                return new ShellLaunch(option.Detail, new[] { "--login", "-i" }, env);
            case "pwsh":
            case "powershell":
                return new ShellLaunch(option.Detail, new[] { "-NoLogo" }, env);
            default:
                return new ShellLaunch(option.Detail, Array.Empty<string>(), env);
        }
    }

    /// <summary>
    /// Quote one token of a verbatim command line, the way a person typing it would: only when it
    /// holds a space, a tab or a quote of its own. Leaving the simple ones bare is not cosmetic —
    /// <c>wsl.exe</c> matches its flags against the raw text, and <c>"-d"</c> is not <c>-d</c>.
    /// </summary>
    public static string Quote(string arg)
    {
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
