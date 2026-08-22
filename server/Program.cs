using System.Diagnostics;
using System.Text.Json;
using System.Windows.Forms;
using ClaudeWeb.Server.Auth;
using ClaudeWeb.Server.FileSystem;
using ClaudeWeb.Server.Logging;
using ClaudeWeb.Server.Push;
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
        // The address the tray icon (and a single-instance relaunch) opens. Defaults to the local
        // loopback, but Server:PublicUrl overrides it with an externally reachable hostname.
        var openUrl = ResolveOpenUrl(contentRoot, port);

        // Single-instance for the interactive tray: a second launch just opens the UI and exits.
        Mutex? mutex = null;
        if (!isService)
        {
            // Port-specific so a debug instance on another port can coexist with the live app.
            mutex = new Mutex(true, $"ClaudeWeb.SingleInstance.v1.{port}", out var isNew);
            if (!isNew)
            {
                OpenBrowser(openUrl);
                return;
            }
        }

        var app = BuildApp(args, contentRoot);

        // Register ClaudeWeb's Claude Code hooks in ~/.claude/settings.json so launched sessions report
        // their lifecycle back to /api/hooks (driving reliable busy/idle/waiting status). Opt out with
        // Hooks:Enabled=false; the app then falls back to terminal-scraping heuristics.
        if (app.Configuration.GetValue("Hooks:Enabled", true))
        {
            var hookLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Hooks");
            Sessions.ClaudeHookStore.EnsureConfigured(port, hookLog);
        }

        // Auto-resume: once the host is up, relaunch the sessions that were running at the previous exit,
        // each resuming its own conversation. On by default, so a PC shutdown/boot (or a redeploy, or a
        // tray Exit) brings the working set back without anyone clicking "Reopen". Turn it off with
        // Sessions:ResumeOnStart=false or --no-resume-sessions; --resume-sessions forces it on for one
        // launch (deploy.ps1 still passes it).
        // Freeze the session state file the moment anything says we're going down, so the entries stay
        // marked as running and auto-resume brings them back. SessionManager.Dispose does this too, but
        // a Windows shutdown kills our claude children BEFORE we get there — and each of those deaths
        // would otherwise persist "not running" and silently drop the session from the next start.
        // ApplicationStopping covers the service stop and Ctrl+C; SessionEnding covers shutdown/logoff.
        {
            var sessionManager = app.Services.GetRequiredService<SessionManager>();
            app.Lifetime.ApplicationStopping.Register(sessionManager.BeginShutdown);
            if (!isService)
                Microsoft.Win32.SystemEvents.SessionEnding += (_, _) => sessionManager.BeginShutdown();
        }

        var resumeSessions = app.Configuration.GetValue("Sessions:ResumeOnStart", true);
        if (args.Contains("--resume-sessions", StringComparer.OrdinalIgnoreCase)) resumeSessions = true;
        if (args.Contains("--no-resume-sessions", StringComparer.OrdinalIgnoreCase)) resumeSessions = false;
        if (resumeSessions)
        {
            app.Lifetime.ApplicationStarted.Register(() =>
            {
                var manager = app.Services.GetRequiredService<SessionManager>();
                var startupLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
                // Off the startup path: resuming waits out a settling delay and staggers its launches,
                // which must not hold up the tray message loop (or the service's start handshake).
                _ = Task.Run(async () =>
                {
                    try { await manager.ResumePersistedAsync(app.Lifetime.ApplicationStopping); }
                    catch (OperationCanceledException) { /* app is shutting down */ }
                    catch (Exception ex) { startupLog.LogWarning(ex, "Could not resume sessions"); }
                });
            });
        }

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
        using (var tray = new TrayApplicationContext(app, openUrl))
            Application.Run(tray);

        try { app.StopAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult(); } catch { }
        // Dispose the host so the DI container tears down: this runs SessionManager.Dispose(), which
        // kills each session's process tree (cmd.exe -> claude.exe). StopAsync alone does NOT dispose
        // the container, so without this the claude/node children are orphaned and keep running after
        // the tray "Exit" (the headless service path is fine — RunAsync disposes the host itself).
        try { (app as IDisposable)?.Dispose(); } catch { }
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
        // Collects Claude hook callbacks and derives live busy/waiting status; consumed by SessionManager
        // and pushed by SessionHub.
        builder.Services.AddSingleton<HookEventStore>();
        builder.Services.AddSingleton<SessionManager>();
        // The session-list push hub is one instance shared as both a singleton (so the endpoint can
        // reach it) and a hosted service (so its broadcast loop runs for the app's lifetime).
        builder.Services.AddSingleton<SessionHub>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<SessionHub>());
        builder.Services.AddSingleton(watchdogOptions);
        builder.Services.AddHostedService<WatchdogService>();
        builder.Services.AddSingleton<RecentsStore>();
        // Extra folders attached to a session's working directory, browsable from its Files panel.
        builder.Services.AddSingleton<LinkedFolderStore>();
        // Web Push: the VAPID keypair, the subscription store, and the notifier that fires a push on
        // the same attention/waiting transitions the UI shows — so alerts arrive with every tab closed.
        builder.Services.AddSingleton<VapidKeyStore>();
        builder.Services.AddSingleton<PushSubscriptionStore>();
        builder.Services.AddHostedService<PushNotifier>();
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

        // Claude hook callback: each launched session's http hooks POST their event JSON here, tagged
        // with X-Session-Id (our GUID) and X-Hook-Token (per-run secret), both sourced from env vars we
        // inject at launch. Correlated events feed HookEventStore's live busy/waiting status. A request
        // without a valid token or a known session (e.g. a plain `claude` run elsewhere on the machine)
        // is a quiet no-op — we always return an empty 200 so we never block or error the caller.
        app.MapPost("/api/hooks", async (HttpContext ctx, TokenStore tokens, HookEventStore hooks) =>
        {
            var token = ctx.Request.Headers["X-Hook-Token"].ToString();
            var sessionId = ctx.Request.Headers["X-Session-Id"].ToString();
            if (tokens.IsValidHookToken(token) && !string.IsNullOrEmpty(sessionId))
            {
                try
                {
                    using var doc = await JsonDocument.ParseAsync(ctx.Request.Body);
                    hooks.Ingest(sessionId, doc.RootElement);
                }
                catch { /* malformed body — ignore, still ack */ }
            }
            return Results.Ok();
        });

        // Ids of sessions Claude is actively generating in — polled faster than the full list to drive
        // the live "active" dot in the session sidebar. Kept as a fallback for when the push hub
        // (/hub/events) isn't connected.
        app.MapGet("/api/sessions/activity", (SessionManager mgr) => Results.Ok(mgr.BusySessionIds()));

        // Live session-list stream: pushes { sessions, busy } whenever it changes, so the UI reflects
        // new/renamed/exited sessions and busy/idle transitions without polling. Under /hub so the
        // existing TokenAuthMiddleware guards it (via ?access_token=) and the vite dev proxy forwards it.
        app.Map("/hub/events", async (HttpContext ctx, SessionHub hub) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            await hub.ServeAsync(ws, ctx.RequestAborted);
        });

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

        // Fork a session: launch a new one in the same folder that branches this session's conversation
        // (claude --resume <convo> --fork-session), leaving the original untouched. The new session
        // records its parent so the UI can nest it underneath.
        app.MapPost("/api/sessions/{id}/fork", (string id, ForkRequest body, SessionManager mgr) =>
        {
            try
            {
                var info = mgr.Fork(id, body.Name);
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

        // Rename a session; also injects `/rename <name>` into a live session's terminal so Claude follows.
        app.MapPost("/api/sessions/{id}/name", (string id, RenameRequest body, SessionManager mgr) =>
            mgr.Rename(id, body.Name) ? Results.NoContent() : Results.NotFound());

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

        // ---- Web Push subscriptions (background notifications when the tab/PWA is closed) ----------
        // The VAPID public key is not secret and is needed before the browser can subscribe, so its
        // config endpoint is on the public allowlist in TokenAuthMiddleware; subscribe/unsubscribe are
        // token-gated like everything else.
        app.MapGet("/api/push/config", (VapidKeyStore vapid) => Results.Ok(new { publicKey = vapid.Keys.PublicKey }));
        app.MapPost("/api/push/subscribe", (PushSubscribeRequest body, PushSubscriptionStore store) =>
        {
            if (body.Endpoint is null || body.Keys?.P256dh is null || body.Keys?.Auth is null)
                return Results.BadRequest(new { error = "invalid subscription" });
            store.Add(new PushSubscriptionEntry(body.Endpoint, body.Keys.P256dh, body.Keys.Auth));
            return Results.Ok();
        });
        app.MapPost("/api/push/unsubscribe", (PushUnsubscribeRequest body, PushSubscriptionStore store) =>
        {
            if (!string.IsNullOrWhiteSpace(body.Endpoint)) store.Remove(body.Endpoint);
            return Results.Ok();
        });

        var defaultFolder = app.Configuration["FileSystem:DefaultFolder"];
        app.MapGet("/api/fs/browse", (string? path) => Results.Ok(FileSystemBrowser.Browse(path, defaultFolder)));

        // ---- General server-filesystem browsing for the sidebar Files panel (absolute paths, not
        //      confined to a session). Same token auth as everything under /api. -------------------
        app.MapGet("/api/fs/list", (string? path) => Results.Ok(ServerFileBrowser.Browse(path, defaultFolder)));

        app.MapGet("/api/fs/file", (string path, bool? download, HttpContext http) =>
        {
            var full = Path.GetFullPath(path);
            if (!File.Exists(full)) return Results.NotFound();
            var contentType = SessionFileBrowser.ContentType(full);
            var name = Path.GetFileName(full);
            // Force revalidation: the URL is stable per path, so without this the browser serves a
            // stale heuristically-cached body after the file changes. ETag/Last-Modified still yield a
            // cheap 304 when unchanged.
            http.Response.Headers.CacheControl = "no-cache";
            return download == true
                ? Results.File(full, contentType, fileDownloadName: name, enableRangeProcessing: true)
                : Results.File(full, contentType, enableRangeProcessing: true);
        });

        app.MapPost("/api/fs/write", (FsWriteRequest body) =>
            ServerFileBrowser.WriteText(body.Path, body.Content ?? "")
                ? Results.Ok()
                : Results.BadRequest(new { error = "could not write file" }));

        app.MapPost("/api/fs/mkdir", (FsPathRequest body) =>
        {
            var full = ServerFileBrowser.Mkdir(body.Path);
            return full is null ? Results.BadRequest(new { error = "could not create folder" }) : Results.Ok(new { path = full });
        });

        app.MapPost("/api/fs/new-file", (FsPathRequest body) =>
        {
            var full = ServerFileBrowser.NewFile(body.Path);
            return full is null ? Results.BadRequest(new { error = "could not create file" }) : Results.Ok(new { path = full });
        });

        app.MapPost("/api/fs/rename", (FsRenameRequest body) =>
        {
            var full = ServerFileBrowser.Rename(body.Path, body.NewName);
            return full is null ? Results.BadRequest(new { error = "could not rename" }) : Results.Ok(new { path = full });
        });

        app.MapPost("/api/fs/upload", async (HttpRequest req) =>
        {
            if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected multipart form" });
            var form = await req.ReadFormAsync();
            var folder = form["path"].ToString();
            if (string.IsNullOrWhiteSpace(folder)) return Results.BadRequest(new { error = "no target folder" });
            if (form.Files.Count == 0) return Results.BadRequest(new { error = "no files" });

            var paths = new List<string>();
            foreach (var file in form.Files)
            {
                await using var stream = file.OpenReadStream();
                var full = await ServerFileBrowser.SaveUpload(folder, file.FileName, stream);
                if (full is null) return Results.BadRequest(new { error = "invalid folder" });
                paths.Add(full);
            }
            return Results.Ok(new { paths });
        });

        app.MapPost("/api/fs/delete", (FsPathRequest body) =>
            ServerFileBrowser.Delete(body.Path) ? Results.Ok() : Results.BadRequest(new { error = "could not delete" }));

        // ---- Folders linked to a session (persisted per working directory, so they survive a restart
        //      and a resumed session's new id). Each mutation returns the updated list. --------------
        app.MapGet("/api/sessions/{id}/linked-folders", (string id, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            return info is null
                ? Results.NotFound()
                : Results.Ok(new { folders = links.Get(info.WorkingDirectory) });
        });

        app.MapPost("/api/sessions/{id}/linked-folders", (string id, FolderRequest body, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var folders = links.Add(info.WorkingDirectory, body.Path);
            return folders is null
                ? Results.BadRequest(new { error = "not a folder, or already this session's own folder" })
                : Results.Ok(new { folders });
        });

        app.MapPost("/api/sessions/{id}/linked-folders/remove", (string id, FolderRequest body, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            return info is null
                ? Results.NotFound()
                : Results.Ok(new { folders = links.Remove(info.WorkingDirectory, body.Path) });
        });

        // ---- Per-session file browsing. `dir` picks the root: empty = the session's working directory,
        //      otherwise another worktree of the same repo (read-only) or one of its linked folders.
        //      Anything else is rejected, so a client can't point the API at an arbitrary folder. ----
        app.MapGet("/api/sessions/{id}/fs/list", (string id, string? path, string? dir, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = BrowseRoot(info, dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            var listing = SessionFileBrowser.List(root, path);
            return listing is null ? Results.NotFound() : Results.Ok(listing);
        });

        app.MapGet("/api/sessions/{id}/fs/raw", (string id, string path, bool? download, string? dir, SessionManager mgr, LinkedFolderStore links, HttpContext http) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = BrowseRoot(info, dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            var full = SessionFileBrowser.ResolveSafe(root, path);
            if (full is null || !File.Exists(full)) return Results.NotFound();

            var contentType = SessionFileBrowser.ContentType(full);
            var name = Path.GetFileName(full);
            // Force revalidation: the URL is stable per path, so without this the browser serves a
            // stale heuristically-cached body after the file changes. ETag/Last-Modified still yield a
            // cheap 304 when unchanged.
            http.Response.Headers.CacheControl = "no-cache";
            return download == true
                ? Results.File(full, contentType, fileDownloadName: name, enableRangeProcessing: true)
                : Results.File(full, contentType, enableRangeProcessing: true);
        });

        app.MapGet("/api/sessions/{id}/fs/search", (string id, string q, string? dir, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = BrowseRoot(info, dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            return Results.Ok(new { entries = SessionFileBrowser.Search(root, q) });
        });

        app.MapPost("/api/sessions/{id}/fs/write", (string id, FileWriteRequest body, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = WriteRoot(info, body.Dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            return SessionFileBrowser.Write(root, body.Path, body.Content ?? "")
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

        // Upload one or more arbitrary files into a folder under the write root (multipart form:
        // a "path" field for the target folder — empty means the root — an optional "dir" naming a
        // linked folder to write into, and one or more "files").
        app.MapPost("/api/sessions/{id}/fs/upload", async (string id, HttpRequest req, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (!req.HasFormContentType) return Results.BadRequest(new { error = "expected multipart form" });

            var form = await req.ReadFormAsync();
            var folder = form["path"].ToString();
            var root = WriteRoot(info, form["dir"].ToString(), links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            if (form.Files.Count == 0) return Results.BadRequest(new { error = "no files" });

            var paths = new List<string>();
            foreach (var file in form.Files)
            {
                await using var stream = file.OpenReadStream();
                var rel = await SessionFileBrowser.SaveUpload(root, folder, file.FileName, stream);
                if (rel is null) return Results.BadRequest(new { error = "invalid folder" });
                paths.Add(rel);
            }
            return Results.Ok(new { paths });
        });

        // Rename a file/folder within the write root (bare new name, same parent).
        app.MapPost("/api/sessions/{id}/fs/rename", (string id, FileRenameRequest body, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = WriteRoot(info, body.Dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            return SessionFileBrowser.Rename(root, body.Path, body.NewName)
                ? Results.Ok()
                : Results.BadRequest(new { error = "could not rename" });
        });

        // Delete a file/folder (recursively) within the write root.
        app.MapPost("/api/sessions/{id}/fs/delete", (string id, FolderRequest body, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = WriteRoot(info, body.Dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            return !string.IsNullOrEmpty(body.Path) && SessionFileBrowser.Delete(root, body.Path)
                ? Results.Ok()
                : Results.BadRequest(new { error = "could not delete" });
        });

        // Create a folder (possibly nested, e.g. "a/b/c") under the write root.
        app.MapPost("/api/sessions/{id}/fs/mkdir", (string id, FolderCreateRequest body, SessionManager mgr, LinkedFolderStore links) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = WriteRoot(info, body.Dir, links);
            if (root is null) return Results.BadRequest(new { error = "invalid root" });
            var rel = SessionFileBrowser.CreateDir(root, body.Path ?? "");
            return rel is null
                ? Results.BadRequest(new { error = "invalid path" })
                : Results.Ok(new { path = rel });
        });

        // Postponed messages: drafts stashed while Claude is busy, persisted server-side per session
        // (in .claudeweb/postponed/<id>.json under the working dir, alongside the images they reference)
        // so they survive a reload and are shared across devices. Keyed by session id, so sessions that
        // share a working directory each keep their own pool (a resume gets a fresh session id → empty).
        app.MapGet("/api/sessions/{id}/postponed", (string id, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var json = SessionFileBrowser.ReadTextSafe(info.WorkingDirectory, PostponedStore.RelPathFor(id));
            return Results.Content(json ?? "[]", "application/json");
        });

        app.MapPut("/api/sessions/{id}/postponed", async (string id, HttpContext ctx, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            using var reader = new StreamReader(ctx.Request.Body);
            var body = await reader.ReadToEndAsync();
            if (body.Length > 512 * 1024) return Results.BadRequest(new { error = "too large" });
            return SessionFileBrowser.WriteBytes(info.WorkingDirectory, PostponedStore.RelPathFor(id), System.Text.Encoding.UTF8.GetBytes(body)) is not null
                ? Results.Ok()
                : Results.BadRequest(new { error = "invalid path" });
        });

        // Filesystem change counter — the UI polls this to auto-refresh the tree.
        app.MapGet("/api/sessions/{id}/fs/version", (string id, SessionManager mgr) =>
        {
            var v = mgr.FsVersion(id);
            return v is null ? Results.NotFound() : Results.Ok(new { version = v });
        });

        // ---- Git status / diff for the session's working directory (or another worktree via ?dir=) ----
        // The optional `dir` selects a different worktree of the same repo; it's validated against the
        // repo's worktree list so callers can't point git at an arbitrary folder.
        app.MapGet("/api/sessions/{id}/git/worktrees", (string id, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            return info is null ? Results.NotFound() : Results.Ok(GitService.Worktrees(info.WorkingDirectory));
        });

        app.MapGet("/api/sessions/{id}/git/status", (string id, string? dir, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = GitService.ResolveWorktree(info.WorkingDirectory, dir);
            return root is null ? Results.BadRequest(new { error = "invalid worktree" }) : Results.Ok(GitService.Status(root));
        });

        app.MapGet("/api/sessions/{id}/git/diff", (string id, string path, string? dir, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            var root = GitService.ResolveWorktree(info.WorkingDirectory, dir);
            if (root is null) return Results.BadRequest(new { error = "invalid worktree" });
            if (SessionFileBrowser.ResolveSafe(root, path) is null)
                return Results.BadRequest(new { error = "invalid path" });

            var status = GitService.Status(root);
            if (!status.IsRepo) return Results.Ok(new GitDiff(false, path, "", ""));
            var code = status.Files.TryGetValue(path, out var c) ? c : "";
            return Results.Ok(GitService.Diff(root, path, code));
        });

        // Commit history (newest first, paged via skip/count).
        app.MapGet("/api/sessions/{id}/git/log", (string id, SessionManager mgr, int? skip, int? count, string? @ref, bool? all) =>
        {
            var info = mgr.Get(id);
            return info is null
                ? Results.NotFound()
                : Results.Ok(GitService.Log(info.WorkingDirectory, Math.Max(0, skip ?? 0), Math.Clamp(count ?? 50, 1, 200), @ref, all == true));
        });

        // Local branches (with any other-worktree locations) for the history branch picker.
        app.MapGet("/api/sessions/{id}/git/branches", (string id, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            return info is null ? Results.NotFound() : Results.Ok(GitService.Branches(info.WorkingDirectory));
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

        // Full content of one file as of a commit (for the "full" view in the commit preview).
        app.MapGet("/api/sessions/{id}/git/commit-file", (string id, string hash, string path, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (!IsCommitHash(hash)) return Results.BadRequest(new { error = "invalid hash" });
            if (SessionFileBrowser.ResolveSafe(info.WorkingDirectory, path) is null)
                return Results.BadRequest(new { error = "invalid path" });
            return Results.Ok(GitService.CommitFile(info.WorkingDirectory, hash, path));
        });
    }

    /// <summary>
    /// The folder a session may READ through its file API for a requested <paramref name="dir"/>: its own
    /// working directory (empty <paramref name="dir"/>), another worktree of the same repo, or a folder
    /// linked to it. Null when the request names anything else.
    /// </summary>
    private static string? BrowseRoot(SessionInfo info, string? dir, LinkedFolderStore links) =>
        GitService.ResolveWorktree(info.WorkingDirectory, dir) ?? links.Resolve(info.WorkingDirectory, dir);

    /// <summary>
    /// The folder a session may WRITE to for a requested <paramref name="dir"/>: its own working directory
    /// or a folder the user has deliberately linked to it. Other worktrees stay read-only, so a stray
    /// <c>dir</c> can never turn a browse into an edit of the repo's other checkouts.
    /// </summary>
    private static string? WriteRoot(SessionInfo info, string? dir, LinkedFolderStore links) =>
        string.IsNullOrWhiteSpace(dir) ? info.WorkingDirectory : links.Resolve(info.WorkingDirectory, dir);

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

    // The URL the tray icon and single-instance relaunch open. Server:PublicUrl (e.g. a reverse-proxied
    // public hostname) wins when set; otherwise fall back to the local loopback on the bound port. The
    // web host itself still binds to Server:Urls — this only changes where the tray navigates.
    private static string ResolveOpenUrl(string contentRoot, int port)
    {
        try
        {
            var config = new ConfigurationBuilder()
                .SetBasePath(contentRoot)
                .AddJsonFile("appsettings.json", optional: true)
                .AddEnvironmentVariables()
                .Build();
            var publicUrl = config["Server:PublicUrl"];
            if (!string.IsNullOrWhiteSpace(publicUrl)) return publicUrl.Trim();
        }
        catch { /* fall back to loopback below */ }
        return $"http://localhost:{port}";
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
internal record RenameRequest(string Name);
// Name for a forked session; blank/absent falls back to a "<parent> (fork)" default server-side.
internal record ForkRequest(string? Name);
// `Dir` on the session file-mutation payloads names the write root: empty (the default) is the
// session's own working directory, otherwise one of its linked folders.
internal record FileWriteRequest(string Path, string? Content, string? Dir = null);
internal record FileRenameRequest(string Path, string NewName, string? Dir = null);
internal record FolderRequest(string? Path, string? Dir = null);
internal record FolderCreateRequest(string? Path, string? Dir = null);
internal record FsWriteRequest(string Path, string? Content);
internal record FsPathRequest(string Path);
internal record FsRenameRequest(string Path, string NewName);
internal record ImageUploadRequest(string? DataBase64, string? Ext);
internal record PushSubscribeRequest(string? Endpoint, PushKeys? Keys);
internal record PushKeys(string? P256dh, string? Auth);
internal record PushUnsubscribeRequest(string? Endpoint);
