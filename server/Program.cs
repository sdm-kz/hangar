using System.Diagnostics;
using System.Windows.Forms;
using ClaudeWeb.Server.Auth;
using ClaudeWeb.Server.FileSystem;
using ClaudeWeb.Server.Logging;
using ClaudeWeb.Server.Sessions;
using ClaudeWeb.Server.Tray;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace ClaudeWeb.Server;

internal static class Program
{
    [STAThread]
    private static void Main(string[] args)
    {
        // Install the runtime-wide crash handlers before anything else runs, so any fault during
        // startup (or later, on a background thread) is written to crash.log instead of vanishing.
        CrashHandler.Install(LogDirectory());

        var isService = WindowsServiceHelpers.IsWindowsService();
        var contentRoot = ResolveContentRoot();
        var port = GetPort(contentRoot);

        // Single-instance for the interactive tray: a second launch just opens the UI and exits.
        Mutex? mutex = null;
        if (!isService)
        {
            // Port-specific so a debug instance on another port can coexist with the live app.
            mutex = new Mutex(true, $"ClaudeWeb.SingleInstance.v1.{port}", out var isNew);
            if (!isNew)
            {
                OpenBrowser($"http://localhost:{port}");
                return;
            }
        }

        var app = BuildApp(args, contentRoot);

        if (isService)
        {
            app.Run(); // headless: block on the web host
            return;
        }

        // Interactive: start the host, then run the tray message loop on this STA thread.
        app.Start();
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
        CrashHandler.AttachLogger(app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Crash"));
        log.LogInformation("ClaudeWeb started on port {Port}. Logs: {LogDir} (crash log: {CrashLog}).",
            port, LogDirectory(), CrashHandler.CrashLogPath);
        Application.SetHighDpiMode(HighDpiMode.SystemAware);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        // Route UI-thread exceptions to the crash log and keep the tray alive rather than terminating.
        CrashHandler.InstallWinForms();
        using (var tray = new TrayApplicationContext(app, $"http://localhost:{port}"))
            Application.Run(tray);

        try { app.StopAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult(); } catch { }
        mutex?.Dispose();
    }

    private static WebApplication BuildApp(string[] args, string contentRoot)
    {
        var builder = WebApplication.CreateBuilder(new WebApplicationOptions
        {
            Args = args,
            ContentRootPath = contentRoot,
        });

        // Run as a Windows service when hosted by the SCM; a no-op when launched interactively.
        builder.Host.UseWindowsService(o => o.ServiceName = "ClaudeWeb");

        // A faulting hosted service (e.g. the watchdog) must NOT tear the whole host down — the
        // default is StopHost, which would take the app with it. Isolate it so one loop dying can't
        // exit the process; the fault is logged instead (and the crash handlers capture the detail).
        builder.Services.Configure<HostOptions>(o =>
            o.BackgroundServiceExceptionBehavior = BackgroundServiceExceptionBehavior.Ignore);

        // No console in the WinExe build — keep a diagnostic trail on disk.
        var logDir = LogDirectory();
        builder.Logging.AddProvider(new FileLoggerProvider(Path.Combine(logDir, "claudeweb.log")));

        var urls = builder.Configuration["Server:Urls"] ?? "http://0.0.0.0:5099";
        builder.WebHost.UseUrls(urls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        var authOptions = builder.Configuration.GetSection("Auth").Get<AuthOptions>() ?? new AuthOptions();
        var sessionOptions = builder.Configuration.GetSection("Sessions").Get<SessionManagerOptions>() ?? new SessionManagerOptions();
        var watchdogOptions = builder.Configuration.GetSection("Watchdog").Get<WatchdogOptions>() ?? new WatchdogOptions();

        builder.Services.AddSingleton(authOptions);
        builder.Services.AddSingleton<TokenStore>();
        builder.Services.AddSingleton(sessionOptions);
        builder.Services.AddSingleton<SessionManager>();
        builder.Services.AddSingleton(watchdogOptions);
        builder.Services.AddHostedService<WatchdogService>();
        builder.Services.AddSingleton<RecentsStore>();
        builder.Services.ConfigureHttpJsonOptions(o =>
            o.SerializerOptions.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter()));

        var app = builder.Build();
        app.UseWebSockets();
        app.UseMiddleware<TokenAuthMiddleware>();
        MapEndpoints(app);
        app.UseDefaultFiles();
        app.UseStaticFiles();
        app.MapFallbackToFile("index.html");
        return app;
    }

    private static readonly HashSet<string> AllowedImageExts =
        new(StringComparer.OrdinalIgnoreCase) { "png", "jpg", "jpeg", "gif", "webp", "bmp" };

    private static void MapEndpoints(WebApplication app)
    {
        app.MapPost("/api/auth/login", (LoginRequest body, TokenStore tokens) =>
        {
            var token = tokens.Login(body.Password);
            return token is null ? Results.Unauthorized() : Results.Ok(new { token });
        });

        app.MapPost("/api/auth/logout", (HttpContext ctx, TokenStore tokens) =>
        {
            var header = ctx.Request.Headers.Authorization.ToString();
            if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
                tokens.Revoke(header["Bearer ".Length..].Trim());
            return Results.Ok();
        });

        app.MapGet("/api/auth/config", (TokenStore tokens) =>
            Results.Ok(new { authRequired = !tokens.AuthDisabled }));

        app.MapGet("/api/sessions", (SessionManager mgr) => Results.Ok(mgr.List()));

        // Ids of sessions Claude is actively generating in — polled faster than the full list to drive
        // the live "active" dot in the session sidebar.
        app.MapGet("/api/sessions/activity", (SessionManager mgr) => Results.Ok(mgr.BusySessionIds()));

        // Live terminal stream for a session. Under /hub so the existing TokenAuthMiddleware guards
        // it (accepting ?access_token= for the WS handshake) and the vite dev proxy forwards the ws.
        app.Map("/hub/sessions/{id}/terminal", async (string id, HttpContext ctx, SessionManager mgr) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            var term = mgr.GetTerminal(id);
            if (term is null) { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            await Sessions.Pty.TerminalSocket.PumpAsync(ws, term, ctx.RequestAborted);
        });

        app.MapGet("/api/sessions/{id}", (string id, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            return info is null ? Results.NotFound() : Results.Ok(info);
        });

        app.MapPost("/api/sessions", (CreateSessionRequest req, SessionManager mgr) =>
        {
            try
            {
                var info = mgr.Create(req);
                return Results.Created($"/api/sessions/{info.Id}", info);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // External automation: create a session with an API key (X-Api-Key header). Same body as
        // the UI's POST /api/sessions; auth is handled by TokenAuthMiddleware for /api/external/*.
        app.MapPost("/api/external/sessions", (CreateSessionRequest req, SessionManager mgr) =>
        {
            try
            {
                var info = mgr.Create(req);
                return Results.Created($"/api/sessions/{info.Id}", info);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // Reopen a Restorable session from a previous run (relaunch with --continue).
        app.MapPost("/api/sessions/{id}/restore", (string id, SessionManager mgr) =>
        {
            try
            {
                var info = mgr.Restore(id);
                return info is null ? Results.NotFound() : Results.Created($"/api/sessions/{info.Id}", info);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // Stop the claude process and forget the session (also forgets a Restorable entry).
        app.MapDelete("/api/sessions/{id}", (string id, SessionManager mgr) =>
            mgr.Remove(id, stopProcess: true) ? Results.Ok() : Results.NotFound());

        // Forget the session but leave its Remote Control process running.
        app.MapPost("/api/sessions/{id}/detach", (string id, SessionManager mgr) =>
            mgr.Remove(id, stopProcess: false) ? Results.Ok() : Results.NotFound());

        // Enable/disable the hang watchdog for a session.
        app.MapPost("/api/sessions/{id}/watchdog", (string id, WatchdogRequest body, SessionManager mgr) =>
            mgr.SetWatchdogEnabled(id, body.Enabled) ? Results.Ok() : Results.NotFound());

        // Manually send the recovery sequence ("continue") to a session and clear its watchdog state.
        app.MapPost("/api/sessions/{id}/continue", async (string id, SessionManager mgr, WatchdogOptions wd) =>
        {
            var info = mgr.Get(id);
            if (info is null || info.State != SessionState.Running) return Results.NotFound();
            var term = mgr.GetTerminal(id);
            if (term is null) return Results.NotFound();
            await term.WriteAsync(System.Text.Encoding.UTF8.GetBytes(wd.SendSequence), CancellationToken.None);
            mgr.ResetWatchdog(id);
            return Results.Ok();
        });

        // ---- Recent launch presets & folders (shared across devices, persisted server-side) ---
        app.MapGet("/api/recents", (RecentsStore store) => Results.Ok(store.Get()));
        app.MapPost("/api/recents/sessions", (RecentSession body, RecentsStore store) => Results.Ok(store.AddSession(body)));
        app.MapPost("/api/recents/sessions/remove", (RecentSession body, RecentsStore store) => Results.Ok(store.RemoveSession(body)));
        app.MapPost("/api/recents/sessions/reorder", (List<RecentSession> body, RecentsStore store) => Results.Ok(store.ReorderSessions(body)));
        app.MapPost("/api/recents/folders", (FolderRequest body, RecentsStore store) => Results.Ok(store.AddFolder(body.Path)));
        app.MapPost("/api/recents/folders/remove", (FolderRequest body, RecentsStore store) => Results.Ok(store.RemoveFolder(body.Path)));

        var defaultFolder = app.Configuration["FileSystem:DefaultFolder"];
        app.MapGet("/api/fs/browse", (string? path) => Results.Ok(FileSystemBrowser.Browse(path, defaultFolder)));

        // ---- Per-session file browsing (confined to the session's working directory) --------
        app.MapGet("/api/sessions/{id}/fs/list", (string id, string? path, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var listing = SessionFileBrowser.List(info.WorkingDirectory, path);
            return listing is null ? Results.NotFound() : Results.Ok(listing);
        });

        app.MapGet("/api/sessions/{id}/fs/raw", (string id, string path, bool? download, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var full = SessionFileBrowser.ResolveSafe(info.WorkingDirectory, path);
            if (full is null || !File.Exists(full)) return Results.NotFound();

            var contentType = SessionFileBrowser.ContentType(full);
            var name = Path.GetFileName(full);
            return download == true
                ? Results.File(full, contentType, fileDownloadName: name, enableRangeProcessing: true)
                : Results.File(full, contentType, enableRangeProcessing: true);
        });

        app.MapGet("/api/sessions/{id}/fs/search", (string id, string q, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            return info is null
                ? Results.NotFound()
                : Results.Ok(new { entries = SessionFileBrowser.Search(info.WorkingDirectory, q) });
        });

        app.MapPost("/api/sessions/{id}/fs/write", (string id, FileWriteRequest body, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            return SessionFileBrowser.Write(info.WorkingDirectory, body.Path, body.Content ?? "")
                ? Results.Ok()
                : Results.BadRequest(new { error = "invalid path" });
        });

        // Save an image (e.g. pasted into the terminal) into .claudeweb/uploads/ under the working
        // dir, so its path can be handed to the Claude session. Body is base64 to keep JSON transport.
        app.MapPost("/api/sessions/{id}/fs/upload-image", (string id, ImageUploadRequest body, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();

            byte[] bytes;
            try { bytes = Convert.FromBase64String(body.DataBase64 ?? ""); }
            catch { return Results.BadRequest(new { error = "invalid base64" }); }
            if (bytes.Length == 0 || bytes.Length > 25 * 1024 * 1024)
                return Results.BadRequest(new { error = "empty or too large" });

            var ext = (body.Ext ?? "png").Trim().TrimStart('.').ToLowerInvariant();
            if (!AllowedImageExts.Contains(ext)) ext = "png";
            var name = $"pasted-{DateTime.Now:yyyyMMdd-HHmmss-fff}.{ext}";
            var rel = $".claudeweb/uploads/{name}";

            var full = SessionFileBrowser.WriteBytes(info.WorkingDirectory, rel, bytes);
            return full is null
                ? Results.BadRequest(new { error = "invalid path" })
                : Results.Ok(new { path = rel, fullPath = full });
        });

        // Filesystem change counter — the UI polls this to auto-refresh the tree.
        app.MapGet("/api/sessions/{id}/fs/version", (string id, SessionManager mgr) =>
        {
            var v = mgr.FsVersion(id);
            return v is null ? Results.NotFound() : Results.Ok(new { version = v });
        });

        // ---- Git status / diff for the session's working directory --------------------------
        app.MapGet("/api/sessions/{id}/git/status", (string id, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            return info is null ? Results.NotFound() : Results.Ok(GitService.Status(info.WorkingDirectory));
        });

        app.MapGet("/api/sessions/{id}/git/diff", (string id, string path, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (SessionFileBrowser.ResolveSafe(info.WorkingDirectory, path) is null)
                return Results.BadRequest(new { error = "invalid path" });

            var status = GitService.Status(info.WorkingDirectory);
            if (!status.IsRepo) return Results.Ok(new GitDiff(false, path, "", ""));
            var code = status.Files.TryGetValue(path, out var c) ? c : "";
            return Results.Ok(GitService.Diff(info.WorkingDirectory, path, code));
        });

        // Commit history (newest first, paged via skip/count).
        app.MapGet("/api/sessions/{id}/git/log", (string id, SessionManager mgr, int? skip, int? count) =>
        {
            var info = mgr.Get(id);
            return info is null
                ? Results.NotFound()
                : Results.Ok(GitService.Log(info.WorkingDirectory, Math.Max(0, skip ?? 0), Math.Clamp(count ?? 50, 1, 200)));
        });

        // Files changed by a single commit.
        app.MapGet("/api/sessions/{id}/git/commit", (string id, string hash, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (!IsCommitHash(hash)) return Results.BadRequest(new { error = "invalid hash" });
            return Results.Ok(GitService.CommitInfo(info.WorkingDirectory, hash));
        });

        // Diff for one file within a commit.
        app.MapGet("/api/sessions/{id}/git/commit-diff", (string id, string hash, string path, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (!IsCommitHash(hash)) return Results.BadRequest(new { error = "invalid hash" });
            if (SessionFileBrowser.ResolveSafe(info.WorkingDirectory, path) is null)
                return Results.BadRequest(new { error = "invalid path" });
            return Results.Ok(GitService.CommitDiff(info.WorkingDirectory, hash, path));
        });
    }

    // A git object name is hex (full or abbreviated SHA). Reject anything else before handing it to git.
    private static bool IsCommitHash(string? hash) =>
        !string.IsNullOrEmpty(hash) && hash.Length is >= 4 and <= 64 && hash.All(Uri.IsHexDigit);

    // Shared on-disk diagnostics location: %LocalAppData%\ClaudeWeb\logs (claudeweb.log + crash.log).
    private static string LogDirectory() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ClaudeWeb", "logs");

    // Published/tray: exe + wwwroot together → base dir. `dotnet run`: bin has no wwwroot → project dir.
    private static string ResolveContentRoot()
    {
        var baseDir = AppContext.BaseDirectory;
        return Directory.Exists(Path.Combine(baseDir, "wwwroot"))
            ? baseDir
            : Directory.GetCurrentDirectory();
    }

    private static int GetPort(string contentRoot)
    {
        try
        {
            var config = new ConfigurationBuilder()
                .SetBasePath(contentRoot)
                .AddJsonFile("appsettings.json", optional: true)
                .AddEnvironmentVariables()
                .Build();
            var first = (config["Server:Urls"] ?? "http://0.0.0.0:5099").Split(';', StringSplitOptions.RemoveEmptyEntries)[0].Trim();
            return new Uri(first.Replace("0.0.0.0", "localhost").Replace("+", "localhost").Replace("*", "localhost")).Port;
        }
        catch { return 5099; }
    }

    private static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }
}

internal record LoginRequest(string? Password);
internal record WatchdogRequest(bool Enabled);
internal record FileWriteRequest(string Path, string? Content);
internal record FolderRequest(string? Path);
internal record ImageUploadRequest(string? DataBase64, string? Ext);
