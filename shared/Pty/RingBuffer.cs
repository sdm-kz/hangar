namespace ClaudeWeb.Pty;

/// <summary>
/// Fixed-capacity circular byte buffer holding the most recent <c>capacity</c> bytes. Both sides of
/// the pipe keep one: the host for the scrollback it replays to a connecting client, the web app for
/// the recent screen text the watchdog scans.
/// </summary>
public sealed class RingBuffer(int capacity)
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
