using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using ClaudeWeb.Server.Sessions;

namespace ClaudeWeb.Server.Tray;

/// <summary>
/// System-tray front end for the in-process web host.
/// Left-click opens the web UI; right-click lists running sessions and offers Exit.
/// </summary>
public sealed class TrayApplicationContext : ApplicationContext
{
    private readonly WebApplication _app;
    private readonly string _url;
    private readonly NotifyIcon _icon;
    private readonly Icon _drawnIcon;

    public TrayApplicationContext(WebApplication app, string url)
    {
        _app = app;
        _url = url;
        _drawnIcon = CreateIcon();

        var menu = new ContextMenuStrip();
        menu.Opening += (_, _) => RebuildMenu(menu); // rebuilt each open so session list is fresh

        _icon = new NotifyIcon
        {
            Icon = _drawnIcon,
            Text = "Claude Web",
            Visible = true,
            ContextMenuStrip = menu,
        };
        _icon.MouseClick += (_, e) =>
        {
            if (e.Button == MouseButtons.Left) OpenUi();
        };

        _icon.BalloonTipTitle = "Claude Web is running";
        _icon.BalloonTipText = $"Click the tray icon to open ({_url}). Right-click for sessions.";
        _icon.ShowBalloonTip(4000);

        // Something inside the app asked the host to stop — today that's the in-app updater, which
        // has already handed the install off to a detached script and needs this process gone so its
        // exe unlocks. Stopping the web host alone would leave the message loop (and the process)
        // running, so mirror the stop into a tray Exit. Marshalled onto the UI thread: the request
        // arrives on a request/background thread, and ExitThread belongs to the loop's own thread.
        _ = _sync.Handle; // force the handle now, on this thread — BeginInvoke needs one to post to
        _stopping = app.Lifetime.ApplicationStopping.Register(() =>
        {
            try { _sync.BeginInvoke(ExitFromHost); }
            catch { /* the loop is already going down */ }
        });
    }

    // A handle owned by the UI thread, purely to marshal onto it. Created here, in the constructor,
    // which still runs on that thread — the tray icon itself has no handle to borrow.
    private readonly Control _sync = new() { Visible = false };

    // Kept so the registration is released when the tray is disposed on the ordinary Exit path.
    private readonly IDisposable _stopping;

    /// <summary>Exit the message loop for a stop the host initiated (so it isn't asked to stop again).</summary>
    private void ExitFromHost()
    {
        _icon.Visible = false;
        ExitThread();
    }

    /// <summary>How many closed sessions the "Recent" submenu lists before it stops.</summary>
    private const int RecentLimit = 20;

    private void OpenUi(string? sessionId = null)
    {
        var target = sessionId is null
            ? _url
            : $"{_url.TrimEnd('/')}/?session={Uri.EscapeDataString(sessionId)}";
        try { Process.Start(new ProcessStartInfo(target) { UseShellExecute = true }); }
        catch { /* no default browser configured */ }
    }

    private void RebuildMenu(ContextMenuStrip menu)
    {
        menu.Items.Clear();

        var open = new ToolStripMenuItem("Open Claude Web", null, (_, _) => OpenUi())
        {
            Font = new Font(menu.Font, FontStyle.Bold),
        };
        menu.Items.Add(open);
        menu.Items.Add(new ToolStripSeparator());

        IReadOnlyCollection<SessionInfo> sessions;
        try { sessions = _app.Services.GetRequiredService<SessionManager>().List(); }
        catch { sessions = Array.Empty<SessionInfo>(); }

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
        {
            menu.Items.Add(new ToolStripMenuItem("No running sessions") { Enabled = false });
        }
        else
        {
            foreach (var s in running) menu.Items.Add(SessionItem(s, "●", duplicated));
        }

        if (closed.Length > 0)
        {
            var recent = new ToolStripMenuItem($"Recent — {closed.Length}");
            foreach (var s in closed.Take(RecentLimit))
            {
                recent.DropDownItems.Add(SessionItem(s, "○", duplicated));
            }
            if (closed.Length > RecentLimit)
            {
                recent.DropDownItems.Add(new ToolStripSeparator());
                recent.DropDownItems.Add(new ToolStripMenuItem(
                    $"{closed.Length - RecentLimit} more — open Claude Web…", null, (_, _) => OpenUi()));
            }
            menu.Items.Add(recent);
        }

        AddOrphansItem(menu);

        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(new ToolStripMenuItem("Exit", null, (_, _) => ExitApp()));
    }

    /// <summary>
    /// Offer to stop pty hosts still running for sessions the app no longer knows about (see
    /// <see cref="PtyOrphanInfo"/>). Only shown when there are any — most of the time there are none,
    /// and a permanently greyed-out entry would just be clutter.
    /// </summary>
    private void AddOrphansItem(ContextMenuStrip menu)
    {
        IReadOnlyCollection<PtyOrphanInfo> orphans;
        try { orphans = _app.Services.GetRequiredService<SessionManager>().ListOrphans(); }
        catch { return; }
        if (orphans.Count == 0) return;

        menu.Items.Add(new ToolStripSeparator());
        var item = new ToolStripMenuItem($"Stop {orphans.Count} orphaned session(s)…", null, (_, _) => StopOrphans(orphans))
        {
            ToolTipText = "Sessions still running that this app no longer tracks:\n"
                + string.Join('\n', orphans.Take(8).Select(o => $"  claude pid {o.ChildPid} — {o.WorkingDirectory}")),
        };
        menu.Items.Add(item);
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

        try
        {
            var mgr = _app.Services.GetRequiredService<SessionManager>();
            var stopped = mgr.StopOrphansAsync().GetAwaiter().GetResult();
            _icon.BalloonTipTitle = "Orphaned sessions stopped";
            _icon.BalloonTipText = $"Stopped {stopped} of {orphans.Count}.";
            _icon.ShowBalloonTip(3000);
        }
        catch (Exception ex)
        {
            MessageBox.Show($"Could not stop them: {ex.Message}", "Stop orphaned sessions",
                MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private ToolStripMenuItem SessionItem(SessionInfo s, string glyph, ISet<string> duplicated)
    {
        var label = duplicated.Contains(s.Name) ? $"{s.Name}  ·  {ShortPath(s.WorkingDirectory)}" : s.Name;
        return new ToolStripMenuItem($"{glyph}  {label}", null, (_, _) => OpenUi(s.Id))
        {
            ToolTipText = s.RemoteControl
                ? $"{s.WorkingDirectory}\nRemote control — control from the Claude Code app"
                : s.WorkingDirectory,
        };
    }

    /// <summary>Last two path segments — enough to tell same-named sessions apart without a long menu.</summary>
    private static string ShortPath(string path)
    {
        var parts = path.TrimEnd('\\', '/').Split('\\', '/', StringSplitOptions.RemoveEmptyEntries);
        return parts.Length <= 2 ? path : string.Join('\\', parts[^2..]);
    }

    private void ExitApp()
    {
        _icon.Visible = false;
        try { _app.StopAsync(TimeSpan.FromSeconds(3)).GetAwaiter().GetResult(); } catch { }
        ExitThread();
    }

    // Draw a small terracotta disc with a white sunburst — no icon asset to ship.
    private static Icon CreateIcon()
    {
        using var bmp = new Bitmap(32, 32);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var bg = new SolidBrush(Color.FromArgb(217, 119, 87));
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
            _stopping.Dispose();
            _sync.Dispose();
            _icon.Dispose();
            _drawnIcon.Dispose();
        }
        base.Dispose(disposing);
    }
}
