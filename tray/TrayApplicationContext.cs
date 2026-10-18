using System.Diagnostics;
using System.Drawing.Drawing2D;
using System.Text;

namespace Hangar.Tray;

/// <summary>
/// The tray icon. Left-click opens the web UI; right-click lists running sessions and offers orphan cleanup,
/// and keeps the two ways out apart: <b>Exit tray</b> closes only this icon, <b>Stop server</b> stops the
/// daemon. Neither ends a session — a stopping daemon detaches from its pty hosts, and the next one to
/// start re-attaches to them.
/// </summary>
internal sealed class TrayApplicationContext : ApplicationContext
{
    /// <summary>How many closed sessions the "Recent" submenu lists before it stops.</summary>
    private const int RecentLimit = 20;

    /// <summary>How long after starting to wait for a daemon before saying there isn't one.</summary>
    private const int StartupGraceMs = 15_000;

    private readonly DaemonConnection _daemon;
    private readonly NotifyIcon _icon;
    private readonly Icon _onlineIcon;
    private readonly Icon _offlineIcon;
    private readonly System.Windows.Forms.Timer _startupCheck;

    // A handle owned by the UI thread, purely to marshal the connection's background events onto it.
    // Created here, in the constructor, which runs on that thread — the tray icon has no handle to borrow.
    private readonly Control _sync = new() { Visible = false };

    private int? _announcedPid;  // the daemon the "is running" balloon was last shown for
    private bool _hadDaemon;     // whether the previous view had a daemon at all, answering or not
    private bool _stopRequested; // we asked the daemon to stop, so its going away isn't news
    private bool _relaunching;

    public TrayApplicationContext(DaemonConnection daemon)
    {
        _daemon = daemon;
        _onlineIcon = CreateIcon(Color.FromArgb(217, 119, 87));
        _offlineIcon = CreateIcon(Color.FromArgb(150, 150, 150));

        var menu = new ContextMenuStrip();
        menu.Opening += (_, e) =>
        {
            RebuildMenu(menu); // rebuilt on each open, from the latest view — no I/O on the UI thread
            e.Cancel = false;
        };

        _icon = new NotifyIcon
        {
            Icon = _offlineIcon,
            Text = "Hangar — connecting…",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) OpenUi();
        };

        _ = _sync.Handle; // force the handle now, on this thread — BeginInvoke needs one to post to
        _daemon.Changed += () => Post(OnViewChanged);
        _daemon.UpdateApplying += instance => Post(() => StepAsideForUpdate(instance));

        _startupCheck = new System.Windows.Forms.Timer { Interval = StartupGraceMs };
        _startupCheck.Tick += (_, _) =>
        {
            _startupCheck.Stop();
            if (_announcedPid is not null) return;
            if (_daemon.View.Instance is not null)
                Balloon("Hangar server is not responding", "It is running but not answering. The tray keeps trying.");
            else
                Balloon("Hangar server is not running", DaemonExecutable() is null
                    ? "Start ClaudeWeb.exe, or check which port this tray follows (--port)."
                    : "Right-click the tray icon to start it.");
        };
        _startupCheck.Start();
    }

    private void Post(Action action)
    {
        try { _sync.BeginInvoke(action); }
        catch (Exception ex) when (ex is InvalidOperationException or ObjectDisposedException) { /* shutting down */ }
    }

    private void OnViewChanged()
    {
        var view = _daemon.View;
        _icon.Icon = view.Connected ? _onlineIcon : _offlineIcon;
        _icon.Text = view switch
        {
            { Connected: true } => $"Hangar — {view.Sessions.Count(s => s.State == SessionState.Running)} running",
            { Instance: not null } => "Hangar — server not responding",
            _ => "Hangar — server not running",
        };

        if (view is { Connected: true, Instance: { } instance })
        {
            _stopRequested = false;
            // Once per daemon: a reconnect after a moment's silence is the same server, and not news.
            if (_announcedPid != instance.Pid)
                Balloon("Hangar is running", $"Click the tray icon to open ({instance.OpenUrl}). Right-click for sessions.");
            _announcedPid = instance.Pid;
        }
        // Only when the daemon is really gone, not when it merely stopped answering for a moment.
        else if (view.Instance is null && _hadDaemon && !_stopRequested && !_relaunching)
        {
            Balloon("Hangar server stopped",
                "Running sessions keep running. Right-click the tray icon to start the server again.");
        }
        _hadDaemon = view.Instance is not null;
    }

    private void OpenUi(string? sessionId = null)
    {
        if (_daemon.View is not { Connected: true, Instance: { } instance })
        {
            Balloon("Hangar server is not running", "Right-click the tray icon for options.");
            return;
        }
        var url = instance.OpenUrl;
        Browser.Open(sessionId is null ? url : $"{url.TrimEnd('/')}/?session={Uri.EscapeDataString(sessionId)}");
    }

    private void RebuildMenu(ContextMenuStrip menu)
    {
        menu.Items.Clear();
        var view = _daemon.View;
        var bold = new Font(menu.Font, FontStyle.Bold);

        if (!view.Connected)
        {
            menu.Items.Add(new ToolStripMenuItem(view.Instance is null
                ? "Hangar server is not running"
                : "Hangar server is not responding") { Enabled = false });
            if (view.Instance is null && DaemonExecutable() is { } exe)
                menu.Items.Add(new ToolStripMenuItem("Start server", null, (_, _) => StartDaemon(exe)) { Font = bold });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(ExitItem());
            return;
        }

        menu.Items.Add(new ToolStripMenuItem("Open Hangar", null, (_, _) => OpenUi()) { Font = bold });
        menu.Items.Add(new ToolStripSeparator());

        var sessions = view.Sessions;
        // Names repeat a lot (one per repo folder), so disambiguate only where they actually collide.
        var duplicated = sessions
            .GroupBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() > 1)
            .Select(g => g.Key)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var running = sessions.Where(s => s.State == SessionState.Running).ToArray();
        var closed = sessions.Where(s => s.State != SessionState.Running)
            .OrderByDescending(s => s.CreatedAt)
            .ToArray();

        menu.Items.Add(new ToolStripMenuItem($"Running — {running.Length}") { Enabled = false });
        if (running.Length == 0)
            menu.Items.Add(new ToolStripMenuItem("No running sessions") { Enabled = false });
        else
            AddRunningTree(menu, running, view.Projects);

        if (closed.Length > 0)
        {
            var recent = new ToolStripMenuItem($"Recent — {closed.Length}");
            foreach (var s in closed.Take(RecentLimit))
                recent.DropDownItems.Add(SessionItem(s, "○", duplicated.Contains(s.Name)));
            if (closed.Length > RecentLimit)
            {
                recent.DropDownItems.Add(new ToolStripSeparator());
                recent.DropDownItems.Add(new ToolStripMenuItem(
                    $"{closed.Length - RecentLimit} more — open Hangar…", null, (_, _) => OpenUi()));
            }
            menu.Items.Add(recent);
        }

        AddOrphansItem(menu, view.Orphans);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Stop server…", null, (_, _) => StopDaemon())
        {
            ToolTipText = "Stop the Hangar server. Running sessions keep running and are picked up again when it starts.",
        });
        menu.Items.Add(ExitItem());
    }

    private ToolStripMenuItem ExitItem() =>
        new("Exit tray", null, (_, _) => ExitTray())
        {
            ToolTipText = "Close this icon. The server and its sessions keep running.",
        };

    /// <summary>
    /// The running sessions, arranged the way the sidebar's grouped ("tree") view arranges them with
    /// its active-only filter on: folder groups under the project that links them, forks under the
    /// session they were forked from, and nothing on screen that has no running session in it. The
    /// arranging is <see cref="SessionTree"/>'s; all that happens here is rows becoming menu items.
    /// </summary>
    private void AddRunningTree(ContextMenuStrip menu, IReadOnlyCollection<SessionInfo> running, IReadOnlyList<Project> projects)
    {
        foreach (var group in SessionTree.Menu(running, projects))
        {
            if (group.Heading is null)
            {
                foreach (var row in group.Rows) menu.Items.Add(Row(row));
                continue;
            }

            var project = new ToolStripMenuItem($"{group.Heading}  ({group.Count})");
            foreach (var row in group.Rows) project.DropDownItems.Add(Row(row));
            menu.Items.Add(project);
        }
    }

    /// <summary>
    /// One line of the running list. A row with no session is a folder heading — it names a group
    /// rather than pointing at anything, so it is disabled, which is both what greys it out and what
    /// leaves the sessions as the only clickable lines.
    /// </summary>
    private ToolStripMenuItem Row(TreeRow row) =>
        row.Session is { } s ? SessionItem(s, row.Text) : new ToolStripMenuItem(row.Text) { Enabled = false };

    /// <summary>
    /// Offer to stop pty hosts still running for sessions the daemon no longer knows about (see
    /// <see cref="PtyOrphanInfo"/>). Only shown when there are any — most of the time there are none,
    /// and a permanently greyed-out entry would just be clutter.
    /// </summary>
    private void AddOrphansItem(ContextMenuStrip menu, IReadOnlyCollection<PtyOrphanInfo> orphans)
    {
        if (orphans.Count == 0) return;

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem($"Stop {orphans.Count} orphaned session(s)…", null, (_, _) => StopOrphans(orphans))
        {
            ToolTipText = "Sessions still running that this app no longer tracks:\n"
                + string.Join('\n', orphans.Take(8).Select(o => $"  claude pid {o.ChildPid} — {o.WorkingDirectory}")),
        });
    }

    /// <summary>
    /// Confirm, then stop every orphaned host. Each one is a live conversation, so this asks first —
    /// the whole point of the pty host is that sessions are not casually disposable.
    /// </summary>
    private void StopOrphans(IReadOnlyCollection<PtyOrphanInfo> orphans)
    {
        var detail = string.Join(Environment.NewLine, orphans.Take(10).Select(o => $"  •  {o.WorkingDirectory}  (claude pid {o.ChildPid})"));
        if (orphans.Count > 10) detail += $"{Environment.NewLine}  …and {orphans.Count - 10} more";

        var answer = MessageBox.Show(
            $"Stop {orphans.Count} session(s) this app no longer tracks?{Environment.NewLine}{Environment.NewLine}{detail}"
            + $"{Environment.NewLine}{Environment.NewLine}Each is a running claude process. This ends them and cannot be undone.",
            "Stop orphaned sessions",
            MessageBoxButtons.YesNo, MessageBoxIcon.Warning, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        RunInBackground(_daemon.StopOrphansAsync, "Could not stop the orphaned sessions", stopped =>
            Balloon("Orphaned sessions stopped", $"Stopped {stopped} of {orphans.Count}."));
    }

    private void StopDaemon()
    {
        var answer = MessageBox.Show(
            "Stop the Hangar server?" + Environment.NewLine + Environment.NewLine
            + "Running sessions are not stopped: they keep running on their own, and the server picks them up "
            + "again the next time it starts. Until then neither the web UI nor this menu can reach them.",
            "Stop server",
            MessageBoxButtons.YesNo, MessageBoxIcon.Question, MessageBoxDefaultButton.Button2);
        if (answer != DialogResult.Yes) return;

        _stopRequested = true;
        RunInBackground(
            async () => { await _daemon.StopDaemonAsync(); return true; },
            "Could not stop the server",
            _ => Balloon("Hangar server stopped", "Running sessions keep running. Right-click the tray icon to start it again."),
            failed: () => _stopRequested = false); // it is still running, so its going away later is news again
    }

    /// <summary>The daemon beside this exe, where an install puts both — or null in a dev layout, which has none.</summary>
    private static string? DaemonExecutable()
    {
        var exe = Path.Combine(AppContext.BaseDirectory, "ClaudeWeb.exe");
        return File.Exists(exe) ? exe : null;
    }

    private void StartDaemon(string exe)
    {
        try
        {
            Process.Start(new ProcessStartInfo(exe) { UseShellExecute = false, WorkingDirectory = Path.GetDirectoryName(exe)! })?.Dispose();
            TrayLog.Info($"Started {exe} from the tray menu.");
            Balloon("Starting Hangar…", "The icon lights up once the server is ready.");
        }
        catch (Exception ex)
        {
            TrayLog.Error($"Could not start {exe}", ex);
            MessageBox.Show($"Could not start the server: {ex.Message}", "Hangar", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    /// <summary>
    /// The daemon is about to be replaced by an update, and the updater will then mirror the new build over
    /// the install folder — this exe included, which it can't overwrite while this process holds it. So step
    /// aside: hand off to a small detached PowerShell that waits for the old daemon to exit and the new one to
    /// answer, then starts the tray again from the (by then updated) install folder — and exit.
    /// </summary>
    private void StepAsideForUpdate(DaemonInstance instance)
    {
        if (_relaunching) return;
        _relaunching = true;
        try
        {
            if (Environment.ProcessPath is { } exe)
            {
                StartRelauncher(exe, instance);
                TrayLog.Info($"Update in progress: exiting so {exe} can be replaced; it relaunches once the server is back.");
            }
        }
        catch (Exception ex)
        {
            TrayLog.Error("Could not arrange for the tray to come back after the update", ex);
        }
        ExitTray();
    }

    private static void StartRelauncher(string exe, DaemonInstance instance)
    {
        // Only numbers are spliced into the script. The exe path and the URL reach it as environment
        // variables, so no character in them — a quote of any kind — can end a string early and turn the
        // rest of the line into commands. The tray comes back following the same port it follows now.
        var script = $$"""
            $ErrorActionPreference = 'SilentlyContinue'
            $ProgressPreference = 'SilentlyContinue'
            Wait-Process -Id {{instance.Pid}} -Timeout 180
            $deadline = (Get-Date).AddMinutes(10)
            while ((Get-Date) -lt $deadline) {
              try { Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $env:CLAUDEWEB_RELAUNCH_PROBE | Out-Null; break }
              catch { Start-Sleep -Seconds 2 }
            }
            Start-Process -FilePath $env:CLAUDEWEB_RELAUNCH_EXE -ArgumentList '--port', '{{instance.Port}}'
            """;

        // By full path: a bare name is looked up beside this exe first.
        var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var psi = new ProcessStartInfo(powershell)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            // Anywhere but the install folder, which the updater is about to mirror over.
            WorkingDirectory = Path.GetTempPath(),
        };
        psi.Environment["CLAUDEWEB_RELAUNCH_EXE"] = exe;
        psi.Environment["CLAUDEWEB_RELAUNCH_PROBE"] = instance.LocalUrl.TrimEnd('/') + "/api/auth/config"; // public: answers before any login
        foreach (var arg in new[] { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
                                    "-EncodedCommand", Convert.ToBase64String(Encoding.Unicode.GetBytes(script)) })
            psi.ArgumentList.Add(arg);
        Process.Start(psi)?.Dispose();
    }

    /// <summary>
    /// Run a call to the daemon off the UI thread, then report back on it. A failure is logged and shown,
    /// since the user just asked for this and would otherwise see nothing happen.
    /// </summary>
    private void RunInBackground<T>(Func<Task<T>> work, string failure, Action<T> done, Action? failed = null)
    {
        Task.Run(work).ContinueWith(t => Post(() =>
        {
            if (t.IsCompletedSuccessfully)
            {
                done(t.Result);
                return;
            }
            // A request that times out ends Canceled, not Faulted — and is every bit as much a failure.
            var ex = t.Exception?.GetBaseException() ?? new TimeoutException("The server did not answer in time.");
            TrayLog.Error(failure, ex);
            failed?.Invoke();
            MessageBox.Show($"{failure}: {ex.Message}", "Hangar", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }), TaskScheduler.Default);
    }

    /// <param name="showPath">
    /// Append a short path to the name. On in the flat Recent list, where two sessions can share a
    /// name and nothing else says them apart; the running tree doesn't need it, because the heading
    /// above the row already names the folder.
    /// </param>
    private ToolStripMenuItem SessionItem(SessionInfo s, string glyph, bool showPath)
    {
        var label = showPath ? $"{s.Name}  ·  {ShortPath(s.WorkingDirectory)}" : s.Name;
        return SessionItem(s, $"{glyph}  {label}");
    }

    /// <summary>A session row with its text already decided — the tree builds its own.</summary>
    private ToolStripMenuItem SessionItem(SessionInfo s, string text) =>
        new(text, null, (_, _) => OpenUi(s.Id))
        {
            ToolTipText = s.RemoteControl
                ? $"{s.WorkingDirectory}\nRemote control — control from the Claude Code app"
                : s.WorkingDirectory,
        };

    /// <summary>Last two path segments — enough to tell same-named sessions apart without a long menu.</summary>
    private static string ShortPath(string path)
    {
        var parts = path.TrimEnd('\\', '/').Split('\\', '/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length <= 2 ? path : string.Join('\\', parts[^2..]);
    }

    private void Balloon(string title, string text)
    {
        _icon.BalloonTipTitle = title;
        _icon.BalloonTipText = text;
        _icon.ShowBalloonTip(4000);
    }

    private void ExitTray()
    {
        _icon.Visible = false;
        ExitThread();
    }

    // A small disc with a white sunburst — terracotta while connected, grey while not. No icon asset to ship.
    private static Icon CreateIcon(Color disc)
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var bg = new SolidBrush(disc);
            g.FillEllipse(bg, 1, 1, 30, 30);
            using var pen = new Pen(Color.White, 2.4f) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            const float cx = 16, cy = 16, r1 = 3.5f, r2 = 10f;
            for (var i = 0; i < 8; i++)
            {
                var a = i * Math.PI / 4;
                g.DrawLine(pen,
                    (float)(cx + r1 * Math.Cos(a)), (float)(cy + r1 * Math.Sin(a)),
                    (float)(cx + r2 * Math.Cos(a)), (float)(cy + r2 * Math.Sin(a)));
            }
        }
        return Icon.FromHandle(bmp.GetHicon());
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _startupCheck.Dispose();
            _sync.Dispose();
            _icon.Dispose();
            _onlineIcon.Dispose();
            _offlineIcon.Dispose();
        }
        base.Dispose(disposing);
    }
}
