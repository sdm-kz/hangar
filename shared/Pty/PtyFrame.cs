using System.Buffers.Binary;

namespace Hangar.Pty;

/// <summary>Frame kinds on the pty-host pipe. Values are wire constants — never renumber them.</summary>
public enum PtyFrameType : byte
{
    /// <summary>Host to client: raw VT bytes the child printed.</summary>
    Output = 0x01,
    /// <summary>Client to host: raw bytes for the child's stdin.</summary>
    Input = 0x02,
    /// <summary>Either direction: a UTF-8 JSON <see cref="PtyControl"/> message.</summary>
    Control = 0x03,
}

/// <summary>
/// The framing shared by <c>Hangar.PtyHost</c> and the web app: <c>[1 byte type][4 byte LE
/// length][payload]</c> over a byte-mode named pipe. Length-prefixing rather than the pipe's own
/// message mode, so a scrollback replay larger than the pipe buffer still arrives as one frame.
/// </summary>
public static class PtyFrame
{
    /// <summary>Wire protocol version, exchanged in the hello/welcome handshake.</summary>
    public const int Protocol = 1;

    /// <summary>Header size in bytes: the type byte plus the little-endian length.</summary>
    public const int HeaderSize = 5;

    /// <summary>
    /// Refuse anything larger rather than allocating on a corrupt or hostile length. Comfortably above
    /// the 512 KB scrollback replay, which is the biggest legitimate frame.
    /// </summary>
    public const int MaxPayload = 8 * 1024 * 1024;

    /// <summary>
    /// Write one frame. Callers must serialize their writes on a single stream (one interleaved frame
    /// would desynchronize the reader for good) — both sides gate on a semaphore.
    /// </summary>
    public static async ValueTask WriteAsync(Stream stream, PtyFrameType type, ReadOnlyMemory<byte> payload, CancellationToken ct)
    {
        if (payload.Length > MaxPayload)
            throw new ArgumentOutOfRangeException(nameof(payload), $"Frame payload of {payload.Length} bytes exceeds {MaxPayload}.");
        var header = new byte[HeaderSize];
        header[0] = (byte)type;
        BinaryPrimitives.WriteInt32LittleEndian(header.AsSpan(1), payload.Length);
        await stream.WriteAsync(header, ct);
        if (payload.Length > 0)
            await stream.WriteAsync(payload, ct);
        await stream.FlushAsync(ct);
    }

    /// <summary>Pack a frame into a single buffer, for queueing when the write happens elsewhere.</summary>
    public static byte[] Pack(PtyFrameType type, ReadOnlySpan<byte> payload)
    {
        var frame = new byte[HeaderSize + payload.Length];
        frame[0] = (byte)type;
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(1), payload.Length);
        payload.CopyTo(frame.AsSpan(HeaderSize));
        return frame;
    }

    /// <summary>
    /// Read one frame, or null at end of stream (the peer closed the pipe). Throws
    /// <see cref="InvalidDataException"/> on a length we won't allocate for, which the caller treats
    /// like a dropped connection.
    /// </summary>
    public static async ValueTask<PtyFrameData?> ReadAsync(Stream stream, CancellationToken ct)
    {
        var header = new byte[HeaderSize];
        if (!await ReadExactAsync(stream, header, ct)) return null;
        var type = (PtyFrameType)header[0];
        int len = BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(1));
        if (len < 0 || len > MaxPayload)
            throw new InvalidDataException($"Frame length {len} is out of range.");
        var payload = len == 0 ? Array.Empty<byte>() : new byte[len];
        if (len > 0 && !await ReadExactAsync(stream, payload, ct))
            return null; // truncated mid-frame: the peer went away
        return new PtyFrameData(type, payload);
    }

    /// <summary>Fill <paramref name="buffer"/> completely; false if the stream ended first.</summary>
    private static async ValueTask<bool> ReadExactAsync(Stream stream, byte[] buffer, CancellationToken ct)
    {
        int read = 0;
        while (read < buffer.Length)
        {
            int n = await stream.ReadAsync(buffer.AsMemory(read), ct);
            if (n <= 0) return false;
            read += n;
        }
        return true;
    }
}

/// <summary>One decoded frame.</summary>
public readonly record struct PtyFrameData(PtyFrameType Type, byte[] Payload);
