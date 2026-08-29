using System.Text.Json;

namespace ClaudeWeb.Pty;

/// <summary>
/// The on-disk marker a pty host writes for its session: enough to find the host again after the web
/// app restarts, and enough to tell a live host from a stale file. Written once the child is up,
/// stamped with an exit code when the child ends, and deleted when the host exits cleanly.
/// </summary>
/// <remarks>
/// This is <b>not</b> a second source of truth for session metadata — <c>sessions.json</c> stays
/// that. All this answers is "is that session still alive, and where do I reach it?".
/// </remarks>
public sealed record PtyState(
    string SessionId,
    int HostPid,
    /// <summary>The host's start time. PIDs are recycled, so a match only counts with this too.</summary>
    long HostStartTicks,
    string PipeName,
    int ChildPid,
    /// <summary>The child's start time; same PID-reuse guard, for the process the UI reports.</summary>
    long ChildStartTicks,
    string WorkingDirectory,
    int Protocol,
    DateTimeOffset CreatedAt,
    /// <summary>Set when the child ended, so a client that connects late can still report how.</summary>
    int? ExitCode = null,
    /// <summary>Which build published the host binary this session is running (for pruning copies).</summary>
    string? BuildStamp = null);

/// <summary>Locating, reading and writing <see cref="PtyState"/> files.</summary>
public static class PtyStateStore
{
    /// <summary>
    /// Where a given instance's state files live:
    /// <c>%LocalAppData%\ClaudeWeb\pty\&lt;instanceKey&gt;</c>. The instance key is load-bearing —
    /// <c>%LocalAppData%\ClaudeWeb</c> is shared by every instance on the machine, so without it a dev
    /// instance would adopt (and could then stop) the live app's sessions.
    /// </summary>
    public static string Directory(string instanceKey) => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "ClaudeWeb", "pty", Sanitize(instanceKey));

    /// <summary>The state file for one session.</summary>
    public static string PathFor(string instanceKey, string sessionId) =>
        Path.Combine(Directory(instanceKey), Sanitize(sessionId) + ".json");

    /// <summary>
    /// The pipe a session's host listens on. Namespaced by instance for the same reason the state
    /// directory is.
    /// </summary>
    public static string PipeName(string instanceKey, string sessionId) =>
        $"claudeweb-pty-{Sanitize(instanceKey)}-{Sanitize(sessionId)}";

    /// <summary>Write (or overwrite) a state file, creating its directory.</summary>
    public static void Write(string path, PtyState state)
    {
        System.IO.Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        // Write-then-rename so a reader never sees a half-written file.
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(state, PtyJsonFileContext.Default.PtyState));
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>Read a state file; null when it's missing or unreadable.</summary>
    public static PtyState? Read(string path)
    {
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize(File.ReadAllText(path), PtyJsonFileContext.Default.PtyState) : null;
        }
        catch { return null; }
    }

    /// <summary>Every state file for an instance, with the path each was read from.</summary>
    public static IEnumerable<(string Path, PtyState State)> ReadAll(string instanceKey)
    {
        var dir = Directory(instanceKey);
        if (!System.IO.Directory.Exists(dir)) yield break;
        foreach (var path in System.IO.Directory.EnumerateFiles(dir, "*.json"))
        {
            var state = Read(path);
            if (state is not null) yield return (path, state);
        }
    }

    /// <summary>
    /// Every state file on the machine, across <b>all</b> instances. Used when a decision has to
    /// account for hosts this instance doesn't own — pruning the shared per-build copies of the host
    /// binary, where deleting a folder another instance is running from would be destructive.
    /// </summary>
    public static IEnumerable<(string Path, PtyState State)> ReadAllInstances()
    {
        var root = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWeb", "pty");
        if (!System.IO.Directory.Exists(root)) yield break;
        foreach (var dir in System.IO.Directory.EnumerateDirectories(root))
        {
            IEnumerable<string> files;
            try { files = System.IO.Directory.EnumerateFiles(dir, "*.json"); }
            catch { continue; } // another instance may be mid-write, or the folder may be locked down
            foreach (var path in files)
            {
                var state = Read(path);
                if (state is not null) yield return (path, state);
            }
        }
    }

    /// <summary>Best-effort delete; a state file we can't remove is only noise on the next scan.</summary>
    public static void Delete(string path)
    {
        try { File.Delete(path); } catch { }
    }

    /// <summary>
    /// Whether the host process a state file names is still the one that wrote it. The start-time
    /// check is what makes this safe: PIDs are recycled, heavily so after a reboot.
    /// </summary>
    public static bool HostAlive(PtyState state)
    {
        if (state.HostPid <= 0) return false;
        try
        {
            using var p = System.Diagnostics.Process.GetProcessById(state.HostPid);
            return !p.HasExited
                && (state.HostStartTicks == 0 || p.StartTime.ToUniversalTime().Ticks == state.HostStartTicks);
        }
        catch { return false; } // no such process, or we can't inspect it — treat as gone
    }

    /// <summary>Keep a key usable as both a file name and a pipe name.</summary>
    private static string Sanitize(string s)
    {
        var clean = new string(s.Select(c => char.IsLetterOrDigit(c) || c is '-' or '_' ? c : '-').ToArray());
        return clean.Length == 0 ? "default" : clean;
    }
}
