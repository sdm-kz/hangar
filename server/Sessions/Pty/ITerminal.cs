using System.Threading.Channels;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// A session's live terminal, as the web app sees it: a broadcast of the child's VT output with
/// tmux-attach semantics (scrollback replay on connect, any number of concurrent viewers) plus a
/// single writer back to its stdin.
/// </summary>
/// <remarks>
/// This used to be the concrete <c>TerminalChannel</c>, which lived in this process and owned the
/// pseudoconsole — which is what made restarting the app kill every session. The implementation now
/// sits in <c>ClaudeWeb.PtyHost.exe</c> and <see cref="PtyHostClient"/> speaks to it over a named
/// pipe; keeping the shape of the old class as an interface is what let the rest of the app
/// (<see cref="ClaudeSession"/>, <see cref="TerminalSocket"/>, <see cref="SessionManager"/>) carry on
/// almost unchanged.
///
/// <para><see cref="IsBusy"/>, <see cref="IsAwaitingInput"/> and <see cref="WatchdogStatus"/> are
/// cached values the host pushes, not questions asked over the pipe: they are sampled about once a
/// second per session. The screen text they are derived from never leaves the host, which is where
/// the watchdog reads it.</para>
/// </remarks>
public interface ITerminal : IDisposable
{
    /// <summary>Attach a viewer: the current scrollback plus a live stream of everything after it.</summary>
    TerminalSubscription Subscribe();

    /// <summary>
    /// The screen as it stands, as the sequences that reproduce it — the same thing a viewer is given
    /// when it attaches. Asked for again when a viewer has fallen behind and lost output: a gap in a
    /// VT stream is not something a terminal can recover from on its own, and a screen it can be
    /// handed outright is better than any amount of redrawing.
    /// </summary>
    byte[] Snapshot();

    /// <summary>Write to the child's stdin (a keystroke, a paste, the watchdog's recovery sequence).</summary>
    ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct);

    /// <summary>
    /// Ask the child to redraw its whole screen, for a viewer that has just attached — it would
    /// otherwise get the replayed scrollback and no SIGWINCH, leaving the input box unpainted.
    /// Where the host can do this itself the redraw is not counted as activity; against an older
    /// host it falls back to nudging the size from here, which is.
    /// </summary>
    void RequestRepaint();

    /// <summary>The width every viewer is being drawn at — that of the viewer used last.</summary>
    short Cols { get; }

    /// <summary>The height every viewer is being drawn at — that of the viewer used last.</summary>
    short Rows { get; }

    /// <summary>True when Claude appears to be actively generating (not just echoing your typing).</summary>
    bool IsBusy { get; }

    /// <summary>
    /// True while a resize we sent is still expected to be repainting the screen. <see cref="IsBusy"/>
    /// is an output-timing heuristic in the host, and a repaint is a burst of output we asked for —
    /// so the two are indistinguishable without this. See the guard in <c>SessionManager.IsBusy</c>.
    /// </summary>
    bool IsRepaintingAfterResize { get; }

    /// <summary>True when a permission/confirmation prompt appears to be waiting on the user.</summary>
    bool IsAwaitingInput { get; }

    /// <summary>
    /// Whether the child has switched bracketed paste on (DEC mode 2004). Claude Code's TUI does so as
    /// it mounts, so for a session that is the moment its input starts taking a paste. Read off the
    /// screen this app keeps — off Windows, a raw copy of what the child wrote; ConPTY re-renders the
    /// output instead, so nothing relies on this there.
    /// </summary>
    bool AcceptsPaste { get; }

    /// <summary>Milliseconds since the child last wrote anything to its terminal.</summary>
    long MillisSinceOutput { get; }

    /// <summary>The visible screen as plain text, one line per row, as this app's screen model has it.</summary>
    string ScreenText();

    /// <summary>
    /// True when Claude's input box holds text that hasn't been sent. Read off this app's own screen
    /// model when asked, not pushed by the host: see <see cref="ClaudeInputBox"/>.
    /// </summary>
    bool HasInputDraft { get; }

    /// <summary>True while Claude is compacting the conversation (auto-compaction or <c>/compact</c>).</summary>
    bool IsCompacting { get; }

    /// <summary>The watchdog's view of the session: "healthy" | "recovering" | "attention".</summary>
    string WatchdogStatus { get; }

    /// <summary>The claude.ai deep link for this session, once printed; otherwise null.</summary>
    string? RemoteUrl { get; }

    /// <summary>The pid of the process attached to the pseudoconsole.</summary>
    int ProcessId { get; }

    /// <summary>Raised when Claude confirms a <c>/rename</c> in the terminal, with the new name.</summary>
    event Action<string>? RenameCommandDetected;

    /// <summary>Raised when Claude confirms a <c>/color</c> in the terminal, with the new color.</summary>
    event Action<string>? ColorCommandDetected;

    /// <summary>Raised when the session's process ends, with its exit code.</summary>
    event Action<int>? Exited;
}

/// <summary>
/// A viewer's handle: initial <see cref="Replay"/> scrollback then a live <see cref="Reader"/>, plus
/// the size of the grid this particular viewer is showing it in.
/// </summary>
/// <remarks>
/// Sizing belongs to the viewer rather than to the terminal because one pseudoconsole serves all of
/// them, and they are not the same shape. Each says what it can show and when it is being used; the
/// terminal drives the child at the grid of the one used last and tells everyone what it settled on,
/// which is tmux's <c>window-size latest</c>. The rest adapt on their side — letterboxing, or scaling
/// the frame down — and never paint a grid narrower than the child is drawing for, which wraps the
/// last cell of every line onto the front of the next row where a differential TUI never takes it back.
/// </remarks>
public sealed class TerminalSubscription(
    byte[] replay, ChannelReader<byte[]> reader, Action unsubscribe, Action<short, short> resize,
    Action touch, Action claim, Func<bool> takeDropped) : IDisposable
{
    public byte[] Replay { get; } = replay;
    public ChannelReader<byte[]> Reader { get; } = reader;

    /// <summary>
    /// Tell the terminal how big this viewer's grid is. It may settle on something else. A size of
    /// zero withdraws: this viewer is not showing the session at all — its tab is hidden — and a grid
    /// nobody is looking at has no business holding the session down to its width.
    /// </summary>
    public void Resize(short cols, short rows) => resize(cols, rows);

    /// <summary>
    /// Note that this viewer is still there, on anything it sends. A viewer that has gone quiet is
    /// dropped from the sizing: a socket can stay open long after the other end is gone (a phone out
    /// of coverage, a laptop shut), and a session left at the width of a screen nobody is holding is
    /// exactly the state this whole arrangement exists to avoid.
    /// </summary>
    public void Touch() => touch();

    /// <summary>
    /// Note that someone is using the session through this viewer — typing, clicking, opening it — as
    /// opposed to merely having it on a screen. The viewer used last is the one the session is sized
    /// for, so leaving it open on another machine no longer holds this one down to that machine's size.
    /// </summary>
    public void Claim() => claim();

    /// <summary>
    /// Whether this viewer has had output dropped since the last time anyone asked — and clearing the
    /// flag in the asking. A viewer that stops draining (a phone whose tab is frozen, a socket under
    /// backpressure) loses the oldest chunks rather than holding the session up, which leaves a hole
    /// in its VT stream: rows that never arrived, and possibly an escape sequence cut in half. The
    /// repair is a fresh snapshot, and this is how the socket knows to send one.
    /// </summary>
    public bool TakeDropped() => takeDropped();

    /// <summary>
    /// The size the child is actually being drawn at, once it has been worked out: answered whenever
    /// this viewer asks, and pushed to every viewer when another one changes it. A viewer larger than
    /// this letterboxes — it must not paint the extra cells, or it is back to drawing a grid the child
    /// does not have — and a smaller one scales the frame down to fit.
    /// </summary>
    public Action<short, short>? SizeChanged { get; set; }

    public void Dispose() => unsubscribe();
}
