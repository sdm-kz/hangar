using System.Diagnostics;
using Hangar.Server.Sessions;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace Hangar.Server.Diagnostics;

/// <summary>One file the daemon depends on, as this process sees it.</summary>
public sealed record FileProbe(string Path, bool Exists, bool Readable);

/// <summary>
/// Who the daemon is running as, and whether what a session needs is where that identity looks for it.
///
/// <para>The daemon never performs a login; it inherits one. <c>claude</c>'s credentials, its settings and
/// its trust list live under the user profile, and so does every store this app keeps. Start the daemon as
/// the wrong identity — a service account, another profile, a context that never sourced the user's PATH —
/// and nothing fails loudly: sessions just come up unauthenticated, against an empty parallel copy of the
/// app's state. This turns that into one line in the log at startup, and <c>GET /api/health/environment</c>,
/// instead of a debugging session.</para>
/// </summary>
public sealed record EnvironmentReport(
    string User,
    bool IsService,
    /// <summary>The Windows logon session (0 is the services session, which can't show a browser); null elsewhere.</summary>
    int? WindowsSession,
    string ClaudeConfigured,
    /// <summary>What a launch would actually run (program plus any prefix), or null when nothing was found.</summary>
    string? ClaudeResolved,
    string? Git,
    string LocalAppData,
    string UserProfile,
    FileProbe ClaudeSettings,
    FileProbe ClaudeState,
    FileProbe ClaudeCredentials,
    string? ClaudeConfigDir,
    string? XdgRuntimeDir,
    IReadOnlyList<string> Problems)
{
    public static EnvironmentReport Collect(string claudeExecutable)
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var isService = OperatingSystem.IsWindows() && WindowsServiceHelpers.IsWindowsService();
        int? windowsSession = null;
        if (OperatingSystem.IsWindows())
            using (var me = Process.GetCurrentProcess()) windowsSession = me.SessionId;

        var spec = ClaudeExecutableResolver.Resolve(claudeExecutable);
        var claudeProgram = FindExecutable(spec.FileName);
        var claude = claudeProgram is null ? null : string.Join(' ', [claudeProgram, .. spec.Prefix]);
        var git = FindExecutable("git");

        var claudeDir = Path.Combine(profile, ".claude");
        var settings = Probe(Path.Combine(claudeDir, "settings.json"));
        var state = Probe(Path.Combine(profile, ".claude.json"));
        // macOS keeps claude's credentials in the login keychain rather than in this file.
        var credentials = Probe(Path.Combine(claudeDir, ".credentials.json"));
        var configDir = NullIfEmpty(Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR"));
        var xdgRuntimeDir = OperatingSystem.IsWindows() ? null : NullIfEmpty(Environment.GetEnvironmentVariable("XDG_RUNTIME_DIR"));

        var problems = new List<string>();
        if (claude is null)
            problems.Add($"'{claudeExecutable}' was not found on this process's PATH, so no session can launch. " +
                         "Pin Sessions:ClaudeExecutable to an absolute path.");
        if (git is null)
            problems.Add("git was not found on PATH; git status, diffs and history will be empty.");
        if (!state.Exists)
            problems.Add($"{state.Path} does not exist: claude has never run as this user, or the daemon is running as a different one.");
        if (!OperatingSystem.IsMacOS() && !credentials.Exists)
            problems.Add($"No claude credentials at {credentials.Path}: unless claude authenticates another way (an API key), " +
                         "sessions will ask to log in. Run `claude` once, interactively, as this user.");
        if (credentials is { Exists: true, Readable: false })
            problems.Add($"{credentials.Path} exists but this process can't read it.");
        if (windowsSession == 0)
            problems.Add("Running in session 0 (a Windows service): claude can't open a browser for a first-run login, " +
                         "and mapped drives aren't visible. Autostart at logon avoids both.");
        if (configDir is not null)
            problems.Add($"CLAUDE_CONFIG_DIR is set ({configDir}): claude reads its settings and credentials from there, " +
                         $"but Hangar registers its hooks in {settings.Path}.");
        if (OperatingSystem.IsLinux() && xdgRuntimeDir is null)
            problems.Add("XDG_RUNTIME_DIR is not set: the daemon isn't running in a user session. Run it as a systemd --user unit.");

        return new EnvironmentReport(
            OperatingSystem.IsWindows() ? $@"{Environment.UserDomainName}\{Environment.UserName}" : Environment.UserName,
            isService, windowsSession, claudeExecutable, claude, git, localAppData, profile,
            settings, state, credentials, configDir, xdgRuntimeDir, problems);
    }

    /// <summary>The report as one log line — the part to read first when a session won't start.</summary>
    public string Summary()
    {
        static string Mark(FileProbe f) => f switch { { Readable: true } => "ok", { Exists: true } => "unreadable", _ => "missing" };
        var parts = new List<string>
        {
            $"user={User}",
            $"service={(IsService ? "yes" : "no")}",
        };
        if (WindowsSession is { } s) parts.Add($"session={s}");
        parts.Add($"claude={ClaudeResolved ?? "NOT FOUND"}");
        parts.Add($"git={Git ?? "not found"}");
        parts.Add($"profile={UserProfile}");
        parts.Add($"localAppData={LocalAppData}");
        parts.Add($"settings.json={Mark(ClaudeSettings)}");
        parts.Add($".claude.json={Mark(ClaudeState)}");
        parts.Add($"credentials={(OperatingSystem.IsMacOS() && !ClaudeCredentials.Exists ? "keychain" : Mark(ClaudeCredentials))}");
        if (!OperatingSystem.IsWindows()) parts.Add($"XDG_RUNTIME_DIR={XdgRuntimeDir ?? "unset"}");
        return string.Join("  ", parts);
    }

    private static FileProbe Probe(string path)
    {
        if (!File.Exists(path)) return new FileProbe(path, false, false);
        try
        {
            // Share everything: claude may be rewriting the file this very moment, and that isn't "unreadable".
            using var _ = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            return new FileProbe(path, true, true);
        }
        catch { return new FileProbe(path, true, false); }
    }

    /// <summary>Whether a session could launch here: <c>claude</c> is where a launch would look for it.</summary>
    public static bool ClaudeFound(string claudeExecutable) =>
        FindExecutable(ClaudeExecutableResolver.Resolve(claudeExecutable).FileName) is not null;

    /// <summary>A rooted path that exists, or a bare name found on PATH the way a shell would look for it.</summary>
    private static string? FindExecutable(string name)
    {
        if (Path.IsPathRooted(name)) return File.Exists(name) ? name : null;
        string[] extensions = OperatingSystem.IsWindows() && !Path.HasExtension(name) ? [".exe", ".cmd", ".bat"] : [""];
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            foreach (var ext in extensions)
            {
                try
                {
                    var full = Path.Combine(dir.Trim().Trim('"'), name + ext);
                    if (File.Exists(full)) return full;
                }
                catch { /* a malformed PATH entry */ }
            }
        return null;
    }

    private static string? NullIfEmpty(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;
}
