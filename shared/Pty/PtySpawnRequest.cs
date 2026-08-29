using System.Text.Json;

namespace ClaudeWeb.Pty;

/// <summary>
/// Everything the web app hands a freshly launched host. Passed as a JSON file rather than a command
/// line: it carries the session's environment (including the hook token) and the user's initial
/// prompt, neither of which belongs in a command line other processes can read.
/// </summary>
public sealed record PtySpawnRequest(
    string SessionId,
    string PipeName,
    /// <summary>Where the host writes its <see cref="PtyState"/>.</summary>
    string StateFile,
    string LogFile,
    /// <summary>The program to attach to the pseudoconsole (cmd.exe for the npm shim).</summary>
    string FileName,
    IReadOnlyList<string> Arguments,
    string WorkingDirectory,
    int Cols,
    int Rows,
    /// <summary>The child's full environment block; the host does not inherit its own.</summary>
    IReadOnlyDictionary<string, string> Environment,
    string? BuildStamp = null,
    /// <summary>
    /// Watchdog tunables, since the watchdog runs host-side. Null falls back to the defaults, which
    /// keeps an older web app able to spawn a newer host.
    /// </summary>
    WatchdogOptions? Watchdog = null,
    /// <summary>
    /// Whether the watchdog may auto-continue THIS session. The per-session opt-in, as opposed to the
    /// machine-wide <see cref="WatchdogOptions.Enabled"/> master switch; re-sent over the pipe
    /// whenever the user toggles it, and again on every re-attach so sessions.json stays authoritative.
    /// </summary>
    bool WatchdogEnabled = false);

/// <summary>Reading and writing <see cref="PtySpawnRequest"/> files.</summary>
public static class PtySpawnRequestStore
{
    public static void Write(string path, PtySpawnRequest request)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, JsonSerializer.Serialize(request, PtyJsonFileContext.Default.PtySpawnRequest));
    }

    public static PtySpawnRequest? Read(string path)
    {
        try { return JsonSerializer.Deserialize(File.ReadAllText(path), PtyJsonFileContext.Default.PtySpawnRequest); }
        catch { return null; }
    }
}
