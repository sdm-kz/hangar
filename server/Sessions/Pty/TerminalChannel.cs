using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Channels;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// Owns a <see cref="PtySession"/> and turns its single output stream into a broadcast: a bounded
/// scrollback ring (so late/re-connecting viewers get recent screen state) fanned out to any number
/// of subscribers. Input from any viewer is written back to the one PTY. This gives tmux-attach
/// semantics — a session can be viewed from several browser tabs/devices at once.
/// </summary>
public sealed partial class TerminalChannel : IDisposable
{
    private const int RingCapacity = 512 * 1024; // recent VT bytes kept for reconnect replay
    private const int RecentCapacity = 32 * 1024; // small tail scanned for on-screen text (watchdog)

    private readonly PtySession _pty;
    private readonly ILogger _log;
    private readonly RingBuffer _ring = new(RingCapacity);
    // A short tail of the most recent raw VT bytes, ANSI-stripped on demand so the watchdog can scan
    // roughly the current screen for an error banner without re-processing the whole 512 KB ring.
    private readonly RingBuffer _recentRaw = new(RecentCapacity);
    private readonly Dictionary<Guid, ChannelWriter<byte[]>> _subs = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _completed;

    // Activity tracking: while Claude works its TUI spinner redraws continuously, so output keeps
    // flowing; at an idle prompt it stops. We treat "output very recently" as busy, but suppress the
    // signal right after input since the TUI echoes keystrokes as output (that's you typing, not Claude).
    private const long OutputWindowMs = 1500; // output seen this recently ⇒ Claude is emitting
    private const long InputGuardMs = 1000;   // ...unless you typed within this window (echo)
    private long _lastOutputTick;
    private long _lastInputTick;

    /// <summary>True when Claude appears to be actively generating output (not just echoing your typing).</summary>
    public bool IsBusy
    {
        get
        {
            var now = Environment.TickCount64;
            return now - Volatile.Read(ref _lastOutputTick) < OutputWindowMs
                && now - Volatile.Read(ref _lastInputTick) > InputGuardMs;
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

    /// <summary>Raised when Claude confirms a <c>/rename</c> in the terminal, with the new name.</summary>
    public event Action<string>? RenameCommandDetected;

    // Name is captured as a slug token that stops at the first non-name char (space, newline,
    // box-drawing/spinner glyph). We do NOT require a trailing newline: the TUI leaves the newest
    // confirmation without one (last line, drawn with cursor moves), so requiring one lags a rename
    // behind. The charset also excludes the status/spinner text that can abut the name.
    [GeneratedRegex(@"Session renamed to:\s*([A-Za-z0-9._/-]{1,64})[^A-Za-z0-9._/-]")]
    private static partial Regex RenameConfirmRegex();

    // Scan freshly-read output for Claude's rename confirmation. Returns the new name, or null.
    // Called under _lock. The name must be newline-terminated so a confirmation split across two
    // reads isn't captured half-formed; the unterminated tail is retained for the next read.
    private string? SniffRename(byte[] buf, int n)
    {
        // Strip ANSI so styling around the line doesn't break the match (Latin1 keeps ASCII 1:1).
        var text = Vt.Strip(_renameScanTail + Encoding.Latin1.GetString(buf, 0, n));
        string? name = null;
        foreach (Match m in RenameConfirmRegex().Matches(text))
            name = m.Groups[1].Value; // last (most recent) confirmation wins
        _renameScanTail = text.Length > 256 ? text[^256..] : text;
        if (name is not null && name != _lastRenameSeen)
        {
            _lastRenameSeen = name;
            return name;
        }
        return null;
    }

    public int ProcessId => _pty.ProcessId;
    public short Cols { get; private set; } = 120;
    public short Rows { get; private set; } = 30;

    private TerminalChannel(PtySession pty, ILogger log)
    {
        _pty = pty;
        _log = log;
    }

    public static TerminalChannel Start(string fileName, IReadOnlyList<string> args, string cwd, ILogger log)
    {
        var pty = PtySession.Start(fileName, args, cwd, 120, 30);
        var channel = new TerminalChannel(pty, log);
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
                Volatile.Write(ref _lastOutputTick, Environment.TickCount64);
                string? rename;
                lock (_lock)
                {
                    _ring.Append(chunk);
                    _recentRaw.Append(chunk);
                    foreach (var w in _subs.Values) w.TryWrite(chunk);
                    SniffRemoteUrl(buf, n);
                    rename = SniffRename(buf, n);
                }
                // Fire outside the lock so a handler (which renames the session) can't deadlock us.
                if (rename is not null) RenameCommandDetected?.Invoke(rename);
            }
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "PTY read pump ended for pid {Pid}", _pty.ProcessId);
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
    private void SniffRemoteUrl(byte[] buf, int n)
    {
        if (_remoteUrl is not null) return;
        // Latin1 maps each byte 1:1 to a char, so byte offsets and the URL's ASCII run are preserved.
        var text = _urlScanTail + Encoding.Latin1.GetString(buf, 0, n);
        var m = RemoteUrlRegex().Match(text);
        if (m.Success)
        {
            _remoteUrl = m.Value;
            _urlScanTail = "";
            _log.LogInformation("Captured Remote Control URL for pid {Pid}: {Url}", _pty.ProcessId, _remoteUrl);
            return;
        }
        // Retain enough of the tail to reconstruct a URL that straddles this read boundary.
        _urlScanTail = text.Length > 256 ? text[^256..] : text;
    }

    /// <summary>Attach a viewer: returns the current scrollback plus a live stream of subsequent output.</summary>
    public Subscription Subscribe()
    {
        lock (_lock)
        {
            var replay = _ring.Snapshot();
            // Bounded + DropOldest so a stalled viewer degrades only itself, never the shared reader.
            var ch = System.Threading.Channels.Channel.CreateBounded<byte[]>(
                new BoundedChannelOptions(2048) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true, SingleWriter = false });
            var id = Guid.NewGuid();
            _subs[id] = ch.Writer;
            if (_completed) ch.Writer.TryComplete();
            return new Subscription(replay, ch.Reader, () =>
            {
                lock (_lock) _subs.Remove(id);
                ch.Writer.TryComplete();
            });
        }
    }

    public async ValueTask WriteAsync(ReadOnlyMemory<byte> data, CancellationToken ct)
    {
        Volatile.Write(ref _lastInputTick, Environment.TickCount64);
        await _writeLock.WaitAsync(ct);
        try
        {
            await _pty.Input.WriteAsync(data, ct);
            await _pty.Input.FlushAsync(ct);
        }
        catch (Exception ex) { _log.LogDebug(ex, "PTY write failed for pid {Pid}", _pty.ProcessId); }
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
            if (cols == Cols && rows == Rows) return;
            Cols = cols;
            Rows = rows;
        }
        _pty.Resize(cols, rows);
    }

    public void Kill() => _pty.Kill();

    public void Dispose() => _pty.Dispose();

    /// <summary>A viewer's handle: initial <see cref="Replay"/> scrollback then a live <see cref="Reader"/>.</summary>
    public sealed class Subscription(byte[] replay, ChannelReader<byte[]> reader, Action unsubscribe) : IDisposable
    {
        public byte[] Replay { get; } = replay;
        public ChannelReader<byte[]> Reader { get; } = reader;
        public void Dispose() => unsubscribe();
    }
}

/// <summary>Fixed-capacity circular byte buffer holding the most recent <c>capacity</c> bytes.</summary>
internal sealed class RingBuffer(int capacity)
{
    private readonly byte[] _data = new byte[capacity];
    private int _start;
    private int _len;

    public void Append(ReadOnlySpan<byte> src)
    {
        int cap = _data.Length;
        if (src.Length >= cap)
        {
            src[^cap..].CopyTo(_data);
            _start = 0;
            _len = cap;
            return;
        }
        int writePos = (_start + _len) % cap;
        int first = Math.Min(src.Length, cap - writePos);
        src[..first].CopyTo(_data.AsSpan(writePos));
        src[first..].CopyTo(_data.AsSpan(0));
        int newLen = _len + src.Length;
        if (newLen > cap)
        {
            _start = (_start + (newLen - cap)) % cap;
            _len = cap;
        }
        else _len = newLen;
    }

    public byte[] Snapshot()
    {
        var outb = new byte[_len];
        int cap = _data.Length;
        int first = Math.Min(_len, cap - _start);
        _data.AsSpan(_start, first).CopyTo(outb);
        _data.AsSpan(0, _len - first).CopyTo(outb.AsSpan(first));
        return outb;
    }
}
