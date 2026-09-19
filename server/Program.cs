using System.Diagnostics;
using System.Text.Json;
using ClaudeWeb.Pty;
using ClaudeWeb.Server.Auth;
using ClaudeWeb.Server.Diagnostics;
using ClaudeWeb.Server.FileSystem;
using ClaudeWeb.Server.Logging;
using ClaudeWeb.Server.Push;
using ClaudeWeb.Server.Sessions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Hosting.WindowsServices;

namespace ClaudeWeb.Server;

/// <summary>
/// The daemon: a headless web host that owns every session, store and endpoint. It has no UI of its own —
/// the browser is the UI, and the Windows tray (<c>tray\</c>) is just another client of this API. It runs
/// as the user: started at logon (scripts\register-autostart.ps1), or as a Windows service under the
/// user's own account when it has to keep running while nobody is signed in.
/// </summary>
internal static class Program
{
    // Ceiling on a previewed HTML document we will hold in memory to append the scroll bridge to.
    // Buffering costs twice this — the file, then the copy with the tag on the end — and both land
    // on the large-object heap, with nothing limiting how many previews load at once. 8 MB is still
    // far above any page a person reads; past it the file is streamed unbridged (see the endpoint).
    private const long MaxBridgedDocument = 8L * 1024 * 1024;

    // No [STAThread], on purpose: SystemEvents (below) only creates its hidden window on a thread of its
    // own — one that pumps messages — when the thread that first touches it is MTA. On an STA thread it
    // would put the window here, where nothing pumps, and a logoff would never be heard.
    private static void Main(string[] args)
    {
        // Install the runtime-wide crash handlers before anything else runs, so any fault during
        // startup (or later, on a background thread) is written to crash.log instead of vanishing.
        CrashHandler.Install(LogDirectory());

        var isService = OperatingSystem.IsWindows() && WindowsServiceHelpers.IsWindowsService();
        var contentRoot = ResolveContentRoot();
        var port = GetPort(contentRoot);
        // Where a person gets sent: the local loopback, unless Server:PublicUrl names an externally
        // reachable hostname. Clients read it from the instance file; a second launch opens it.
        var openUrl = ResolveOpenUrl(contentRoot, port);

        // Single instance: a second launch just opens the UI and exits. (A service can't collide with
        // itself — the SCM runs one — and has no desktop to open a browser on.)
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
            // Hooks:Force overrides the "another instance is live on the registered port" guard —
            // see ClaudeHookStore.EnsureConfigured.
            Sessions.ClaudeHookStore.EnsureConfigured(
                port, hookLog, app.Configuration.GetValue("Hooks:Force", false));
        }

        // Freeze the session state file the moment anything says we're going down, so the entries stay
        // marked as running and are there to be matched against the live pty hosts on the next start.
        // ApplicationStopping covers a service stop, the tray's Stop server, the updater and Ctrl+C.
        // SessionEnding covers shutdown/logoff for a daemon started at logon, which the host never hears
        // about any other way (no console, no SCM) — and it matters, because a Windows shutdown kills the
        // claude children before we get there, and each of those deaths would otherwise persist "not
        // running". A service gets its stop from the SCM instead.
        {
            var sessionManager = app.Services.GetRequiredService<SessionManager>();
            app.Lifetime.ApplicationStopping.Register(sessionManager.BeginShutdown);
            if (!isService && OperatingSystem.IsWindows())
                Microsoft.Win32.SystemEvents.SessionEnding += (_, _) => sessionManager.BeginShutdown();
        }

        var resumeSessions = app.Configuration.GetValue("Sessions:ResumeOnStart", true);
        if (args.Contains("--resume-sessions", StringComparer.OrdinalIgnoreCase)) resumeSessions = true;
        if (args.Contains("--no-resume-sessions", StringComparer.OrdinalIgnoreCase)) resumeSessions = false;

        // Startup session recovery, in two steps that must happen in this order:
        //
        //   1. RE-ATTACH to every session whose pty host is still running. An in-app update, a
        //      redeploy, a stop of this daemon or a crash leaves those alive, and they come back with
        //      their scrollback and their in-flight conversation intact — no relaunch, no --resume.
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
            // launches, neither of which may hold up the host's startup (or the service's start
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

        // The port of the instance file this run wrote, if it wrote one (see OnStarted).
        int? instancePort = null;
        app.Lifetime.ApplicationStarted.Register(() => instancePort = OnStarted(app, port, openUrl));

        // Blocks until the host stops, then disposes it. Disposal runs SessionManager.Dispose(), which
        // only DETACHES from each session's pty host — the claude processes are meant to keep running
        // past a stop of this daemon and be re-attached on the next start.
        app.Run();

        // Release the single-instance lock, then remove the instance file — in that order, and only now that
        // the host is fully disposed. A client offers to start a server the moment the file is gone, and a
        // start that still met the lock would just open a browser and exit. (Delete checks the pid, so a
        // daemon that took the lock in between keeps its own file.)
        mutex?.Dispose();
        if (instancePort is { } written) DaemonInstance.Delete(written, Environment.ProcessId);
    }

    /// <summary>
    /// The host is listening. Publish the instance file the tray (or anything else local) finds this daemon
    /// by, then say who we are running as — the first thing to read when sessions misbehave.
    /// </summary>
    /// <returns>The port the instance file was written for; null when none was.</returns>
    private static int? OnStarted(WebApplication app, int port, string openUrl)
    {
        var loggers = app.Services.GetRequiredService<ILoggerFactory>();
        CrashHandler.AttachLogger(loggers.CreateLogger("Crash"));
        var log = loggers.CreateLogger("Startup");
        log.LogInformation("ClaudeWeb started on port {Port}. Logs: {LogDir} (crash log: {CrashLog}).",
            port, LogDirectory(), CrashHandler.CrashLogPath);

        // The instance file first, and on its own: it is what the tray is waiting for.
        int? written = null;
        var local = LoopbackUrl(app.Urls);
        if (local is null)
        {
            log.LogWarning("No instance file written: none of {Urls} is reachable on loopback, and a local client only " +
                           "sends its token to this machine. Include 0.0.0.0 or a loopback address in Server:Urls.",
                string.Join(", ", app.Urls));
        }
        else
        {
            try
            {
                using var me = Process.GetCurrentProcess();
                new DaemonInstance(
                    Environment.ProcessId,
                    local.Port,
                    LocalUrl: local.GetLeftPart(UriPartial.Authority),
                    OpenUrl: openUrl,
                    Token: app.Services.GetRequiredService<TokenStore>().LocalToken,
                    ExePath: Environment.ProcessPath,
                    BuildId: app.Services.GetRequiredService<Update.UpdateService>().Status.Current?.BuildId,
                    StartedAt: new DateTimeOffset(me.StartTime)).Write();
                written = local.Port;
            }
            catch (Exception ex)
            {
                log.LogWarning(ex, "Could not write {InstanceFile}; the tray won't find this daemon.", DaemonInstance.PathFor(local.Port));
            }
        }

        // Off the startup thread: it walks PATH, and an entry on a share that isn't there can take seconds a
        // lookup — while the other startup callbacks, session adoption among them, wait their turn.
        var claudeExecutable = app.Services.GetRequiredService<SessionManagerOptions>().ClaudeExecutable;
        _ = Task.Run(() =>
        {
            try
            {
                var environment = EnvironmentReport.Collect(claudeExecutable);
                log.LogInformation("Environment: {Summary}", environment.Summary());
                foreach (var problem in environment.Problems) log.LogWarning("Environment: {Problem}", problem);
            }
            catch (Exception ex) { log.LogWarning(ex, "Could not collect the environment report."); }
        });
        return written;
    }

    /// <summary>
    /// A loopback URL this host is really listening on, taken from the addresses it bound rather than
    /// assumed from the configured port: the instance file's token goes wherever this points, so it has to
    /// be this process. A wildcard binding (0.0.0.0, [::]) answers on loopback too. Null when every binding
    /// is some other specific address.
    /// </summary>
    private static Uri? LoopbackUrl(IEnumerable<string> addresses)
    {
        foreach (var address in addresses)
        {
            if (!Uri.TryCreate(address, UriKind.Absolute, out var uri)) continue;
            var host = uri.IsLoopback ? uri.Host
                : uri.Host == "0.0.0.0" ? "127.0.0.1"
                : uri.Host == "[::]" ? "[::1]"
                : null;
            if (host is not null) return new UriBuilder(uri) { Host = host }.Uri;
        }
        return null;
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
        var scheduleOptions = builder.Configuration.GetSection("Schedules").Get<ScheduleOptions>() ?? new ScheduleOptions();

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
        // Session templates: named launch presets (project, folder, prompt template) for the errands
        // that come back — the New Session dialog's Templates tab starts sessions from them.
        builder.Services.AddSingleton<TemplateStore>();
        // Schedules: a template plus a clock. The service is the only thing in the app that starts a
        // session without someone asking for one, so it lives here rather than in an external cron —
        // that is what lets a schedule survive a reboot and still be editable from a phone.
        builder.Services.AddSingleton(scheduleOptions);
        builder.Services.AddSingleton<ScheduleStore>();
        builder.Services.AddSingleton<ScheduleService>();
        builder.Services.AddHostedService(sp => sp.GetRequiredService<ScheduleService>());
        // Shell tabs: a plain interactive shell (cmd/PowerShell/Git Bash/WSL) in a session's folder,
        // on its own pty hosts so a build left running survives a restart of this app.
        builder.Services.AddSingleton<Sessions.Shells.ShellManager>();
        // Extra folders attached to a session's working directory, browsable from its Files panel.
        builder.Services.AddSingleton<LinkedFolderStore>();
        // Reads the title, icon and — the part a browser is not allowed to see — the framing policy of
        // a web page a session links to. The links themselves are UI state; only this needs a server.
        builder.Services.AddSingleton<Web.LinkProbeService>();
        // Short-lived, folder-scoped tickets that let a previewed HTML page load the images and
        // stylesheets sitting next to it, without handing the page anything else (see the store).
        builder.Services.AddSingleton<Web.PreviewTicketStore>();
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

        // Who this daemon is running as, and whether claude's files are where that identity looks for
        // them — the report it also logs at startup (see EnvironmentReport). Behind auth: it names paths.
        app.MapGet("/api/health/environment", (SessionManagerOptions options) =>
            Results.Ok(EnvironmentReport.Collect(options.ClaudeExecutable)));

        // Shut the daemon down. Its sessions keep running in their pty hosts and are re-attached on the
        // next start. Only the local token may ask — it is the tray's Stop server — because a browser
        // that stopped the daemon would be left with nothing to start it again from, auth or no auth.
        // Answered before stopping, so the caller hears back.
        app.MapPost("/api/daemon/stop", (HttpContext ctx, TokenStore tokens, IHostApplicationLifetime lifetime, ILoggerFactory lf) =>
        {
            if (!tokens.IsLocalToken(TokenAuthMiddleware.ExtractToken(ctx.Request)))
                return Results.Json(new { error = "only a local client can stop the server" }, statusCode: StatusCodes.Status403Forbidden);
            lf.CreateLogger("Daemon").LogInformation("Stopping: requested by a local client.");
            _ = Task.Run(async () =>
            {
                await Task.Delay(500);
                lifetime.StopApplication();
            });
            return Results.Accepted();
        });

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
        //
        // Every socket runs until the client leaves OR the app stops (SocketLifetime). Kestrel lets the
        // host stop only once in-flight requests finish, and a socket never finishes on its own — so
        // tied to the request alone, one open tab (or the tray) held every stop for the host's whole
        // shutdown timeout, 30 s. Ending them on stop is also how the viewers find out straight away.
        app.Map("/hub/events", async (HttpContext ctx, SessionHub hub, IHostApplicationLifetime lifetime) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            using var life = SocketLifetime(ctx, lifetime);
            // ?client=tray marks a status client: connected all logon, but only drawing on demand.
            await hub.ServeAsync(ws, ctx.Request.Query["client"] == "tray", life.Token);
        });

        // Live terminal stream for a session. Under /hub so the existing TokenAuthMiddleware guards
        // it (accepting ?access_token= for the WS handshake) and the vite dev proxy forwards the ws.
        app.Map("/hub/sessions/{id}/terminal", async (string id, HttpContext ctx, SessionManager mgr, IHostApplicationLifetime lifetime) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            var term = mgr.GetTerminal(id);
            if (term is null) { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            using var life = SocketLifetime(ctx, lifetime);
            await Sessions.Pty.TerminalSocket.PumpAsync(ws, term, life.Token,
                ctx.RequestServices.GetService<ILoggerFactory>()?.CreateLogger("ClaudeWeb.Terminal"));
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
            // Launching one session under another is what new-claude-child-session.ps1 does, and the
            // id it nests under comes from a script's environment. A stale one would otherwise be
            // written as a link to nothing and the session would come out at the top level, looking
            // like the request was honoured — so it is refused here, where the caller can still see why.
            // A live one puts the new session in its host's virtual folder too; see CreateAsync.
            if (!string.IsNullOrWhiteSpace(req.NestedUnderId) && !mgr.Exists(req.NestedUnderId))
                return Results.BadRequest(new { error = $"No session '{req.NestedUnderId}' to put this one under." });
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
        // records its parent so the UI can nest it underneath, and is filed into the same project and
        // virtual folder as the session it branched from.
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

        // Stop the process but keep the session: it stays in the list as a closed session, in the
        // project and folder it belongs to, ready to be reopened — or removed, which is what DELETE
        // below still does. Its shell tabs go with the process: they are terminals opened inside this
        // session's workspace, and a reopen mints a new session id for them to belong to anyway.
        app.MapPost("/api/sessions/{id}/stop", async (string id, SessionManager mgr, Sessions.Shells.ShellManager shells) =>
        {
            var stopped = mgr.Stop(id);
            await shells.CloseForSessionAsync(id);
            return stopped is null ? Results.NotFound() : Results.Ok(stopped);
        });

        // Remove the session from the list altogether, saving it as a "recent" launch preset on the
        // way out. Stops the process first when one is still running — closing a live session in one
        // step is still what the bulk remove and a reopen-as-new do.
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

        // The open shells, narrowed to one session's — or, with ?folder=, to the folder shells opened
        // from the Files tree there. Server-side, so every browser looking at the same thing sees the
        // same tabs.
        app.MapGet("/api/shells", (string? sessionId, string? folder, Sessions.Shells.ShellManager shells) =>
            Results.Ok(shells.List(sessionId, folder)));

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
        app.Map("/hub/shells/{id}/terminal", async (string id, HttpContext ctx, Sessions.Shells.ShellManager shells, IHostApplicationLifetime lifetime) =>
        {
            if (!ctx.WebSockets.IsWebSocketRequest) { ctx.Response.StatusCode = StatusCodes.Status400BadRequest; return; }
            var term = shells.GetTerminal(id);
            if (term is null) { ctx.Response.StatusCode = StatusCodes.Status404NotFound; return; }
            using var ws = await ctx.WebSockets.AcceptWebSocketAsync();
            using var life = SocketLifetime(ctx, lifetime);
            await Sessions.Pty.TerminalSocket.PumpAsync(ws, term, life.Token,
                ctx.RequestServices.GetService<ILoggerFactory>()?.CreateLogger("ClaudeWeb.Terminal"));
        });

        // A socket's lifetime: until the client leaves or the app stops — see the note above /hub/events.
        static CancellationTokenSource SocketLifetime(HttpContext ctx, IHostApplicationLifetime lifetime) =>
            CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, lifetime.ApplicationStopping);

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
            if (SelfCaller(ctx, tokens, lf, "rename") is not { } id)
                return Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);
            // Sanitize up front so an all-whitespace/control-character name is a clear 400 rather than
            // being indistinguishable from an unknown session.
            var clean = ClaudeSession.SanitizeName(body.Name);
            if (clean.Length == 0) return Results.BadRequest(new { error = "name is empty" });
            return mgr.Rename(id, clean) ? Results.Ok(new { id, name = clean }) : Results.NotFound();
        });

        // Self-open: the same deal for the Files panel. A session opens a file of its own working
        // directory as a tab in its own tab bar — the tab a click in the tree would have made — so
        // what Claude is talking about is one click away for whoever is watching. Paths are relative
        // to the working directory (an absolute path inside it is accepted too) and the last one
        // opened becomes the active file tab. The tabs live in the shared UI bag, so the new tab
        // reaches every device the session is open on, not just one browser.
        app.MapPost("/api/self/open", (HttpContext ctx, SelfOpenRequest body, TokenStore tokens,
            SessionManager mgr, ILoggerFactory lf) =>
        {
            if (SelfCaller(ctx, tokens, lf, "open") is not { } id)
                return Results.Json(new { error = "unauthorized" }, statusCode: StatusCodes.Status401Unauthorized);
            if (mgr.Get(id) is not { } info) return Results.NotFound();

            var asked = (body.Path is null ? Enumerable.Empty<string>() : [body.Path])
                .Concat(body.Paths ?? [])
                .Where(p => !string.IsNullOrWhiteSpace(p))
                .ToList();
            if (asked.Count == 0) return Results.BadRequest(new { error = "no path given" });

            // A path that escapes the working directory, or names a folder or something that isn't
            // there, is reported back rather than opened — the panel can only show files of this
            // session's own tree, and a tab pointing at nothing would just fail to load.
            var opened = new List<string>();
            var missing = new List<string>();
            foreach (var p in asked)
            {
                if (SessionFileBrowser.RelativeFile(info.WorkingDirectory, p) is not { } rel) missing.Add(p);
                else if (!opened.Contains(rel, StringComparer.Ordinal)) opened.Add(rel);
            }
            if (opened.Count == 0)
                return Results.BadRequest(new { error = "no such file under the session's folder", missing });

            return mgr.OpenFileTabs(id, opened, body.Pin) is null
                ? Results.NotFound()
                : Results.Ok(new { id, opened, missing, active = opened[^1] });
        });

        // Which session is calling an /api/self endpoint: the id it was launched with, once the hook
        // token it was launched with checks out. Null — and a logged line, because from inside a
        // session this otherwise reads as a bare 401 with nothing to chase — when either is missing or
        // stale. The token is persisted now, so the remaining cause is a session started against a
        // different state directory, or one launched before that changed and still carrying a per-run
        // token that no longer exists.
        static string? SelfCaller(HttpContext ctx, TokenStore tokens, ILoggerFactory lf, string what)
        {
            var id = ctx.Request.Headers["X-Session-Id"].ToString();
            if (id.Length > 0 && tokens.IsValidHookToken(ctx.Request.Headers["X-Hook-Token"].ToString()))
                return id;
            lf.CreateLogger("SelfApi").LogWarning(
                "Self-{What} rejected: stale or missing X-Hook-Token/X-Session-Id from session {Id}", what, id);
            return null;
        }

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

        // Send one message to a session's Claude, as typing it into the terminal would. The browser
        // has always been able to do this over the terminal socket; this is the same thing for
        // everything that isn't a browser — the scheduler, and anything driving a session from a
        // script. Text only: an image rides the socket as a path after an upload, which is a
        // conversation between the pane and the session that has no business here.
        app.MapPost("/api/sessions/{id}/message", async (string id, MessageRequest body, SessionManager mgr) =>
            await SendMessage(id, body, mgr));

        // The same thing for automation, behind the API key rather than a browser token — the twin of
        // POST /api/external/sessions, and what makes "start a session, then talk to it" a thing a
        // script can do on its own.
        app.MapPost("/api/external/sessions/{id}/message", async (string id, MessageRequest body, SessionManager mgr) =>
            await SendMessage(id, body, mgr));

        static async Task<IResult> SendMessage(string id, MessageRequest body, SessionManager mgr)
        {
            if (string.IsNullOrWhiteSpace(body.Text))
                return Results.BadRequest(new { error = "Nothing to send." });
            return await mgr.SendMessageAsync(id, body.Text)
                ? Results.Ok()
                : Results.NotFound(new { error = "No running session with that id." });
        }

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

        // ---- Session templates (named launch presets: project, folder, prompt template) ------------
        // Same shape as the projects above — every mutation answers with the whole list, so a client
        // replaces its state from the response rather than patching it.
        app.MapGet("/api/templates", (TemplateStore store) => Results.Ok(store.List()));
        app.MapPost("/api/templates", (SessionTemplatePatch body, TemplateStore store) =>
            store.Create(body) is { } list
                ? Results.Ok(list)
                : Results.BadRequest(new { error = "A template needs a name (and there is a limit on how many)." }));
        // A null name means "leave it alone"; a blank one is a bad request, not a missing template —
        // the store answers null to both, so the name is checked here to keep the two apart.
        app.MapPost("/api/templates/{id}", (string id, SessionTemplatePatch body, TemplateStore store) =>
            body.Name is { } n && string.IsNullOrWhiteSpace(n)
                ? Results.BadRequest(new { error = "A template needs a name." })
                : store.Update(id, body) is { } list ? Results.Ok(list) : Results.NotFound());
        app.MapDelete("/api/templates/{id}", (string id, TemplateStore store) =>
            store.Delete(id) is { } list ? Results.Ok(list) : Results.NotFound());

        // ---- Schedules (a template plus a clock) --------------------------------------------------
        // Same shape again: the whole list comes back from every mutation. The list carries each
        // schedule's next fire time computed server-side, because the client has neither the cron
        // parser nor — after a reboot — any idea when the daemon last ran.
        app.MapGet("/api/schedules", (ScheduleStore store) => Results.Ok(WithNext(store.List())));
        app.MapPost("/api/schedules", (SessionSchedulePatch body, ScheduleStore store) =>
            store.Create(body) is { } list
                ? Results.Ok(WithNext(list))
                : Results.BadRequest(new { error = "A schedule needs a name (and there is a limit on how many)." }));
        app.MapPost("/api/schedules/{id}", (string id, SessionSchedulePatch body, ScheduleStore store) =>
            body.Name is { } n && string.IsNullOrWhiteSpace(n)
                ? Results.BadRequest(new { error = "A schedule needs a name." })
                : store.Update(id, body) is { } list ? Results.Ok(WithNext(list)) : Results.NotFound());
        app.MapDelete("/api/schedules/{id}", (string id, ScheduleStore store, SessionManager mgr) =>
        {
            if (store.Delete(id) is not { } list) return Results.NotFound();
            // The sessions it started stay — they are real work, and deleting the clock is not a
            // statement about them — but they stop claiming a schedule that no longer exists.
            mgr.ForgetSchedule(id);
            return Results.Ok(WithNext(list));
        });
        // Fire one now, without touching its clock: the way to find out whether a schedule does what
        // you meant before leaving it to run at 03:00.
        app.MapPost("/api/schedules/{id}/run", async (string id, ScheduleService schedules) =>
            await schedules.RunNowAsync(id) is { } error
                ? Results.BadRequest(new { error })
                : Results.Ok());

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
        // Arranging a project's boxes — the whole order, not the move that produced it; see
        // ProjectStore.ReorderGroups.
        app.MapPost("/api/projects/{id}/groups/reorder", (string id, GroupOrderRequest body, ProjectStore store) =>
            store.ReorderGroups(id, body.Ids) is { } list ? Results.Ok(list) : Results.NotFound());
        // Filing sessions into one (a null groupId takes them out). It goes through the manager rather
        // than the store because the membership is keyed by the session's conversation, which only the
        // manager can resolve — and because every browser has to be told the session list changed.
        //
        // A list rather than the one session the route used to name: a fork is drawn under the session
        // it branched from, so a branch is filed as a unit, and one call is one write and one push to
        // every browser instead of the rows landing one at a time.
        app.MapPost("/api/sessions/group", (SessionGroupRequest body, SessionManager mgr) =>
        {
            var ids = (body.Ids ?? []).Where(i => !string.IsNullOrWhiteSpace(i)).ToList();
            if (ids.Count == 0) return Results.BadRequest(new { error = "No sessions to file." });
            return mgr.SetGroup(ids, string.IsNullOrWhiteSpace(body.GroupId) ? null : body.GroupId) is { } list
                ? Results.Ok(list)
                : Results.NotFound();
        });

        // Putting a session under another in the list; a blank/absent parent takes it back out to the
        // top level. The same link a fork gets, drawn by hand — see SessionManager.SetParent. A move
        // the list cannot draw (a loop) is the request's fault, not a missing session, so it is told
        // apart from one naming a session that is gone.
        app.MapPost("/api/sessions/{id}/parent", (string id, SessionParentRequest body, SessionManager mgr) =>
        {
            try
            {
                return mgr.SetParent(id, string.IsNullOrWhiteSpace(body.ParentId) ? null : body.ParentId)
                    ? Results.NoContent()
                    : Results.NotFound();
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        // ---- Web Push subscriptions (background notifications when the tab/PWA is closed) ----------
        // The VAPID public key is not secret and is needed before the browser can subscribe, so its
        // config endpoint is on the public allowlist in TokenAuthMiddleware; subscribe/unsubscribe are
        // token-gated like everything else.
        // Null while the stored keypair couldn't be used (see VapidKeyStore.Ephemeral): a device that
        // subscribed against this run's stand-in key would be bound to a private half that disappears
        // with the process, and nothing on either side can detect that afterwards. The client reads a
        // missing key as "push isn't available here", which is exactly what it is until the file is fixed.
        app.MapGet("/api/push/config", (VapidKeyStore vapid) =>
            Results.Ok(new { publicKey = vapid.Ephemeral ? null : vapid.Keys.PublicKey }));
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
            return status.State == UpdateState.Applying
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

        // Mint a preview ticket for the folder a file lives in, so the HTML preview can load that
        // file by URL and let the browser resolve its relative assets the ordinary way. Answers with
        // the ticket and the file's name within the folder — the two halves of the frame's src.
        //
        // This sits on the protected API, unlike the serving endpoint below: asking for a ticket is
        // the privileged half, and using one is not. It takes an absolute path because both viewers
        // already have one.
        //
        // Note what a ticket is NOT: it is not /api/fs/file with a different spelling. That endpoint
        // is equally unconfined but demands the bearer token on every request, and dies when the
        // token is revoked. A ticket is a second credential — bearer-less, shareable, and held by
        // the previewed page itself, which can read it out of location.pathname. So this hands out
        // rather less than the caller's own token already reaches: the root is one folder's subtree,
        // reads only, minus its dotted and hidden entries, and it expires (see PreviewTicketStore
        // and HtmlPreview.IsServable).
        app.MapPost("/api/fs/preview-ticket", (FsPathRequest body, Web.PreviewTicketStore tickets) =>
        {
            var full = Path.GetFullPath(body.Path);
            if (!File.Exists(full)) return Results.NotFound();
            var dir = Path.GetDirectoryName(full);
            if (string.IsNullOrEmpty(dir)) return Results.BadRequest(new { error = "no containing folder" });
            // A file sitting at the top of a volume would otherwise mint a ticket rooted at the
            // whole drive. Nothing legitimate previews out of C:\, and the subtree grant makes the
            // difference between that and an ordinary folder enormous.
            if (Path.GetPathRoot(dir)!.Equals(dir, StringComparison.OrdinalIgnoreCase))
                return Results.BadRequest(new { error = "cannot preview from a drive root" });
            return Results.Ok(new { ticket = tickets.Mint(dir), name = Path.GetFileName(full) });
        });

        // Serve a ticketed folder to the HTML preview frame. The frame loads its document from here
        // by URL, so a relative src in the page resolves against this path the way it would in any
        // browser and arrives back here as an ordinary subresource GET — no rewriting of the page,
        // and no asset class left out (stylesheets, fonts, media, whatever a script fetches).
        //
        // Reachable WITHOUT the bearer token (see TokenAuthMiddleware): a frame navigation can't set
        // an Authorization header, and this app authenticates with a token out of localStorage and
        // sets no cookies at all, so nothing rides along on the request. The ticket in the path is
        // the whole credential: 32 random bytes, read-only, covering one folder AND EVERYTHING
        // UNDER IT — it has to reach `./img/logo.png` — less its dotted and hidden entries, which
        // HtmlPreview.IsServable declines so that previewing a page at the top of a repo doesn't
        // hand it .git/config and .env.
        app.MapGet("/api/preview/{ticket}/{**path}", (string ticket, string? path, Web.PreviewTicketStore tickets, HttpContext http) =>
        {
            var root = tickets.Resolve(ticket);
            if (root is null) return Results.NotFound();

            // The sandbox, restated as a header, because the iframe attribute only covers the frame:
            // paste a ticket URL into the address bar and the document would otherwise load as a
            // first-class page at this app's origin, with the run of localStorage — where the bearer
            // token lives — and of the API. `sandbox` is the one CSP directive used, deliberately:
            // it forces an opaque origin however the page was reached, while saying nothing about
            // where the page may load things from, so a preview that pulls webfonts or a CDN script
            // still looks like itself. Harmless on the non-document responses, which ignore it.
            http.Response.Headers.ContentSecurityPolicy = "sandbox allow-scripts allow-forms allow-popups allow-modals";
            http.Response.Headers.XContentTypeOptions = "nosniff";
            // Requests a page makes in CORS mode — webfonts, fetch/XHR — carry `Origin: null` from
            // that opaque origin and are refused without this. (Plain subresource loads, the images
            // and stylesheets this feature exists for, are no-cors and send no Origin at all; they
            // never needed it.) Safe to open to all comers: the endpoint carries no cookies, so `*`
            // grants a reader nothing it couldn't get by requesting the URL directly.
            http.Response.Headers.AccessControlAllowOrigin = "*";
            // The URL is stable per file, so without this a stale heuristically-cached body outlives
            // an edit. The asset branches below still revalidate cheaply — Results.File sends
            // Last-Modified and an ETag — but the document and the bridge go out through
            // Results.Bytes/Results.Text, which send neither, so those two are re-fetched in full on
            // every frame load. They are small, and a preview showing yesterday's page would be a
            // far worse trade.
            http.Response.Headers.CacheControl = "no-cache";

            path ??= "";
            if (path.Equals(Web.HtmlPreview.ScrollBridgePath, StringComparison.OrdinalIgnoreCase))
                return Results.Text(Web.HtmlPreview.ScrollBridge, "text/javascript; charset=utf-8");
            // Nothing else in the reserved namespace exists, and it must not fall through to the
            // disk: a folder really called __cw would otherwise answer here. Matched without regard
            // to case, like the filesystem underneath it, so __CW/ can't walk around the guard.
            if (path.StartsWith(Web.HtmlPreview.ReservedPrefix, StringComparison.OrdinalIgnoreCase))
                return Results.NotFound();

            var full = SessionFileBrowser.ResolveSafe(root, path);
            // ResolveSafe only says the path doesn't *spell* its way out of the root; IsServable is
            // what says it doesn't link its way out, and that it isn't one of the things this ticket
            // was never meant to reach. Both, in that order.
            if (full is null || !File.Exists(full)) return Results.NotFound();
            if (!Web.HtmlPreview.IsServable(root, full)) return Results.NotFound();

            var contentType = Web.HtmlPreview.ContentType(full);
            if (!Web.HtmlPreview.IsHtml(full))
                return Results.File(full, contentType, enableRangeProcessing: true);

            // A document too big to hold in memory goes out whole and unbridged — nothing to
            // scroll-restore is a better failure than nothing to read.
            var length = new FileInfo(full).Length;
            if (length > MaxBridgedDocument)
                return Results.File(full, contentType, enableRangeProcessing: true);

            var document = File.ReadAllBytes(full);
            // A UTF-16 document is served exactly as it arrived, without the charset above and
            // without the bridge: either one visibly wrecks it, and it renders correctly on its own
            // BOM (see HtmlPreview.IsUtf16).
            if (Web.HtmlPreview.IsUtf16(document))
                return Results.File(full, "text/html", enableRangeProcessing: true);

            // Appended as bytes rather than by decoding and re-encoding: the tag is pure ASCII, so
            // it lands correctly on the end of any UTF-8 document without this handler needing an
            // opinion about the text in front of it.
            var tag = System.Text.Encoding.UTF8.GetBytes(Web.HtmlPreview.ScrollBridgeTag(ticket));
            var body = new byte[document.Length + tag.Length];
            document.CopyTo(body, 0);
            tag.CopyTo(body, document.Length);
            return Results.Bytes(body, contentType);
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

        // ---- Web pages linked to a session. The links themselves ride the session's UI bag, like its
        //      open file tabs do; only this needs the server, because the one thing that decides
        //      whether a page can be shown in a tab at all — its framing headers — is invisible to a
        //      browser. See Web/LinkProbe.cs.
        //
        //      This fetches a caller-named URL from the server, so it is an SSRF surface, and
        //      deliberately does not filter private addresses: a self-hosted Jira or wiki on the LAN
        //      is the case it exists for. It reads a title and a set of headers with no credentials
        //      of ours attached, and the caller is already authenticated to an API that launches
        //      processes and reads the whole disk — so it grants nothing that caller did not have.
        //      Keep it that way: never let it forward a request body, a header, or a cookie. --------
        app.MapGet("/api/web/link-probe", async (string url, Web.LinkProbeService probe, CancellationToken ct) =>
            Results.Ok(await probe.ProbeAsync(url, ct)));

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
            if (string.IsNullOrEmpty(body.Path) || !SessionFileBrowser.Delete(root, body.Path))
                return Results.BadRequest(new { error = "could not delete" });
            // A file that was staged but never committed also sits in the index: unlink it alone and
            // the next commit still records it, as a file that isn't there. Drop those entries too.
            return Results.Ok(new { unstaged = GitService.UnstageAdditions(root, body.Path) });
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
        // Answered for a closed session as well as a live one (FolderOf, not Get): the pool outlives
        // the process that stashed it, and its count is on the row either way -- a number the list
        // shows and nothing can open would be a poor joke.
        app.MapGet("/api/sessions/{id}/postponed", (string id, SessionManager mgr) =>
        {
            var dir = mgr.FolderOf(id);
            if (dir is null) return Results.NotFound();
            var json = SessionFileBrowser.ReadTextSafe(dir, PostponedStore.RelPathFor(id));
            return Results.Content(json ?? "[]", "application/json");
        });

        // Writable for a closed session too, for the same reason: discarding a message you are no
        // longer going to send is the other half of being able to read it.
        app.MapPut("/api/sessions/{id}/postponed", async (string id, HttpContext ctx, SessionManager mgr) =>
        {
            var dir = mgr.FolderOf(id);
            if (dir is null) return Results.NotFound();
            using var reader = new StreamReader(ctx.Request.Body);
            var body = await reader.ReadToEndAsync();
            if (body.Length > 512 * 1024) return Results.BadRequest(new { error = "too large" });
            return SessionFileBrowser.WriteBytes(dir, PostponedStore.RelPathFor(id), System.Text.Encoding.UTF8.GetBytes(body)) is not null
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

        // ---- GitHub pull requests for the session's repo (read through the gh CLI) ----
        // Whether the folder is a GitHub repo at all: answered from the git remote, so it costs no
        // network call and can be asked whenever a session opens. It is what decides whether the PR
        // button is in the tab bar.
        app.MapGet("/api/sessions/{id}/github/repo", (string id, SessionManager mgr) =>
        {
            var info = mgr.Get(id);
            return info is null ? Results.NotFound() : Results.Ok(GitHubService.Repo(info.WorkingDirectory));
        });

        // The repo's pull requests. `state` is open (the default), closed, merged or all.
        app.MapGet("/api/sessions/{id}/github/pulls", async (string id, string? state, SessionManager mgr, CancellationToken ct) =>
        {
            var info = mgr.Get(id);
            return info is null
                ? Results.NotFound()
                : Results.Ok(await GitHubService.PullsAsync(info.WorkingDirectory, state, ct));
        });

        // One file of a pull request, read whole at one of the commits the review points at, for the
        // reader who wants the file rather than the change to it. The ref is checked against the two
        // the pull request actually names, so this cannot be pointed at an arbitrary commit.
        app.MapGet("/api/sessions/{id}/github/pulls/{number:int}/file",
            async (string id, int number, string path, string? @ref, SessionManager mgr, CancellationToken ct) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (number <= 0) return Results.BadRequest(new { error = "invalid pull request number" });
            if (string.IsNullOrWhiteSpace(path)) return Results.BadRequest(new { error = "invalid path" });

            var refs = await GitHubService.RefsAsync(info.WorkingDirectory, number, ct);
            if (refs.Error is not null)
                return Results.Ok(new GitHubFileContent(path, @ref ?? "", "", false, refs.Error));
            // Only the head or the base of this very pull request: the client hands back one of the
            // two it was given, and anything else is not a question this endpoint answers.
            var sha = @ref == refs.BaseRefOid ? refs.BaseRefOid : refs.HeadRefOid;
            return Results.Ok(await GitHubService.FileAsync(info.WorkingDirectory, path, sha, ct));
        });

        // One pull request: its description and every changed file, each with its slice of the diff.
        app.MapGet("/api/sessions/{id}/github/pulls/{number:int}", async (string id, int number, SessionManager mgr, CancellationToken ct) =>
        {
            var info = mgr.Get(id);
            if (info is null) return Results.NotFound();
            if (number <= 0) return Results.BadRequest(new { error = "invalid pull request number" });
            return Results.Ok(await GitHubService.PullAsync(info.WorkingDirectory, number, ct));
        });
    }

    /// <summary>
    /// The folder a session may READ through its file API for a requested <paramref name="dir"/>: its own
    /// working directory (empty <paramref name="dir"/>), another worktree of the same repo, or a folder
    /// linked to it. Null when the request names anything else.
    /// </summary>
    /// <summary>
    /// The schedules as the client sees them: the stored record plus the next moment it will fire.
    /// That is computed here rather than in the browser because the cron parser lives on this side,
    /// and because "next" depends on when this schedule last actually ran — which only the daemon
    /// knows after a reboot.
    /// </summary>
    private static object WithNext(IReadOnlyList<SessionSchedule> schedules)
    {
        var now = DateTimeOffset.Now;
        return schedules
            .Select(s =>
            {
                var reason = BlockedReason(s);
                return new
                {
                    Schedule = s,
                    // From the last fire, so a slot already served isn't offered again as the next one.
                    NextFireAt = s.NextOccurrence(s.LastFiredAt is { } last && last <= now ? last : now),
                    Blocked = reason is not null,
                    // *Why* it will never fire, in words. The client cannot work this out: it would
                    // have to parse cron to tell a bad expression from a deleted template, and saying
                    // the wrong one ("its template is gone", about a template sitting right there) is
                    // worse than saying nothing.
                    BlockedReason = reason,
                    // The zone the server will ACTUALLY read the cron in. Not always the one stored:
                    // this app is built with InvariantGlobalization, so an IANA id from a browser
                    // ("Europe/Berlin") does not resolve on Windows and falls back to the machine's
                    // own zone. The editor shows this rather than the stored string, so it cannot
                    // promise an hour that isn't the one that will happen.
                    ResolvedTimeZoneId = SessionSchedule.ResolveZone(s.TimeZoneId).Id,
                };
            })
            .ToArray();
    }

    /// <summary>Why a schedule can never fire as it stands, or null when nothing is stopping it.</summary>
    private static string? BlockedReason(SessionSchedule s) =>
        s.TemplateId is null ? "It has no template."
        : s.IntervalMinutes is null && SessionSchedule.ParseCron(s.Cron) is null
            ? (string.IsNullOrWhiteSpace(s.Cron) ? "It has no clock set." : $"Its schedule “{s.Cron}” is not a valid cron expression.")
        // An interval schedule with nothing to continue never fires and never records a reason for it,
        // which made it the one broken state with no symptom at all.
        : s.Mode == ScheduleMode.ReuseSession && s.TargetConversationId is null ? "It has no session to continue."
        : null;

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

    // Published: exe + wwwroot together → base dir. `dotnet run`: bin has no wwwroot → project dir.
    private static string ResolveContentRoot()
    {
        var baseDir = AppContext.BaseDirectory;
        return Directory.Exists(Path.Combine(baseDir, "wwwroot"))
            ? baseDir
            : Directory.GetCurrentDirectory();
    }

    // The URL a person is sent to — by the tray (through the instance file) and by a second launch.
    // Server:PublicUrl (e.g. a reverse-proxied public hostname) wins when set; otherwise fall back to the
    // local loopback on the bound port. The web host itself still binds to Server:Urls — this only
    // changes where people are sent.
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
/// <summary>Body for <c>POST /api/sessions/{id}/message</c>: the text to send to Claude.</summary>
internal record MessageRequest(string? Text);
/// <summary>Body for <c>POST /api/self/open</c>: the file(s) to open as tabs in the calling session's
/// Files panel, named relative to its working directory (or absolutely, inside it). <c>Path</c> and
/// <c>Paths</c> are both accepted and add up; the last one opened becomes the active tab.
/// <c>Pin</c> (the default) gives each file a tab of its own — false puts it in the single transient
/// "preview" slot that a click in the tree reuses.</summary>
internal record SelfOpenRequest(string? Path, string[]? Paths = null, bool Pin = true);
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
// A project's virtual folders in the order they should be drawn — see ProjectStore.ReorderGroups.
internal record GroupOrderRequest(string[]? Ids);
// The sessions to file into a virtual folder, and which one; a blank/absent group id takes them out
// of the one they are in. Ids is a branch — a session and the forks drawn under it — which is why it
// is a list; filing one session is a list of one.
internal record SessionGroupRequest(string[]? Ids, string? GroupId);
// The session to put this one under; blank/absent takes it out to the top level.
internal record SessionParentRequest(string? ParentId);
internal record FolderCreateRequest(string? Path, string? Dir = null);
internal record FsWriteRequest(string Path, string? Content);
internal record FsPathRequest(string Path);
internal record FsRenameRequest(string Path, string NewName);
internal record ImageUploadRequest(string? DataBase64, string? Ext);
internal record PushSubscribeRequest(string? Endpoint, PushKeys? Keys);
internal record PushKeys(string? P256dh, string? Auth);
internal record PushUnsubscribeRequest(string? Endpoint);
