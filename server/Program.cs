using System.Diagnostics;
using System.Text.Json;
using System.Windows.Forms;
using ClaudeWeb.Pty;
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

        // Freeze the session state file the moment anything says we're going down, so the entries stay
        // marked as running and are there to be matched against the live pty hosts on the next start.
        // ApplicationStopping covers the service stop and Ctrl+C; SessionEnding covers shutdown/logoff
        // — the latter still matters, because a Windows shutdown kills the claude children before we
        // get there, and each of those deaths would otherwise persist "not running".
        {
            var sessionManager = app.Services.GetRequiredService<SessionManager>();
            app.Lifetime.ApplicationStopping.Register(sessionManager.BeginShutdown);
            if (!isService)
                Microsoft.Win32.SystemEvents.SessionEnding += (_, _) => sessionManager.BeginShutdown();
        }

        var resumeSessions = app.Configuration.GetValue("Sessions:ResumeOnStart", true);
        if (args.Contains("--resume-sessions", StringComparer.OrdinalIgnoreCase)) resumeSessions = true;
        if (args.Contains("--no-resume-sessions", StringComparer.OrdinalIgnoreCase)) resumeSessions = false;

        // Startup session recovery, in two steps that must happen in this order:
        //
        //   1. RE-ATTACH to every session whose pty host is still running. An in-app update, a
        //      redeploy, tray Exit or a crash leaves those alive, and they come back with their
        //      scrollback and their in-flight conversation intact — no relaunch, no --resume.
        //   2. AUTO-RESUME whatever is genuinely gone (the machine rebooted: a ConPTY child can't
        //      survive that), relaunching each with --resume/--continue. On by default; turn it off
        //      with Sessions:ResumeOnStart=false or --no-resume-sessions, and --resume-sessions forces
        //      it on for one launch (deploy.ps1 still passes it).
        //
        // Step 1 runs even when auto-resume is off: adopting a live session is not a relaunch, and a
        // dev instance with ResumeOnStart=false still wants its own sessions back. It is also why
        // step 2 no longer finds them — which is the entire point.
        app.Lifetime.ApplicationStarted.Register(() =>
        {
            var manager = app.Services.GetRequiredService<SessionManager>();
            var startupLog = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Startup");
            // Off the startup path: adoption talks to each host over a pipe and resuming staggers its
            // launches, neither of which may hold up the tray message loop (or the service's start
            // handshake).
            _ = Task.Run(async () =>
            {
                var ct = app.Lifetime.ApplicationStopping;
                try { await manager.AdoptRunningHostsAsync(ct); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { startupLog.LogWarning(ex, "Could not re-attach to running pty hosts"); }

                // Shell tabs come back the same way — a build or a tail left running in one is
                // exactly the thing a restart must not interrupt. There is no resume half for them:
                // a shell whose process is gone has nothing left worth relaunching.
                try { await app.Services.GetRequiredService<Sessions.Shells.ShellManager>().AdoptRunningHostsAsync(ct); }
                catch (OperationCanceledException) { return; }
                catch (Exception ex) { startupLog.LogWarning(ex, "Could not re-attach to running shells"); }

                if (!resumeSessions) return;
                try { await manager.ResumePersistedAsync(ct); }
                catch (OperationCanceledException) { /* app is shutting down */ }
                catch (Exception ex) { startupLog.LogWarning(ex, "Could not resume sessions"); }
            });
        });

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
        // Dispose the host so the DI container tears down cleanly. This runs SessionManager.Dispose(),
        // which now only DETACHES from each session's pty host — the claude processes are meant to keep
        // running past a tray "Exit" and be re-attached on the next start. (It used to kill each
        // session's process tree here, which is exactly the behaviour this app no longer wants.)
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
        var updateOptions = builder.Configuration.GetSection("Update").Get<Update.UpdateOptions>() ?? new Update.UpdateOptions();
        var ptyHostOptions = builder.Configuration.GetSection("Pty").Get<Sessions.Pty.PtyHostOptions>() ?? new Sessions.Pty.PtyHostOptions();

        // The URL a launched session calls back on (CLAUDEWEB_URL in its environment). Derived from the
        // bound port unless the operator pinned Sessions:SelfUrl; always loopback, since the session's
        // process runs on this machine.
        if (string.IsNullOrWhiteSpace(sessionOptions.SelfUrl))
            sessionOptions.SelfUrl = $"http://127.0.0.1:{PortFromUrls(urls)}";

        // Namespace this instance's pty pipes and state directory by the bound port, matching the
        // port-scoped single-instance mutex above. %LocalAppData%\ClaudeWeb is shared by every
        // instance on the machine, so without this a dev instance would adopt the live app's hosts —
        // and stopping a session there would stop a real one. Pty:InstanceKey overrides it.
        if (string.IsNullOrWhiteSpace(ptyHostOptions.InstanceKey))
            ptyHostOptions.InstanceKey = PortFromUrls(urls).ToString();

        builder.Services.AddSingleton(authOptions);
        builder.Services.AddSingleton<TokenStore>();
        builder.Services.AddSingleton(sessionOptions);
        builder.Services.AddSingleton(ptyHostOptions);
        // Collects Claude hook callbacks and derives live busy/waiting status; consumed by SessionManager
        // and pushed by SessionHub.
        builder.Services.AddSingleton<HookEventStore>();
        builder.Services.AddSingleton<SessionManager>();
        // The session-list push hub is one instance shared as both a singleton (so the endpoint can
        // reach it) and a hosted service (so its broadcast loop runs for the app's lifetime).
        builder.Services.AddSingleton<SessionHub>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<SessionHub>());
        // The watchdog itself now runs inside each session's pty host — that is what lets it recover a
        // session that hangs while this app is stopped. These options are still bound here, handed to
        // each host at spawn, and read by the manual "Continue" endpoint for its send sequence.
        builder.Services.AddSingleton(watchdogOptions);
        // Watches the update staging folder and, on request, hands off to the external updater. One
        // instance shared as a singleton (the endpoints and the hub read its status) and as a hosted
        // service (its watch loop runs for the app's lifetime).
        builder.Services.AddSingleton(updateOptions);
        builder.Services.AddSingleton<Update.UpdateService>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<Update.UpdateService>());
        builder.Services.AddSingleton<RecentsStore>();
        // Pinned sessions, keyed by conversation id so a pin survives a reopen and follows the user
        // between browsers (it rides the session list as SessionInfo.Pinned).
        builder.Services.AddSingleton<PinStore>();
        // How each session was last being looked at (view tab, open file tabs, tree state), keyed by
        // conversation id like the pins, so it follows the user between browsers and devices.
        builder.Services.AddSingleton<SessionUiStore>();
        // Projects: named groupings of folders, shown above the folder groups in the sessions sidebar.
        builder.Services.AddSingleton<ProjectStore>();
        // Shell tabs: a plain interactive shell (cmd/PowerShell/Git Bash/WSL) in a session's folder,
        // on its own pty hosts so a build left running survives a restart of this app.
        builder.Services.AddSingleton<Sessions.Shells.ShellManager>();
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

        // Launching is genuinely async now — it spawns the session's pty host and waits for it to
        // answer its pipe — so the request awaits rather than blocking a thread pool thread on it.
        app.MapPost("/api/sessions", async (CreateSessionRequest req, SessionManager mgr) =>
        {
            try
            {
                var info = await mgr.CreateAsync(req);
                return Results.Created($"/api/sessions/{info.Id}", info);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // External automation: create a session with an API key (X-Api-Key header). Same body as
        // the UI's POST /api/sessions; auth is handled by TokenAuthMiddleware for /api/external/*.
        app.MapPost("/api/external/sessions", async (CreateSessionRequest req, SessionManager mgr) =>
        {
            try
            {
                var info = await mgr.CreateAsync(req);
                return Results.Created($"/api/sessions/{info.Id}", info);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // Reopen a Restorable session from a previous run (relaunch with --continue).
        app.MapPost("/api/sessions/{id}/restore", async (string id, SessionManager mgr) =>
        {
            try
            {
                var info = await mgr.RestoreAsync(id);
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
        app.MapPost("/api/sessions/{id}/fork", async (string id, ForkRequest body, SessionManager mgr) =>
        {
            try
            {
                var info = await mgr.ForkAsync(id, body.Name);
                return info is null ? Results.NotFound() : Results.Created($"/api/sessions/{info.Id}", info);
            }
            catch (Exception ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // Stop the claude process and forget the session (also forgets a Restorable entry). Its shell
        // tabs go with it — they were opened against this session, and nothing would list them again.
        app.MapDelete("/api/sessions/{id}", async (string id, SessionManager mgr, Sessions.Shells.ShellManager shells) =>
        {
            var removed = mgr.Remove(id, stopProcess: true);
            await shells.CloseForSessionAsync(id);
            return removed ? Results.Ok() : Results.NotFound();
        });

        // ---- Shell tabs -----------------------------------------------------------------------
        // A plain interactive shell in a folder, streamed over the same terminal socket the Claude
        // session uses. See Sessions/Shells/ShellManager.cs.

        // What this machine can run: cmd, Windows PowerShell, PowerShell 7, Git Bash, each installed
        // WSL distribution. Probed rather than assumed, so the menu never offers a tab that can't open.
        app.MapGet("/api/shells/options", (bool? refresh) => Results.Ok(new
        {
            shells = Sessions.Shells.ShellCatalog.Available(refresh == true),
            @default = Sessions.Shells.ShellCatalog.DefaultId,
        }));

        // The open shells, optionally narrowed to one session's. Server-side, so every browser looking
        // at a session sees the same tabs.
        app.MapGet("/api/shells", (string? sessionId, Sessions.Shells.ShellManager shells) =>
            Results.Ok(shells.List(sessionId)));

        app.MapPost("/api/shells", async (Sessions.Shells.CreateShellRequest req, Sessions.Shells.ShellManager shells) =>
        {
            try { return Results.Ok(await shells.CreateAsync(req)); }
            catch (Exception ex) { return Results.BadRequest(new { error = ex.Message }); }
        });

        // Close a shell and kill what is running in it. Unlike a session there is no detach: a shell
        // nobody has a tab for is just a stranded process.
        app.MapDelete("/api/shells/{id}", async (string id, Sessions.Shells.ShellManager shells) =>
            await shells.CloseAsync(id) ? Results.Ok() : Results.NotFound());

        // Live terminal stream for a shell — same framing and same socket pump as a session's, under
        // /hub so TokenAuthMiddleware guards it and the vite dev proxy forwards it.
        app.Map("/hub/shells/{id}/terminal", async (string id, HttpContext ctx, Sessions.Shells.ShellManager shells) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            var term = shells.GetTerminal(id);
            if (term is null) { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            await Sessions.Pty.TerminalSocket.PumpAsync(ws, term, ctx.RequestAborted);
        });

        // Pty hosts still running for sessions this app no longer knows about — see PtyOrphanInfo.
        // Listing them is also what cleans up state files whose host is gone.
        app.MapGet("/api/pty/orphans", (SessionManager mgr) => Results.Ok(mgr.ListOrphans()));

        // Stop orphaned hosts, and the claude processes under them. No body (or no id) stops every
        // orphan; {"sessionId":"..."} stops one. Destructive — each is a live conversation — so the
        // UI confirms first and nothing here acts on its own.
        app.MapPost("/api/pty/orphans/stop", async (StopOrphansRequest? body, SessionManager mgr) =>
            Results.Ok(new { stopped = await mgr.StopOrphansAsync(body?.SessionId) }));

        // Detach: forget the session but leave its pty host — and so its claude process — running. It
        // can be adopted again on a later start, since its state file and sessions.json entry both stay.
        app.MapPost("/api/sessions/{id}/detach", (string id, SessionManager mgr) =>
            mgr.Remove(id, stopProcess: false) ? Results.Ok() : Results.NotFound());

        // Rename a session; also injects `/rename <name>` into a live session's terminal so Claude follows.
        app.MapPost("/api/sessions/{id}/name", (string id, RenameRequest body, SessionManager mgr) =>
            mgr.Rename(id, body.Name) ? Results.NoContent() : Results.NotFound());

        // Self-rename from inside a running session: a command the session itself runs (typically
        // `claude` calling curl) POSTs its own new name. It authenticates with the very credentials we
        // injected into its environment at launch — X-Session-Id (CLAUDEWEB_SESSION_ID, which also
        // names the session to rename) and X-Hook-Token (CLAUDEWEB_HOOK_TOKEN, minted per app run) —
        // so no browser token or API key is involved and a session can only ever rename itself.
        // Beyond the id, this is exactly the UI rename: the display name changes and `/rename <name>`
        // is injected into the terminal so Claude's own conversation title follows.
        app.MapPost("/api/self/name", (HttpContext ctx, RenameRequest body, TokenStore tokens,
            SessionManager mgr, ILoggerFactory lf) =>
        {
            if (!tokens.IsValidHookToken(ctx.Request.Headers["X-Hook-Token"].ToString()))
            {
                // Worth a line: from inside a session this reads as a bare 401 with nothing to chase.
                // The token is persisted now, so the remaining cause is a session started against a
                // different state directory — or one launched before this build, still carrying a
                // per-run token that no longer exists.
                lf.CreateLogger("SelfRename").LogWarning(
                    "Self-rename rejected: stale or missing X-Hook-Token from session {Id}",
                    ctx.Request.Headers["X-Session-Id"].ToString());
                return Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);
            }
            var id = ctx.Request.Headers["X-Session-Id"].ToString();
            if (string.IsNullOrEmpty(id))
                return Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);
            // Sanitize up front so an all-whitespace/control-character name is a clear 400 rather than
            // being indistinguishable from an unknown session.
            var clean = ClaudeSession.SanitizeName(body.Name);
            if (clean.Length == 0) return Results.BadRequest(new { error = "name is empty" });
            return mgr.Rename(id, clean) ? Results.Ok(new { id, name = clean }) : Results.NotFound();
        });

        // Enable/disable the hang watchdog for a session.
        // Pin/unpin a session. The manager resolves which conversation the pin belongs to; the client
        // only ever names a session, and reads the result back off the session list.
        app.MapPost("/api/sessions/{id}/pin", (string id, PinRequest body, SessionManager mgr) =>
            mgr.SetPinned(id, body.Pinned) ? Results.Ok() : Results.NotFound());

        // How a session was last being looked at. GET seeds a browser on load; POST merges a patch
        // into the saved bag and answers with the merged result, so the caller adopts the server's
        // version rather than assuming its own. Other browsers notice through SessionInfo.UiRev.
        app.MapGet("/api/sessions/{id}/ui", (string id, SessionManager mgr) =>
            mgr.GetUi(id) is { } ui ? Results.Ok(ui) : Results.NotFound());

        app.MapPost("/api/sessions/{id}/ui", (string id, SessionUiRequest body, SessionManager mgr) =>
            mgr.MergeUi(id, body.State, body.Quiet) is { } ui ? Results.Ok(ui) : Results.NotFound());

        app.MapPost("/api/sessions/{id}/watchdog", async (string id, WatchdogRequest body, SessionManager mgr) =>
            await mgr.SetWatchdogEnabledAsync(id, body.Enabled) ? Results.Ok() : Results.NotFound());

        // Manually send the recovery sequence ("continue") to a session and clear its watchdog state.
        app.MapPost("/api/sessions/{id}/continue", async (string id, SessionManager mgr, WatchdogOptions wd) =>
        {
            var info = mgr.Get(id);
            if (info is null || info.State != SessionState.Running) return Results.NotFound();
            var term = mgr.GetTerminal(id);
            if (term is null) return Results.NotFound();
            await term.WriteAsync(System.Text.Encoding.UTF8.GetBytes(wd.SendSequence), CancellationToken.None);
            await mgr.ResetWatchdogAsync(id);
            return Results.Ok();
        });

        // ---- Recent launch presets & folders (shared across devices, persisted server-side) ---
        app.MapGet("/api/recents", (RecentsStore store) => Results.Ok(store.Get()));
        app.MapPost("/api/recents/sessions", (RecentSession body, RecentsStore store) => Results.Ok(store.AddSession(body)));
        app.MapPost("/api/recents/sessions/remove", (RecentSession body, RecentsStore store) => Results.Ok(store.RemoveSession(body)));
        app.MapPost("/api/recents/sessions/reorder", (List<RecentSession> body, RecentsStore store) => Results.Ok(store.ReorderSessions(body)));
        app.MapPost("/api/recents/folders", (FolderRequest body, RecentsStore store) => Results.Ok(store.AddFolder(body.Path)));
        app.MapPost("/api/recents/folders/remove", (FolderRequest body, RecentsStore store) => Results.Ok(store.RemoveFolder(body.Path)));

        // ---- Projects (named groupings of folders, shared across devices) --------------------------
        // Every mutation answers with the whole list so a client can replace its state from the
        // response — linking a folder can also unlink it from another project, so a patch would need
        // to know more about the rules than the client should have to.
        app.MapGet("/api/projects", (ProjectStore store) => Results.Ok(store.List()));
        app.MapPost("/api/projects", (ProjectRequest body, ProjectStore store) =>
            store.Create(body.Name, body.Color, body.Folders) is { } list
                ? Results.Ok(list)
                : Results.BadRequest(new { error = "A project needs a name (and there is a limit on how many)." }));
        // A null name means "leave it alone"; a blank one is a bad request, not a missing project —
        // the store answers null to both, so the name is checked here to keep the two apart.
        app.MapPost("/api/projects/{id}", (string id, ProjectRequest body, ProjectStore store) =>
            body.Name is { } n && string.IsNullOrWhiteSpace(n)
                ? Results.BadRequest(new { error = "A project needs a name." })
                : store.Update(id, body.Name, body.Color) is { } list ? Results.Ok(list) : Results.NotFound());
        app.MapDelete("/api/projects/{id}", (string id, ProjectStore store) =>
            store.Delete(id) is { } list ? Results.Ok(list) : Results.NotFound());
        app.MapPost("/api/projects/{id}/folders", (string id, FolderRequest body, ProjectStore store) =>
            store.AddFolder(id, body.Path) is { } list ? Results.Ok(list) : Results.NotFound());
        app.MapPost("/api/projects/{id}/folders/remove", (string id, FolderRequest body, ProjectStore store) =>
            store.RemoveFolder(id, body.Path) is { } list ? Results.Ok(list) : Results.NotFound());

        // Virtual folders: named boxes inside a project that hold sessions filed there by hand. A
        // group id addresses a group on its own (they are unique across the file), so editing and
        // deleting one doesn't route through the project that holds it.
        // AddGroup answers null to both "blank name" and "no such project", so the name is checked
        // here to keep the two apart — the same split the update route below makes.
        app.MapPost("/api/projects/{id}/groups", (string id, GroupRequest body, ProjectStore store) =>
            string.IsNullOrWhiteSpace(body.Name)
                ? Results.BadRequest(new { error = "A group needs a name." })
                : store.AddGroup(id, body.Name, body.Color, body.Icon) is { } list
                    ? Results.Ok(list)
                    : Results.NotFound());
        app.MapPost("/api/projects/groups/{groupId}", (string groupId, GroupRequest body, ProjectStore store) =>
            body.Name is { } n && string.IsNullOrWhiteSpace(n)
                ? Results.BadRequest(new { error = "A group needs a name." })
                : store.UpdateGroup(groupId, body.Name, body.Color, body.Icon) is { } list
                    ? Results.Ok(list)
                    : Results.NotFound());
        app.MapDelete("/api/projects/groups/{groupId}", (string groupId, ProjectStore store) =>
            store.DeleteGroup(groupId) is { } list ? Results.Ok(list) : Results.NotFound());
        // Filing a session into one (a null groupId takes it out). It goes through the manager rather
        // than the store because the membership is keyed by the session's conversation, which only the
        // manager can resolve — and because every browser has to be told the session list changed.
        app.MapPost("/api/sessions/{id}/group", (string id, SessionGroupRequest body, SessionManager mgr) =>
            mgr.SetGroup(id, string.IsNullOrWhiteSpace(body.GroupId) ? null : body.GroupId) is { } list
                ? Results.Ok(list)
                : Results.NotFound());

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

        // ---- In-app update (staged by scripts\stage-update.ps1, applied by scripts\apply-update.ps1) ----
        // The running build, the staged one, and whether they differ. Also carried on the /hub/events
        // snapshot, so the button appears the moment a build is staged; this is the initial read.
        app.MapGet("/api/update", (Update.UpdateService updates) => Results.Ok(updates.Status));

        // Apply the staged build: hand off to the detached updater and start shutting down. The reply
        // is the last thing this build says — the browser reconnects to the new one a few seconds later,
        // by which time the sessions that were running have been resumed.
        app.MapPost("/api/update/apply", (Update.UpdateService updates) =>
        {
            var status = updates.Apply();
            return status.State == Update.UpdateState.Applying
                ? Results.Accepted("/api/update", status)
                : Results.BadRequest(new { error = status.Error ?? "could not apply the update", status });
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
            return PortFromUrls(config["Server:Urls"]);
        }
        catch { return 5099; }
    }

    /// <summary>The port from the first entry of a Kestrel bind list ("http://0.0.0.0:5099;...").</summary>
    private static int PortFromUrls(string? urls)
    {
        try
        {
            var first = (urls ?? "http://0.0.0.0:5099").Split(';', StringSplitOptions.RemoveEmptyEntries)[0].Trim();
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

/// <summary>Body for <c>POST /api/pty/orphans/stop</c>; a null id means "all of them".</summary>
internal record StopOrphansRequest(string? SessionId);
internal record WatchdogRequest(bool Enabled);
internal record PinRequest(bool Pinned);
/// <summary>Body for <c>POST /api/sessions/{id}/ui</c>: the UI-state fields to merge (a null value
/// removes that field). The shape of the bag belongs to the client; the server only merges it.
/// <c>Quiet</c> saves without advancing the revision, for a field the other browsers need not be
/// told about while it changes.</summary>
internal record SessionUiRequest(Dictionary<string, System.Text.Json.JsonElement>? State, bool Quiet = false);
internal record RenameRequest(string Name);
// Name for a forked session; blank/absent falls back to a "<parent> (fork)" default server-side.
internal record ForkRequest(string? Name);
// `Dir` on the session file-mutation payloads names the write root: empty (the default) is the
// session's own working directory, otherwise one of its linked folders.
internal record FileWriteRequest(string Path, string? Content, string? Dir = null);
internal record FileRenameRequest(string Path, string NewName, string? Dir = null);
internal record FolderRequest(string? Path, string? Dir = null);
// Create/update a project. On update a null field means "leave it alone"; an empty colour clears it.
internal record ProjectRequest(string? Name, string? Color = null, List<string>? Folders = null);
// Create/update a virtual folder. On update a null field means "leave it alone"; an empty colour or
// icon clears it.
internal record GroupRequest(string? Name, string? Color = null, string? Icon = null);
// File a session into a virtual folder; a blank/absent id takes it out of the one it is in.
internal record SessionGroupRequest(string? GroupId);
internal record FolderCreateRequest(string? Path, string? Dir = null);
internal record FsWriteRequest(string Path, string? Content);
internal record FsPathRequest(string Path);
internal record FsRenameRequest(string Path, string NewName);
internal record ImageUploadRequest(string? DataBase64, string? Ext);
internal record PushSubscribeRequest(string? Endpoint, PushKeys? Keys);
internal record PushKeys(string? P256dh, string? Auth);
internal record PushUnsubscribeRequest(string? Endpoint);
