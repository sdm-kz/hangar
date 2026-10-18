using System.Text;
using System.Text.RegularExpressions;
using Hangar.Pty;
using Hangar.PtyHost.Pty;

namespace Hangar.PtyHost;

/// <summary>
/// Watches this host's session and auto-recovers it when it hangs on an API/streaming error banner,
/// by writing "continue" to its PTY. Also derives the on-screen <c>busy</c> / <c>waiting</c> /
/// <c>compacting</c> signals and pushes them, with its own status, to whoever is attached as
/// <c>state</c> control messages.
/// </summary>
/// <remarks>
/// <para>This used to be one <c>WatchdogService</c> in the web app sweeping every session. It lives
/// here now for the reason the whole pty host exists: a session that stalls at 3 a.m. — during an
/// update window, or any other stretch when the web app is down — has to be recovered anyway. The
/// web app is a viewer; nothing about recovery should depend on one being attached.</para>
/// <para>Guardrails are unchanged: never act while Claude is emitting (that covers its own retry),
/// never act while a permission prompt is on screen, rate-limit per session, and give up after
/// <see cref="WatchdogOptions.MaxConsecutive"/> tries — flagging the session for attention instead.</para>
/// <para>Pushing state rather than answering questions is deliberate: the web app's session hub
/// samples busy/waiting about once a second per session, and a synchronous round-trip over the pipe
/// for each of those would be absurd. The client caches whatever arrived last.</para>
/// </remarks>
public sealed class SessionWatchdog
{
    /// <summary>Re-send the state even when nothing changed, so a client can tell live from stalled.</summary>
    private static readonly TimeSpan StateHeartbeat = TimeSpan.FromSeconds(5);

    /// <summary>How often on-screen state is recomputed. The busy window is ~1.5 s, so 1 s keeps up.</summary>
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(1);

    // Shown by Claude Code throughout generation (including the thinking phase, when no PTY output
    // flows and IsBusy can read false) — a reliable "still working, not waiting" signal.
    private static readonly Regex WorkingHint =
        new(@"esc to interrupt", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly TerminalChannel _terminal;
    private readonly WatchdogOptions _options;
    private readonly Action<PtyControl> _push;
    private readonly Regex[] _errorPatterns;
    private readonly Regex[] _promptGuards;
    private readonly byte[] _sendBytes;

    private readonly object _lock = new();
    private bool _enabled;
    private int _consecutive;
    private long _lastContinueTick;
    private string _status = "healthy";

    private readonly object _pushLock = new();
    private string? _lastPushed;
    private long _lastPushTick;

    public SessionWatchdog(TerminalChannel terminal, WatchdogOptions options, bool enabled, Action<PtyControl> push)
    {
        _terminal = terminal;
        _options = options;
        _enabled = enabled;
        _push = push;
        _errorPatterns = Compile(options.ErrorPatterns);
        _promptGuards = Compile(options.PromptGuardPatterns);
        _sendBytes = Encoding.UTF8.GetBytes(options.SendSequence);
    }

    /// <summary>The current view of the session, for the welcome a newly attached client receives.</summary>
    public PtyControl CurrentState()
    {
        var command = _terminal.Command;
        lock (_lock)
            return new PtyControl
            {
                Type = "state",
                Busy = _terminal.IsBusy,
                Waiting = IsAwaitingInput(),
                Compacting = _terminal.IsCompacting,
                WatchdogStatus = _status,
                Enabled = _enabled,
                ShellIntegration = command.Seen,
                CommandRunning = command.Running,
                CommandStartedAt = command.StartedAt,
                CommandEndedAt = command.EndedAt,
                CommandExitCode = command.ExitCode,
                CommandWaiting = command.Waiting,
            };
    }

    /// <summary>Push the state now — a shell command has just started or ended.</summary>
    public void PushNow() => PushState(force: true);

    /// <summary>
    /// Apply a <c>watchdog</c> control message. The web app owns the per-session opt-in (it is
    /// persisted in sessions.json), so it re-sends it on every attach and we simply follow.
    /// </summary>
    public void Configure(bool enabled, bool reset)
    {
        lock (_lock)
        {
            if (!enabled || reset)
            {
                // Disabling, or a manual "Continue" from the UI: back to a clean slate either way.
                _status = "healthy";
                _consecutive = 0;
                if (reset) _lastContinueTick = 0;
            }
            _enabled = enabled;
        }
        HostLog.Info($"Watchdog for this session set to enabled={enabled}{(reset ? " (state reset)" : "")}.");
        PushState(force: true);
    }

    /// <summary>Run until <paramref name="ct"/> is cancelled. One session, so no sweep — just a loop.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        if (!_options.Enabled)
            HostLog.Info("Watchdog disabled by configuration; still reporting on-screen state.");
        else
            HostLog.Info($"Watchdog running (poll {_options.PollIntervalMs}ms, cooldown {_options.CooldownMs}ms, max {_options.MaxConsecutive}).");

        var pollEvery = Math.Max(250, _options.PollIntervalMs);
        long lastCheck = 0;
        using var timer = new PeriodicTimer(Tick);
        while (await SafeWaitAsync(timer, ct))
        {
            // A failure here must never end the loop — that would silently retire both recovery and
            // the state pushes for the life of this session.
            try
            {
                var now = Environment.TickCount64;
                if (_options.Enabled && now - lastCheck >= pollEvery)
                {
                    lastCheck = now;
                    await CheckAsync(ct);
                }
                PushState(force: false);
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex) { HostLog.Warn($"Watchdog tick failed, continuing: {ex.Message}"); }
        }
    }

    private static async Task<bool> SafeWaitAsync(PeriodicTimer timer, CancellationToken ct)
    {
        try { return await timer.WaitForNextTickAsync(ct); }
        catch (OperationCanceledException) { return false; }
    }

    /// <summary>Recompute the pushed state; send it on any change, or every heartbeat regardless.</summary>
    private void PushState(bool force)
    {
        var state = CurrentState();
        var key = $"{state.Busy}|{state.Waiting}|{state.Compacting}|{state.WatchdogStatus}|{state.Enabled}" +
                  $"|{state.CommandRunning}|{state.CommandStartedAt}|{state.CommandEndedAt}|{state.CommandWaiting}";
        // The tick loop and a client's `watchdog` message both land here, on different threads, so the
        // "has it changed since last time" pair is decided under the lock rather than read torn.
        lock (_pushLock)
        {
            var now = Environment.TickCount64;
            if (!force && key == _lastPushed && now - _lastPushTick < StateHeartbeat.TotalMilliseconds) return;
            _lastPushed = key;
            _lastPushTick = now;
        }
        _push(state);
    }

    /// <summary>
    /// Whether the session appears to be waiting on the user — a permission/confirmation dialog or a
    /// numbered selection menu is on screen and Claude isn't emitting. Best-effort: reliable for
    /// dialogs, not for open-ended questions that just idle at the normal input box.
    /// </summary>
    private bool IsAwaitingInput()
    {
        if (_terminal.IsBusy) return false;
        // Only the last handful of lines: a live prompt is the most recent output, so once the answer
        // and Claude's reply append after it the menu scrolls out of this window and stops counting.
        // (RecentText is the stripped output stream and RETAINS overwritten menus — Claude Code redraws
        // via cursor moves, which stripping drops — so a wide window keeps matching an already-answered
        // prompt, which flagged sessions as waiting long after the user replied.)
        var text = Tail(_terminal.RecentText, 15);
        if (WorkingHint.IsMatch(text)) return false; // actively generating — not waiting
        return _promptGuards.Any(r => r.IsMatch(text));
    }

    private async Task CheckAsync(CancellationToken ct)
    {
        bool enabled;
        lock (_lock) enabled = _enabled;
        if (!enabled)
        {
            lock (_lock) { _status = "healthy"; _consecutive = 0; }
            return;
        }

        // Claude is emitting — working normally or auto-retrying. Don't judge or act until it settles.
        if (_terminal.IsBusy) return;

        // Scan roughly the current screen, not the whole 32 KB tail, so a banner from an earlier turn
        // that's still sitting in scrollback can't trigger a spurious continue once Claude has moved
        // on. Kept generous (≥ two screenfuls) so a banner actually on screen is never missed.
        var text = Tail(_terminal.RecentText, Math.Max(50, _terminal.Rows * 2));

        // Guardrail: a permission/confirmation prompt is on screen — never auto-send input.
        if (_promptGuards.Any(r => r.IsMatch(text))) return;

        if (!_errorPatterns.Any(r => r.IsMatch(text)))
        {
            // Idle at a healthy prompt: recovered (or never broke). Clear state.
            lock (_lock) { _consecutive = 0; _status = "healthy"; }
            return;
        }

        var now = Environment.TickCount64;
        lock (_lock)
        {
            if (_lastContinueTick != 0 && now - _lastContinueTick < _options.CooldownMs)
                return; // still cooling down since the last attempt

            if (_consecutive >= _options.MaxConsecutive)
            {
                if (_status != "attention")
                {
                    _status = "attention";
                    HostLog.Warn($"Watchdog gave up after {_consecutive} auto-continue(s); flagging for attention.");
                }
                return;
            }

            _consecutive++;
            _lastContinueTick = now;
            _status = "recovering";
        }

        await _terminal.WriteAsync(_sendBytes, ct);
        int attempt;
        lock (_lock) attempt = _consecutive;
        HostLog.Info($"Watchdog auto-continued the session, attempt {attempt}/{_options.MaxConsecutive}.");
        PushState(force: true);
    }

    /// <summary>Return the last <paramref name="maxLines"/> lines of <paramref name="text"/> (whole string if fewer).</summary>
    private static string Tail(string text, int maxLines)
    {
        int newlines = 0;
        for (int i = text.Length - 1; i >= 0; i--)
            if (text[i] == '\n' && ++newlines == maxLines)
                return text[(i + 1)..];
        return text;
    }

    private static Regex[] Compile(IEnumerable<string> patterns)
    {
        var list = new List<Regex>();
        foreach (var p in patterns)
        {
            try { list.Add(new Regex(p, RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant)); }
            catch (Exception ex) { HostLog.Warn($"Ignoring invalid watchdog pattern '{p}': {ex.Message}"); }
        }
        return list.ToArray();
    }
}
