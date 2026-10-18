namespace Hangar.PtyHost;

/// <summary>
/// A one-file log for a host process. Deliberately not <c>ILogger</c>: the host's only package
/// reference is Porta.Pty, and nobody is watching its (nonexistent) console — when a detached session
/// misbehaves, this file is the whole diagnostic trail.
/// </summary>
public static class HostLog
{
    private static readonly object Gate = new();
    private static string? _path;

    /// <summary>Point the log at a file. Failures are swallowed — logging must never sink the host.</summary>
    public static void Open(string path)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            // A session can run for days; start each host's log fresh rather than growing one forever.
            if (File.Exists(path) && new FileInfo(path).Length > 4 * 1024 * 1024)
                File.Delete(path);
            _path = path;
        }
        catch { _path = null; }
    }

    public static void Info(string message) => Write("INF", message);
    public static void Debug(string message) => Write("DBG", message);
    public static void Warn(string message) => Write("WRN", message);

    public static void Error(string message, Exception? ex = null) =>
        Write("ERR", ex is null ? message : $"{message}: {ex}");

    private static void Write(string level, string message)
    {
        var path = _path;
        if (path is null) return;
        try
        {
            lock (Gate)
                File.AppendAllText(path, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {level} {message}{System.Environment.NewLine}");
        }
        catch { /* the log is best-effort; never let it throw into the caller */ }
    }
}
