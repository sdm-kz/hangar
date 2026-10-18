namespace Hangar.Tray;

/// <summary>
/// The tray's diagnostic trail, <c>%LocalAppData%\ClaudeWeb\logs\tray.log</c>: beside the daemon's own logs,
/// and deliberately a separate file, since the two are separate processes that come and go on their own. A
/// WinExe has no console, so without this an unhandled fault would end the process without a trace.
/// </summary>
internal static class TrayLog
{
    private const long MaxBytes = 2 * 1024 * 1024; // roll at 2 MB, keeping one previous generation

    private static readonly object Gate = new();
    private static readonly string LogPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWeb", "logs", "tray.log");

    /// <summary>Record faults that escape everything else. Call first thing in Main.</summary>
    public static void Install()
    {
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Error($"Unhandled exception (terminating={e.IsTerminating})", e.ExceptionObject as Exception);
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Error("Unobserved task exception", e.Exception);
            e.SetObserved();
        };
    }

    public static void Info(string message) => Write("Information", message, null);

    public static void Error(string message, Exception? ex) => Write("Error", message, ex);

    private static void Write(string level, string message, Exception? ex)
    {
        var text = $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} [{level}] {message}{(ex is null ? "" : "\n" + ex)}\n";
        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                if (new FileInfo(LogPath) is { Exists: true, Length: > MaxBytes })
                    File.Move(LogPath, LogPath + ".1", overwrite: true);
                File.AppendAllText(LogPath, text);
            }
            catch { /* best effort */ }
        }
    }
}
