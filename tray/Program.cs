using System.Diagnostics;
using System.Text.Json;

namespace ClaudeWeb.Tray;

/// <summary>
/// The Windows tray icon for a Claude Web daemon. It is only a client: everything it shows comes from the
/// daemon's HTTP API and its <c>/hub/events</c> stream, and closing it leaves the daemon — and every
/// session — running. <see cref="DaemonConnection"/> is how it finds the daemon.
/// </summary>
internal static class Program
{
    private const int DefaultPort = 5099;

    [STAThread]
    private static void Main(string[] args)
    {
        TrayLog.Install();
        var port = ResolvePort(args);

        // One tray per daemon port. A second launch just opens the UI, when there is a daemon to open.
        using var mutex = new Mutex(true, $"ClaudeWeb.Tray.SingleInstance.v1.{port}", out var isNew);
        if (!isNew)
        {
            if (DaemonInstance.Read(port) is { } running && running.ProcessAlive()) Browser.Open(running.OpenUrl);
            return;
        }

        TrayLog.Info($"Tray started for port {port}.");
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // A UI-thread exception is logged and the icon stays up, rather than the default error dialog.
        Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
        Application.ThreadException += (_, e) => TrayLog.Error("UI thread exception (kept alive)", e.Exception);

        using var daemon = new DaemonConnection(port);
        using var tray = new TrayApplicationContext(daemon);
        daemon.Start(); // after the tray has subscribed, so it hears the very first view
        Application.Run(tray);
    }

    /// <summary>
    /// The daemon port to follow: <c>--port N</c>, else <c>Server:Urls</c> as the daemon reads it — the
    /// <c>Server__Urls</c> environment variable over the <c>appsettings.json</c> beside this exe, since an
    /// install puts the tray and the daemon in one folder with one config — else 5099.
    /// </summary>
    private static int ResolvePort(string[] args)
    {
        var i = Array.FindIndex(args, a => a.Equals("--port", StringComparison.OrdinalIgnoreCase));
        if (i >= 0 && i + 1 < args.Length && int.TryParse(args[i + 1], out var fromArgs)) return fromArgs;
        return PortFromUrls(Environment.GetEnvironmentVariable("Server__Urls") ?? ConfiguredUrls()) ?? DefaultPort;
    }

    private static string? ConfiguredUrls()
    {
        try
        {
            var path = Path.Combine(AppContext.BaseDirectory, "appsettings.json");
            if (!File.Exists(path)) return null;
            using var doc = JsonDocument.Parse(File.ReadAllText(path),
                new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            return doc.RootElement.TryGetProperty("Server", out var server)
                && server.TryGetProperty("Urls", out var urls)
                && urls.ValueKind == JsonValueKind.String
                ? urls.GetString()
                : null;
        }
        catch { return null; }
    }

    /// <summary>The port from the first entry of a Kestrel bind list ("http://0.0.0.0:5099;...").</summary>
    private static int? PortFromUrls(string? urls)
    {
        if (string.IsNullOrWhiteSpace(urls)) return null;
        try
        {
            var first = urls.Split(';', StringSplitOptions.RemoveEmptyEntries)[0].Trim();
            return new Uri(first.Replace("0.0.0.0", "localhost").Replace("+", "localhost").Replace("*", "localhost")).Port;
        }
        catch { return null; }
    }
}

internal static class Browser
{
    public static void Open(string url)
    {
        // A web address or nothing: the URL comes from config by way of a file on disk, and shell-executing
        // anything else — a path, a share — would run it.
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            TrayLog.Info($"Not opening '{url}': not an http(s) address.");
            return;
        }
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true })?.Dispose(); }
        catch (Exception ex) { TrayLog.Error($"Could not open {url}", ex); }
    }
}
