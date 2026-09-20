using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using ClaudeWeb.Pty;

namespace ClaudeWeb.PtyHost.Pty;

/// <summary>
/// Owns a <see cref="PtySession"/> and turns its single output stream into a broadcast: a model of
/// the screen the child has drawn (so a late or re-connecting viewer can be handed that screen)
/// fanned out to any number of subscribers. Input from any viewer is written back to the one PTY.
/// This gives tmux-attach semantics — a session can be viewed from several browser tabs and devices
/// at once, and each of them starts from the same screen.
/// </summary>
/// <remarks>
/// This class used to live in the web app, which made "detach" and "kill" the same thing: the app
/// owned the pseudoconsole, so restarting it took every session down. It is unchanged logic in a new
/// home — the pty host — and the web app now reaches it over a named pipe
/// (<c>ClaudeWeb.Server.Sessions.Pty.PtyHostClient</c>). The screen, the busy heuristic and the
/// <c>/rename</c> · <c>/color</c> · remote-URL sniffers all have to run here: a web app that restarts
/// mid-session must find the screen intact and must not have missed a rename while it was away.
/// </remarks>
public sealed partial class TerminalChannel : IDisposable
{
    private const int RecentCapacity = 32 * 1024; // small tail scanned for on-screen text (watchdog)

    private readonly PtySession _pty;
    // The screen the child has drawn, kept by running its output through a terminal of our own. What
    // an attaching viewer gets is a snapshot of this — see ScreenModel for why a recording of the
    // bytes cannot be replayed, and what that was doing to the scrollback.
    private readonly ScreenModel _screen;
    // A short tail of the most recent raw VT bytes, ANSI-stripped on demand so the watchdog can scan
    // roughly the current screen for an error banner. Kept raw rather than read off the screen model:
    // the watchdog matches on text as it was streamed, which is not quite the text as it was laid out.
    private readonly RingBuffer _recentRaw = new(RecentCapacity);
    private readonly Dictionary<Guid, ChannelWriter<byte[]>> _subs = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _completed;

    // Activity tracking: while Claude works its TUI spinner redraws continuously, so output keeps
    // flowing; at an idle prompt it stops. We treat "output very recently" as busy, but suppress the
    // signal right after input since the TUI echoes keystrokes as output (that's you typing, not Claude).
    // A resize is suppressed for the same reason: it makes Ink repaint the entire frame, and a repaint
    // is output we asked for, not a turn. That one is not hypothetical — the browser deliberately nudges
    // the size (cols-1, then back) on every attach to force exactly that repaint, so without this guard
    // merely opening an idle session reported it busy for a beat and then idle again, which reads
    // downstream as a turn that started and finished on its own.
    private const long OutputWindowMs = 1500; // output seen this recently ⇒ Claude is emitting
    private const long InputGuardMs = 1000;   // ...unless you typed within this window (echo)
    // Has to outlast the output window, not merely match the input guard: the guard must still be up
    // when the repaint's last bytes age out of OutputWindowMs, or busy just flips true the moment it
    // lifts and the blip is delayed rather than removed. The slack is how long a repaint may take and
    // still be covered — a frame that keeps writing past it reopens the window it closes. The cost is
    // paid by the other case: attaching to a session that really is generating leaves its dot dark for
    // this long. That is the better way round, since the terminal itself is right there saying so.
    private const long ResizeGuardMs = OutputWindowMs + 1000;
    // How long a repaint gets to start, and then to finish, inside RepaintAsync.
    private const int RepaintSettleMs = 60;
    private long _lastOutputTick;
    private long _lastInputTick;
    private long _lastResizeTick;
    // Non-zero while a repaint we asked for is in flight. A counter, not a flag: two viewers can
    // attach at once, and the second one finishing must not declare the first one's redraw over.
    private int _repaintDepth;

    /// <summary>True when Claude appears to be actively generating output (not just echoing your typing).</summary>
    public bool IsBusy
    {
        get
        {
            var now = Environment.TickCount64;
            return now - Volatile.Read(ref _lastOutputTick) < OutputWindowMs
                && now - Volatile.Read(ref _lastInputTick) > InputGuardMs
                && now - Volatile.Read(ref _lastResizeTick) > ResizeGuardMs;
        }
    }

    /// <summary>
    /// The most recent on-screen text with ANSI escapes stripped (roughly the current screen).
    /// Used by the watchdog to spot an error banner. Latin1 maps each VT byte 1:1 to a char, so the
    /// visible ASCII survives; computed on demand since only the watchdog poll needs it.
    /// </summary>
    public string RecentText
    {
        get
        {
            byte[] snap;
            lock (_lock) snap = _recentRaw.Snapshot();
            return Vt.Strip(Encoding.Latin1.GetString(snap));
        }
    }

    // Claude prints its Remote Control deep link (…/code/session_<id>) once at startup; we sniff it
    // out of the raw VT stream so the UI can offer an "Open in app" link straight to this session.
    private string? _remoteUrl;
    private string _urlScanTail = ""; // carries a partial URL across the 8 KB read boundary

    /// <summary>The claude.ai deep link for this session, once it has been printed; otherwise null.</summary>
    public string? RemoteUrl { get { lock (_lock) return _remoteUrl; } }

    [GeneratedRegex(@"https://claude\.ai/code/session_[A-Za-z0-9_-]+")]
    private static partial Regex RemoteUrlRegex();

    // ---- /rename sniffing: watch the OUTPUT for Claude's "Session renamed to: <name>" confirmation.
    // Reconstructing the typed line from raw keystrokes is unreliable (the TUI's enhanced input can
    // send keys as escape sequences), so we key off the confirmation line Claude prints instead.
    private string _renameScanTail = "";  // carries a partial confirmation across the read boundary
    private string? _lastRenameSeen;      // dedupe: don't re-fire when the TUI repaints the same line

    /// <summary>
    /// Whether anything has been <em>typed</em> into this session yet.
    ///
    /// A rename (or a colour) is the result of a command someone ran, so nothing that arrives before
    /// the first keystroke can be one. What does arrive before it, on a session started with
    /// --resume or --fork-session, is the parent conversation replayed in full -- and if that
    /// conversation ever ran /rename, the replay carries both the echoed command and its
    /// confirmation, in the exact shape the detector is looking for. A fork of a renamed session was
    /// taking the parent's name back off its own transcript seconds after launch, undoing the name
    /// it had just been given.
    ///
    /// Its own clock, not <see cref="_lastInputTick"/>: that one is what tells IsBusy that a burst of
    /// output is an echo rather than work, and it must go on counting every byte the viewer sends.
    /// This one counts only what a person could have used to run a command.
    /// </summary>
    private bool Typed => Volatile.Read(ref _lastTypedTick) != 0;

    private long _lastTypedTick;
    private int _dropReplayedTail; // set by the first real keystroke, consumed by the sniffers below

    /// <summary>
    /// Input the terminal sent of its own accord rather than something a person typed: the focus
    /// in/out reports (CSI I / CSI O) a pane emits when it is clicked into or away from, and mouse
    /// reports. Clicking about cannot run /rename, and counting it as typing was enough to let a
    /// replayed transcript through -- the click came a beat after launch, while the replay was still
    /// sitting in the scan tail.
    /// </summary>
    private static bool IsTerminalReport(ReadOnlySpan<byte> d) =>
        (d.Length == 3 && d[0] == 0x1b && d[1] == (byte)'[' && (d[2] == (byte)'I' || d[2] == (byte)'O'))
        || (d.Length > 3 && d[0] == 0x1b && d[1] == (byte)'[' && d[2] == (byte)'<'
            && (d[^1] == (byte)'M' || d[^1] == (byte)'m'));

    /// <summary>
    /// Whether everything seen so far is replayed history, and the tails that carry it across reads
    /// should be dropped rather than matched. Called by both sniffers, under the read lock.
    /// </summary>
    private bool ReplayOnly()
    {
        if (!Typed)
        {
            // Not merely ignored -- forgotten. Left in the tail, the replay would still be there to
            // match the moment the first keystroke landed, which is exactly how it got through.
            _renameScanTail = "";
            _colorScanTail = "";
            return true;
        }
        if (Interlocked.Exchange(ref _dropReplayedTail, 0) == 1)
        {
            _renameScanTail = "";
            _colorScanTail = "";
        }
        return false;
    }

    /// <summary>Raised when Claude confirms a <c>/rename</c> in the terminal, with the new name.</summary>
    public event Action<string>? RenameCommandDetected;

    // Only treat "Session renamed to: X" as a real rename when it's the OUTPUT of a genuine "/rename"
    // command, not the phrase appearing in assistant prose. Prose alone (even quoting the exact format,
    // or the regex source of this very detector) used to mis-rename sessions to sentence fragments,
    // because it satisfied a loose "/rename … Session renamed to:" proximity pairing. Two layout facts
    // separate a real result from prose, and we require BOTH:
    //   1. The "/rename" echo and the confirmation each START a line (prose embeds them mid-sentence).
    //   2. The confirmation is a TUI command result, so it's prefixed by a non-ASCII tree marker
    //      ("⎿"/"└") — [^\x00-\x7f] — which assistant markdown never emits. This is the load-bearing
    //      discriminator: plain-ASCII prose (and the ASCII regex source above) can't produce it.
    // Two Latin1 wrinkles on the server: the PTY bytes are decoded Latin1, so a UTF-8 marker like "⎿"
    // arrives as several 0x80-0xFF chars — hence we accept a run of them around the marker; and .NET's
    // \w is Unicode-aware (it would match those marker bytes), so we spell the word class out in ASCII
    // ([^A-Za-z0-9_\r\n]) to keep the marker inside the "non-word leading run". Names can contain spaces
    // AND non-ASCII text, so the name is a lazy run of printable bytes INCLUDING the 0x80-0xFF halves of
    // UTF-8 sequences — capturing printable ASCII alone cut "AB-6463 подписание" down to "AB-6463" at the
    // first Cyrillic byte. It stops at a control byte (the line's own CR/LF), a 2+ space run, or the input
    // prompt ">", which the TUI positions on the next line via cursor moves (the line-aware strip now
    // breaks the line there, but the guard costs nothing and covers a move it doesn't classify, e.g.
    // "main>"). The caller turns those bytes back into text.
    // The gaps inside the confirmation are [ \t]* rather than a literal space on purpose: the TUI draws
    // a word gap by moving the cursor over it (ESC[1C) about as often as it writes a space, and while
    // Vt.Strip now puts those spaces back, this phrase must not go back to matching nothing the next
    // time that rendering changes.
    // Line-anchoring alone stopped being a guard once the strip learned to break lines on cursor moves:
    // an inline `code span` in rendered markdown is drawn between two moves, so prose about this very
    // feature ("run /rename foo") now starts a line as convincingly as a real echo. So the two halves
    // must also AGREE: the echoed argument is captured and back-referenced in the confirmation, and no
    // second /rename may fall between them, which pins the confirmation to its own command rather than
    // to a stray mention several lines above it. The echo must also END the line — a real command line
    // holds nothing but the command.
    [GeneratedRegex(@"(?:^|[\r\n\x1e])[ \t]*[^A-Za-z0-9_\r\n\x1e]{0,12}/rename[ \t]+(?<arg>[\x20-\x7e\x80-\xff]{1,300}?)[ \t]*(?=[\r\n\x1e])(?:(?!/rename)[\s\S]){0,2000}?(?:^|(?<paint>[\r\n\x1e]))[ \t]*[^A-Za-z0-9_\r\n\x1e]{0,15}[^\x00-\x7f][^A-Za-z0-9_\r\n\x1e]{0,8}[ \t]*Session[ \t]*renamed[ \t]*to:[ \t]*\k<arg>(?=[\x00-\x1f]|[ \t]|$)")]
    private static partial Regex RenameConfirmRegex();

    /// <summary>Cheap gate: only run the full pattern when the phrase is somewhere in the buffer.</summary>
    [GeneratedRegex(@"Session[ \t]*renamed[ \t]*to:")]
    private static partial Regex RenamePhraseRegex();

    // ---- /color sniffing: watch the OUTPUT for Claude's "Session color set to: <color>" confirmation.
    // Same approach as /rename above — the typed line is unreliable, so we key off the confirmation.
    private string _colorScanTail = "";  // carries a partial confirmation across the read boundary
    private string? _lastColorSeen;      // dedupe: don't re-fire when the TUI repaints the same line

    /// <summary>Raised when Claude confirms a <c>/color</c> in the terminal, with the new color name.</summary>
    public event Action<string>? ColorCommandDetected;

    // Same discriminators as the rename detector above (line-anchored + a non-ASCII tree marker before
    // the confirmation, ASCII-spelled word class for Latin1 safety, echo and confirmation naming the
    // same color), so the phrase in assistant prose can't set a bogus color — only the genuine "/color"
    // command result does. This session watched it happen: a "/color blue" from a sentence about this
    // feature paired with a real "Session color set to: green" further down the screen, and every
    // repaint re-applied it. Case-insensitive because Claude lowercases the colour it echoes back.
    // A bare "/color" (which picks a random colour) is deliberately NOT matched: with no argument to
    // agree on, it is exactly the shape that prose produces by accident.
    [GeneratedRegex(@"(?:^|[\r\n\x1e])[ \t]*[^A-Za-z0-9_\r\n\x1e]{0,12}/color[ \t]+(?<arg>[A-Za-z]{1,20})[ \t]*(?=[\r\n\x1e])(?:(?!/color)[\s\S]){0,2000}?(?:^|(?<paint>[\r\n\x1e]))[ \t]*[^A-Za-z0-9_\r\n\x1e]{0,15}[^\x00-\x7f][^A-Za-z0-9_\r\n\x1e]{0,8}[ \t]*Session[ \t]*color[ \t]*set[ \t]*to:[ \t]*\k<arg>(?![A-Za-z])",
        RegexOptions.IgnoreCase)]
    private static partial Regex ColorConfirmRegex();

    /// <summary>Cheap gate: only run the full pattern when the phrase is somewhere in the buffer.</summary>
    [GeneratedRegex(@"Session[ \t]*color[ \t]*set[ \t]*to:")]
    private static partial Regex ColorPhraseRegex();

    // Scan freshly-read output for Claude's color confirmation. Returns the new color, or null.
    // Mirrors SniffRename: last match wins, a generous tail is retained across reads, and the same
    // color isn't reported twice in a row (TUI repaints).
    private string? SniffColor(byte[] buf, int n)
    {
        if (ReplayOnly()) return null;
        var text = Vt.Strip(_colorScanTail + Encoding.Latin1.GetString(buf, 0, n), cursorMovesEndLines: true);
        string? color = null;
        var repainted = true;
        if (ColorPhraseRegex().IsMatch(text))
            foreach (Match m in ColorConfirmRegex().Matches(text))
            {
                color = m.Groups["arg"].Value.ToLowerInvariant();
                repainted = IsRepaint(m);
            }
        _colorScanTail = text.Length > 4096 ? text[^4096..] : text;
        if (!string.IsNullOrEmpty(color) && color != _lastColorSeen && !(repainted && _colorsApplied.Contains(color)))
        {
            _lastColorSeen = color;
            Remember(_colorsApplied, color);
            return color;
        }
        return null;
    }

    // ---- compaction sniffing: watch the OUTPUT for Claude's "Compacting conversation…" spinner.
    // Unlike /rename and /color — one-shot confirmations we latch onto — this is a STATE with two
    // edges, and there is nothing to key the closing one off: Claude's hooks fire PreCompact and
    // nothing at all when it finishes. The screen has both edges for free, because the TUI repaints
    // that spinner line for as long as the compaction runs and stops the moment it is done. So we
    // read it as freshness, exactly like IsBusy: stamp a tick whenever the phrase turns up in
    // freshly-read output, and call the session compacting while that stamp is warm. Nothing to
    // clear, and a missed frame costs a moment of the dot rather than a flag stuck on forever.
    private const long CompactWindowMs = 3000; // spinner seen this recently ⇒ still compacting
    private long _lastCompactTick;

    /// <summary>True while Claude is compacting the conversation (auto-compaction or <c>/compact</c>).</summary>
    public bool IsCompacting =>
        Environment.TickCount64 - Volatile.Read(ref _lastCompactTick) < CompactWindowMs;

    // The same discriminator the rename/color detectors rely on, for the same reason: prose can quote
    // the phrase (this comment does), so the line must also START with the TUI's spinner glyph — a
    // non-ASCII char, which the Latin1-decoded stream spreads over several 0x80-0xFF bytes, and which
    // plain-ASCII markdown cannot produce. The glyph cycles (✻ ✽ ✶ ✳ …) so it is matched by class,
    // not by value. Gaps are [ \t]* because the TUI draws a word gap by moving the cursor over it as
    // often as it writes a space, and Vt.Strip turns a cursor-forward back into those spaces.
    [GeneratedRegex(@"(?:^|[\r\n\x1e])[ \t]*[^\x00-\x7f][^A-Za-z0-9_\r\n\x1e]{0,8}Compacting[ \t]*conversation",
        RegexOptions.IgnoreCase)]
    private static partial Regex CompactingRegex();

    // Scan freshly-read output for the spinner line. Called under _lock. Line-aware stripping, for the
    // anchor's sake: this line is repainted, and a repaint opens its row with a cursor move rather than
    // a CRLF, so without CursorBreak standing in for one there is no line start here to anchor to.
    // Unlike the rename/color sniffers we don't then care WHICH kind of break it was — a repainted
    // spinner means the compaction is still on screen and still running, which is the whole question.
    // No tail is carried across the read boundary, unlike the sniffers above. They have to have one:
    // they are watching for a confirmation printed ONCE, so a read that cuts it in half would lose it
    // for good. This line is repainted several times a second for as long as the compaction runs — the
    // elapsed timer and the progress bar in it are what keep changing — so a frame split by a boundary
    // is re-delivered whole a moment later, and all a tail could buy is one frame of latency on a flag
    // that lives for three seconds. What it would cost is a standing hazard: a retained tail long
    // enough to bridge the phrase also CONTAINS the phrase, and would re-stamp the tick on every
    // subsequent read, leaving the session compacting forever.
    private void SniffCompacting(byte[] buf, int n)
    {
        var text = Vt.Strip(Encoding.Latin1.GetString(buf, 0, n), cursorMovesEndLines: true);
        if (CompactingRegex().IsMatch(text))
            Volatile.Write(ref _lastCompactTick, Environment.TickCount64);
    }

    // ---- repaint guard ------------------------------------------------------------------------
    // A command result is not a one-off in the byte stream: the TUI redraws whatever is on screen
    // whenever it repaints (a resize, the input box growing, the transcript scrolling), so an OLD
    // "/color pink" block sitting in the visible transcript is re-emitted, in full, long after a newer
    // "/color cyan" — and the detector, seeing a perfectly well-formed pair, applies pink again. That
    // is what made a session's colour flip back and forth on its own.
    //
    // What separates the two is HOW the confirmation's line began. Output that has just been printed
    // arrives after a CR/LF; a repaint jumps the cursor to the row it is about to redraw, which the
    // strip records as Vt.CursorBreak. So a streamed result is always taken — re-picking a colour this
    // session already used works, which a blanket "first sighting wins" rule got wrong — while a
    // repainted one is only taken for a value the session has never had. The remaining gap is narrow
    // and self-correcting: a genuine result that happens to be painted rather than streamed (the
    // spinner was running, say) is only dropped when it names a colour already used.
    private readonly List<string> _colorsApplied = new();
    private readonly List<string> _namesApplied = new();

    /// <summary>Was this confirmation drawn by a repaint (cursor jump) rather than streamed after a CR/LF?</summary>
    private static bool IsRepaint(Match m)
    {
        var paint = m.Groups["paint"];
        // No group at all means the match sat at the very start of the buffer, with nothing to judge by.
        return !paint.Success || paint.Value[0] == Vt.CursorBreak;
    }

    private static void Remember(List<string> seen, string value)
    {
        seen.Add(value);
        if (seen.Count > 32) seen.RemoveAt(0); // a session that cycles this much has forgotten the old ones anyway
    }

    // Scan freshly-read output for Claude's rename confirmation. Returns the new name, or null.
    // Called under _lock. The name must be newline-terminated so a confirmation split across two
    // reads isn't captured half-formed; the unterminated tail is retained for the next read.
    private string? SniffRename(byte[] buf, int n)
    {
        if (ReplayOnly()) return null;
        // Strip ANSI so styling around the line doesn't break the match (Latin1 keeps ASCII 1:1).
        // Line-aware: the TUI opens the echo's screen row with a cursor move, not a CRLF, and both
        // halves of this pattern are anchored to a line start.
        var text = Vt.Strip(_renameScanTail + Encoding.Latin1.GetString(buf, 0, n), cursorMovesEndLines: true);
        string? name = null;
        var repainted = true;
        if (RenamePhraseRegex().IsMatch(text))
            foreach (Match m in RenameConfirmRegex().Matches(text))
            {
                name = DecodeUtf8(m.Groups["arg"].Value); // last (most recent) confirmation wins
                repainted = IsRepaint(m);
            }
        // Keep a generous tail: the "/rename …" command and its confirmation can span reads, and the
        // regex allows a couple of thousand chars between them — a repaint that redraws the screen
        // between the echo and the result puts that much text in the gap.
        _renameScanTail = text.Length > 4096 ? text[^4096..] : text;
        if (!string.IsNullOrEmpty(name) && name != _lastRenameSeen && !(repainted && _namesApplied.Contains(name)))
        {
            _lastRenameSeen = name;
            Remember(_namesApplied, name);
            return name;
        }
        return null;
    }

    /// <summary>
    /// Turn a capture from the Latin1-decoded stream back into text. Each char there is one PTY byte and
    /// the stream is UTF-8, so re-encoding to bytes and decoding as UTF-8 restores a non-ASCII name.
    /// Drops the TUI's trailing pad spaces, and any replacement char left by a multi-byte sequence that
    /// a read boundary cut in half — the next read re-scans the retained tail and reports the whole name.
    /// </summary>
    private static string DecodeUtf8(string latin1) =>
        Encoding.UTF8.GetString(Encoding.Latin1.GetBytes(latin1)).TrimEnd(' ', '\t', '\uFFFD');

    public int ProcessId => _pty.ProcessId;
    public short Cols { get; private set; } = 120;
    public short Rows { get; private set; } = 30;
    // The size the viewers actually asked for, which is only the same as Cols/Rows outside a repaint:
    // the nudge below parks the pseudoconsole one column off on purpose, and what it has to come back
    // to is whatever was asked for last — not the size it happened to be leaving.
    private short _wantCols = 120;
    private short _wantRows = 30;


    /// <summary>Raised when the child process ends, with its exit code.</summary>
    public event Action<int>? Exited;

    /// <summary>Raised once the claude.ai deep link has been sniffed out of the child's output.</summary>
    public event Action<string>? RemoteUrlDetected;

    private TerminalChannel(PtySession pty, short cols, short rows)
    {
        _pty = pty;
        _screen = new ScreenModel(cols, rows);
        // Surfaced to the host so it can stamp the exit code into the state file and stand down.
        _pty.Exited += code => Exited?.Invoke(code);
    }

    public static TerminalChannel Start(string fileName, IReadOnlyList<string> args, string cwd,
        short cols, short rows, IReadOnlyDictionary<string, string> environment, bool verbatim = false)
    {
        var pty = PtySession.Start(fileName, args, cwd, cols, rows, environment, verbatim);
        var channel = new TerminalChannel(pty, cols, rows) { Cols = cols, Rows = rows };
        // A dedicated blocking-read thread bridges the (synchronous) PTY pipe to async subscribers.
        var t = new Thread(channel.ReadPump) { IsBackground = true, Name = $"pty-read-{pty.ProcessId}" };
        t.Start();
        return channel;
    }

    private void ReadPump()
    {
        var buf = new byte[8192];
        try
        {
            while (true)
            {
                int n = _pty.Output.Read(buf, 0, buf.Length);
                if (n <= 0) break; // EOF: child exited / pseudoconsole closed
                var chunk = new byte[n];
                Array.Copy(buf, chunk, n);
                // Output produced by a repaint we asked for is not the child working, so it does not
                // count towards the activity heuristic. Everything else about it is ordinary output:
                // it still reaches the ring and every viewer, because it IS the screen.
                if (Volatile.Read(ref _repaintDepth) == 0)
                    Volatile.Write(ref _lastOutputTick, Environment.TickCount64);
                string? rename;
                string? color;
                string? url;
                lock (_lock)
                {
                    _screen.Write(chunk);
                    _recentRaw.Append(chunk);
                    foreach (var w in _subs.Values) w.TryWrite(chunk);
                    url = SniffRemoteUrl(buf, n);
                    rename = SniffRename(buf, n);
                    color = SniffColor(buf, n);
                    SniffCompacting(buf, n); // a state, not an event — nothing to raise

                }
                // Fire outside the lock so a handler (which pushes onto the pipe) can't deadlock us.
                if (rename is not null) RenameCommandDetected?.Invoke(rename);
                if (color is not null) ColorCommandDetected?.Invoke(color);
                if (url is not null) RemoteUrlDetected?.Invoke(url);
            }
        }
        catch (Exception ex)
        {
            HostLog.Debug($"PTY read pump ended for pid {_pty.ProcessId}: {ex.Message}");
        }
        finally
        {
            lock (_lock)
            {
                _completed = true;
                foreach (var w in _subs.Values) w.TryComplete();
            }
        }
    }

    // Scan freshly-read bytes for the claude.ai deep link. The URL is contiguous ASCII even when
    // wrapped in OSC-8 hyperlink escapes, but an 8 KB read can split it, so we keep a small tail of
    // the previous scan window and prepend it. Called under _lock; runs only until the URL is found.
    private string? SniffRemoteUrl(byte[] buf, int n)
    {
        if (_remoteUrl is not null) return null;
        // Latin1 maps each byte 1:1 to a char, so byte offsets and the URL's ASCII run are preserved.
        var text = _urlScanTail + Encoding.Latin1.GetString(buf, 0, n);
        var m = RemoteUrlRegex().Match(text);
        if (m.Success)
        {
            _remoteUrl = m.Value;
            _urlScanTail = "";
            HostLog.Info($"Captured Remote Control URL for pid {_pty.ProcessId}: {_remoteUrl}");
            return _remoteUrl;
        }
        // Retain enough of the tail to reconstruct a URL that straddles this read boundary.
        _urlScanTail = text.Length > 256 ? text[^256..] : text;
        return null;
    }

    /// <summary>Attach a viewer: returns the current scrollback plus a live stream of subsequent output.</summary>
    public Subscription Subscribe()
    {
        lock (_lock)
        {
            var replay = _screen.Snapshot();
            // Bounded + DropOldest so a stalled viewer degrades only itself, never the shared reader.
            var ch = System.Threading.Channels.Channel.CreateBounded<byte[]>(
                new BoundedChannelOptions(2048) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = false });
            var id = Guid.NewGuid();
            _subs[id] = ch.Writer;
            if (_completed) ch.Writer.TryComplete();
            // The size goes with the snapshot, taken under the same lock: read afterwards it could
            // be a size the snapshot was not drawn at, and the client would lay it out to the wrong
            // width — which nothing later corrects, because nothing else tells the client the width.
            return new Subscription(replay, Cols, Rows, ch.Reader, () =>
            {
                lock (_lock) _subs.Remove(id);
                ch.Writer.TryComplete();
            });
        }
    }

    public async ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        Volatile.Write(ref _lastInputTick, Environment.TickCount64);
        if (!IsTerminalReport(data.Span))
        {
            // The first keystroke is where the replay ends and this session's own transcript begins.
            if (Volatile.Read(ref _lastTypedTick) == 0) Volatile.Write(ref _dropReplayedTail, 1);
            Volatile.Write(ref _lastTypedTick, Environment.TickCount64);
        }
        await _writeLock.WaitAsync(ct);
        try
        {
            await _pty.Input.WriteAsync(data, ct);
            await _pty.Input.FlushAsync(ct);
        }
        catch (Exception ex) { HostLog.Debug($"PTY write failed for pid {_pty.ProcessId}: {ex.Message}"); }
        finally { _writeLock.Release(); }
    }

    /// <summary>Type text into the terminal as if the user entered it (used to inject a rename command).</summary>
    public void InjectInput(string text) =>
        _ = WriteAsync(Encoding.UTF8.GetBytes(text), CancellationToken.None);

    public void Resize(short cols, short rows)
    {
        cols = Math.Max((short)1, cols);
        rows = Math.Max((short)1, rows);
        lock (_lock)
        {
            _wantCols = cols;
            _wantRows = rows;
        }
        ApplySize(cols, rows);
    }

    /// <summary>
    /// Put the pseudoconsole at a size without recording it as one anybody asked for — the repaint
    /// nudge, which is passing through a size on its way back to the real one.
    /// </summary>
    private void ApplySize(short cols, short rows)
    {
        short wasCols, wasRows;
        bool wanted, drawing;
        lock (_lock)
        {
            if (cols == Cols && rows == Rows) return;
            wasCols = Cols;
            wasRows = Rows;
            // A size somebody asked for, rather than the column the repaint nudge passes through.
            wanted = cols == _wantCols && rows == _wantRows;
            drawing = Environment.TickCount64 - Volatile.Read(ref _lastOutputTick) < 250;
            Cols = cols;
            Rows = rows;
            // The model moves with the pseudoconsole, but only to a size somebody is actually being
            // drawn at. The repaint nudge passes through cols-1 on its way back to the real width,
            // and a narrowing resize costs the model the last column of every row — for a width the
            // child never draws at, and so never redraws.
            if (cols == _wantCols && rows == _wantRows) _screen.Resize(cols, rows);
            // Stamped only for a size that actually changed — the early return above is what makes a
            // same-size resize free, and it must stay free: a viewer that reattaches without changing
            // the size has caused no repaint and should not blind the busy signal for two seconds.
            Volatile.Write(ref _lastResizeTick, Environment.TickCount64);
            // Inside the lock, with the record of it. Two threads resizing at once — the repaint's
            // restore against a viewer's resize — could otherwise write the sizes in one order and
            // move the pseudoconsole in the other, leaving the model and the child disagreeing about
            // the width for as long as the session lasts.
            _pty.Resize(cols, rows);
        }
        // Every real resize, logged. A resize made while the child is drawing costs the session a
        // stale copy of whatever frame was on screen — Ink redraws for the new width and can only
        // erase the rows it still owns, so anything that has scrolled above the viewport keeps the
        // old copy. Nothing here can prevent that; what this line answers is how often it happens and
        // what asked for it, which is the only way to tell a zoom from a second viewer coming and
        // going. The nudge is not logged: it is ours, and it goes straight back.
        if (wanted)
            HostLog.Info($"Resized {wasCols}x{wasRows} -> {cols}x{rows}" +
                         (drawing ? " while the child was drawing (expect a stale frame)." : "."));

        // Outside the lock: the web app keeps a model of its own, fed by the same bytes, and it has
        // to turn at the point in that stream where this one turned rather than when it asked.
        SizeApplied?.Invoke(cols, rows);
    }

    /// <summary>Raised when the pseudoconsole has actually moved, so clients can follow (see above).</summary>
    public event Action<short, short>? SizeApplied;

    /// <summary>
    /// Make the child redraw its whole screen, for a viewer that has just attached.
    ///
    /// It is still a size nudge — a TUI built on Ink redraws when its stdout resizes and on nothing
    /// else, so there is no politer way to ask. What changes is who does it. The browser used to nudge
    /// from outside (cols-1, then back) because a viewer reattaching at the current size gets the
    /// replayed scrollback and no SIGWINCH, leaving the input box unpainted; but from out there a
    /// repaint is indistinguishable from a turn, and the busy heuristic below reads any output as
    /// work. Asked for in here, the burst it produces is known to be a repaint and simply isn't
    /// counted — no guard window, and nothing downstream has to disbelieve a signal after the fact.
    ///
    /// One column, not one row: a row nudge lifts the input box a line and drops it back, which is a
    /// visible jump. Two steps with a gap between them, because a single same-size resize is dropped
    /// by the pseudoconsole and back-to-back ones can coalesce into no SIGWINCH at all.
    /// </summary>
    public async Task RepaintAsync()
    {
        short cols, rows;
        lock (_lock) { cols = _wantCols; rows = _wantRows; }
        if (cols <= 1 || _pty.HasExited) return;

        Interlocked.Increment(ref _repaintDepth);
        try
        {
            ApplySize((short)(cols - 1), rows);
            await Task.Delay(RepaintSettleMs).ConfigureAwait(false);
            // Re-read the wanted size rather than restoring the one captured above: a viewer that
            // resized during the gap has already been applied, and putting the old size back would
            // undo it and leave the pseudoconsole permanently wider than the grid it is drawn into —
            // where every line the TUI writes spills its last cell onto the next row, and Ink, whose
            // model says otherwise, never erases it. That stray character is what this repaint exists
            // to clear, so producing one here is the one thing it must not do.
            lock (_lock) { cols = _wantCols; rows = _wantRows; }
            ApplySize(cols, rows);
            // Hold the "this is a repaint" state until the redraw has actually been emitted. The
            // resize returns as soon as the pseudoconsole has been told; the output follows.
            await Task.Delay((int)(RepaintSettleMs + OutputWindowMs)).ConfigureAwait(false);
        }
        finally { Interlocked.Decrement(ref _repaintDepth); }
    }

    /// <summary>Whether the child has already ended (see <see cref="PtySession.HasExited"/>).</summary>
    public bool HasExited => _pty.HasExited;

    /// <summary>The child's exit code, once it has exited.</summary>
    public int ExitCode => _pty.ExitCode;

    /// <summary>Ends the child and releases the pseudoconsole — see <see cref="PtySession.Dispose"/>.</summary>
    public void Dispose() => _pty.Dispose();

    /// <summary>A viewer's handle: initial <see cref="Replay"/> scrollback then a live <see cref="Reader"/>.</summary>
    public sealed class Subscription(byte[] replay, short cols, short rows, ChannelReader<byte[]> reader, Action unsubscribe) : IDisposable
    {
        public byte[] Replay { get; } = replay;

        /// <summary>The grid the <see cref="Replay"/> snapshot was drawn at.</summary>
        public short Cols { get; } = cols;

        /// <summary>The height the <see cref="Replay"/> snapshot was drawn at.</summary>
        public short Rows { get; } = rows;
        public ChannelReader<byte[]> Reader { get; } = reader;
        public void Dispose() => unsubscribe();
    }
}

