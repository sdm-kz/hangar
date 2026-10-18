namespace Hangar.Server.Logging;

/// <summary>
/// Process-wide last line of defence. On Windows the daemon is a <c>WinExe</c> with no console, so an
/// exception that escapes normal flow — a background-thread fault (<see cref="AppDomain"/>) or a stray
/// unobserved <see cref="Task"/> fault — otherwise terminates the process silently, leaving nothing in
/// the Windows event log for this app. These handlers write every such fault to <c>crash.log</c> (and
/// swallow it where the runtime allows the app to keep running). The web request pipeline already logs
/// its own exceptions via <c>ILogger</c>; this covers everything outside it.
/// </summary>
public static class CrashHandler
{
    private static string _crashLog = "";
    private static readonly object _gate = new();
    private static ILogger? _log;

    /// <summary>Path of the crash log, once <see cref="Install"/> has run (for surfacing in diagnostics).</summary>
    public static string CrashLogPath => _crashLog;

    /// <summary>Wire the runtime-wide handlers. Call as early as possible in Main, before any work.</summary>
    public static void Install(string logDir)
    {
        try { Directory.CreateDirectory(logDir); } catch { /* logged below is best-effort anyway */ }
        _crashLog = Path.Combine(logDir, "crash.log");

        // A background/threadpool thread threw and nobody caught it. The CLR will still terminate the
        // process (this notification can't prevent that), but at least we record what happened.
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
            Write("AppDomain.UnhandledException", $"terminating={e.IsTerminating}", e.ExceptionObject as Exception);

        // A faulted Task whose exception was never observed. Record it and mark it observed so a stray
        // fault can never escalate into a process-level problem.
        TaskScheduler.UnobservedTaskException += (_, e) =>
        {
            Write("TaskScheduler.UnobservedTaskException", "observed + suppressed", e.Exception);
            e.SetObserved();
        };
    }

    /// <summary>Once the host is up, mirror crash entries into the main ILogger trail as well.</summary>
    public static void AttachLogger(ILogger log) => _log = log;

    /// <summary>Record an unexpected fault ourselves (e.g. from a catch that must not rethrow).</summary>
    public static void Record(string source, string note, Exception? ex) => Write(source, note, ex);

    private static void Write(string source, string note, Exception? ex)
    {
        var stamp = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss.fff");
        var text = $"{stamp} [FATAL] {source} — {note}\n{ex?.ToString() ?? "(no exception object)"}\n\n";
        lock (_gate)
        {
            try { File.AppendAllText(_crashLog, text); } catch { /* best effort */ }
        }
        try { _log?.LogCritical(ex, "{Source} — {Note}", source, note); } catch { /* never throw from here */ }
    }
}
