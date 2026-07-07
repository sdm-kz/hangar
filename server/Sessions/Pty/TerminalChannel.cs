using System.Threading.Channels;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// Owns a <see cref="PtySession"/> and turns its single output stream into a broadcast: a bounded
/// scrollback ring (so late/re-connecting viewers get recent screen state) fanned out to any number
/// of subscribers. Input from any viewer is written back to the one PTY. This gives tmux-attach
/// semantics — a session can be viewed from several browser tabs/devices at once.
/// </summary>
public sealed class TerminalChannel : IDisposable
{
    private const int RingCapacity = 512 * 1024; // recent VT bytes kept for reconnect replay

    private readonly PtySession _pty;
    private readonly ILogger _log;
    private readonly RingBuffer _ring = new(RingCapacity);
    private readonly Dictionary<Guid, ChannelWriter<byte[]>> _subs = new();
    private readonly object _lock = new();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private bool _completed;

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
                lock (_lock)
                {
                    _ring.Append(chunk);
                    foreach (var w in _subs.Values) w.TryWrite(chunk);
                }
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
        await _writeLock.WaitAsync(ct);
        try
        {
            await _pty.Input.WriteAsync(data, ct);
            await _pty.Input.FlushAsync(ct);
        }
        catch (Exception ex) { _log.LogDebug(ex, "PTY write failed for pid {Pid}", _pty.ProcessId); }
        finally { _writeLock.Release(); }
    }

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
