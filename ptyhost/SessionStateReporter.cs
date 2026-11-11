using System.Text.RegularExpressions;
using Hangar.Pty;
using Hangar.PtyHost.Pty;

namespace Hangar.PtyHost;

/// <summary>
/// Derives this host's on-screen <c>busy</c> / <c>waiting</c> / <c>compacting</c> signals, and its
/// shell's command state, and pushes them to whoever is attached as <c>state</c> control messages.
/// </summary>
/// <remarks>
/// <para>Pushing state rather than answering questions is deliberate: the web app's session hub
/// samples busy/waiting about once a second per session, and a synchronous round-trip over the pipe
/// for each of those would be absurd. The client caches whatever arrived last.</para>
/// <para>This was once the hang watchdog too, which typed "continue" into a session stuck on an API
/// error. Claude Code retries those errors itself now, and a turn that dies anyway is reported by its
/// <c>StopFailure</c> hook, so only the reporting is left.</para>
/// </remarks>
public sealed class SessionStateReporter
{
    /// <summary>Re-send the state even when nothing changed, so a client can tell live from stalled.</summary>
    private static readonly TimeSpan StateHeartbeat = TimeSpan.FromSeconds(5);

    /// <summary>How often on-screen state is recomputed. The busy window is ~1.5 s, so 1 s keeps up.</summary>
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(1);

    // Shown by Claude Code throughout generation (including the thinking phase, when no PTY output
    // flows and IsBusy can read false) — a reliable "still working, not waiting" signal.
    private static readonly Regex WorkingHint =
        new(@"esc to interrupt", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>
    /// Case-insensitive regexes for a permission/confirmation prompt on screen: any match, while
    /// Claude isn't emitting, and the session is waiting on you. Best-effort — the exact prompt
    /// wording isn't documented, so tighten these against a live session.
    /// </summary>
    private static readonly Regex[] PromptPatterns = Compile(
        // NOTE: do NOT match a bare "❯" — Claude Code's normal input box also renders it, which would
        // make every idle session read as waiting. Match the permission dialog's actual wording /
        // numbered options instead.
        @"Do you want",
        @"❯\s*\d+\.", // the ❯ cursor on a numbered option (works only where the glyph survives)
        // A numbered selection menu: a line starting with the selector — ASCII '>' or the ❯ glyph,
        // which the Latin1-decoded RecentText mangles into non-ASCII bytes — followed by "N." / "N)".
        // Requires a digit after the selector, so it matches a menu but not the normal input box; and
        // requires the selector, so it doesn't match Claude's plain numbered lists (which start "N.").
        @"(?m)^\s{0,4}(?:>|[^\x00-\x7f]{1,4})\s*\d+[.)]\s",
        @"\b1\.\s*Yes\b",
        @"\(y/n\)",
        @"\[y/N\]",
        @"don't ask again");

    private readonly TerminalChannel _terminal;
    private readonly Action<PtyControl> _push;

    private readonly object _pushLock = new();
    private string? _lastPushed;
    private long _lastPushTick;

    public SessionStateReporter(TerminalChannel terminal, Action<PtyControl> push)
    {
        _terminal = terminal;
        _push = push;
    }

    /// <summary>The current view of the session, for the welcome a newly attached client receives.</summary>
    public PtyControl CurrentState()
    {
        var command = _terminal.Command;
        return new PtyControl
        {
            Type = "state",
            Busy = _terminal.IsBusy,
            Waiting = IsAwaitingInput(),
            Compacting = _terminal.IsCompacting,
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

    /// <summary>Run until <paramref name="ct"/> is cancelled. One session, so no sweep — just a loop.</summary>
    public async Task RunAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(Tick);
        while (await SafeWaitAsync(timer, ct))
        {
            // A failure here must never end the loop — that would silently retire the state pushes for
            // the life of this session.
            try { PushState(force: false); }
            catch (Exception ex) { HostLog.Warn($"State tick failed, continuing: {ex.Message}"); }
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
        var key = $"{state.Busy}|{state.Waiting}|{state.Compacting}" +
                  $"|{state.CommandRunning}|{state.CommandStartedAt}|{state.CommandEndedAt}|{state.CommandWaiting}";
        // The tick loop and a shell's command marks both land here, on different threads, so the
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
        foreach (var r in PromptPatterns)
            if (r.IsMatch(text)) return true;
        return false;
    }

    /// <summary>
    /// The last <paramref name="maxLines"/> lines of <paramref name="text"/> (whole string if fewer), as a
    /// slice rather than a copy: this runs every second for every session, mostly against text that
    /// hasn't changed since the last time.
    /// </summary>
    private static ReadOnlySpan<char> Tail(string text, int maxLines)
    {
        int newlines = 0;
        for (int i = text.Length - 1; i >= 0; i--)
            if (text[i] == '\n' && ++newlines == maxLines)
                return text.AsSpan(i + 1);
        return text;
    }

    private static Regex[] Compile(params string[] patterns) =>
        patterns
            .Select(p => new Regex(p, RegexOptions.IgnoreCase | RegexOptions.Compiled | RegexOptions.CultureInvariant))
            .ToArray();
}
