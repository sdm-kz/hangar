using System.Net.WebSockets;
using System.Text.Json;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// Bridges a browser WebSocket to an <see cref="ITerminal"/>. Framing is by opcode:
/// <list type="bullet">
///   <item>server → client: <b>Binary</b> = raw VT output (fed straight to xterm.js).</item>
///   <item>client → server: <b>Binary</b> = raw keystroke/paste bytes → PTY stdin;
///         <b>Text</b> = JSON control, e.g. <c>{"type":"resize","cols":120,"rows":40}</c> (cols/rows of
///         zero mean "hidden — do not count me") or <c>{"type":"ping"}</c>, answered with a
///         <c>{"type":"pong"}</c> text frame.</item>
///   <item>server → client: <b>Text</b> <c>{"type":"size","cols":100,"rows":30}</c> = the size the
///         child is actually drawn at. A resize is a request, not a setting: one pseudoconsole serves
///         every viewer of a session and it is driven at the smallest of their grids, so a viewer
///         bigger than this must letterbox rather than paint cells the child does not have.</item>
/// </list>
/// </summary>
public static class TerminalSocket
{
    public static async Task PumpAsync(WebSocket ws, ITerminal term, CancellationToken hostCt)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(hostCt);
        using var sub = term.Subscribe();
        // A WebSocket allows one outstanding send at a time, and two places send here: the write
        // loop streaming PTY output, and the read loop answering a heartbeat ping. Both go through
        // this gate. Deliberately not disposed — a faulted read loop can leave the write loop mid-
        // send, and disposing under it would turn a client hang-up into an ObjectDisposedException.
        var sendGate = new SemaphoreSlim(1, 1);
        try
        {
            // Pushed when another viewer changes the agreed size, and echoed back whenever this one
            // asks — so the grid here always matches the frame the child is drawing. Fire-and-forget:
            // this runs on whichever viewer's thread did the resizing, and none of them may block on
            // this socket.
            sub.SizeChanged = (cols, rows) => _ = SendSizeAsync(ws, sendGate, cols, rows, cts.Token);

            // 1) Replay recent scrollback so a reconnecting viewer sees current screen state. The size
            // goes first: the replay was drawn at it, and a viewer that renders it in a grid of its
            // own guess wraps every line that overruns, which is a mess it then has to be told to
            // repaint out of.
            await SendSizeAsync(ws, sendGate, term.Cols, term.Rows, cts.Token);
            if (sub.Replay.Length > 0)
                await SendAsync(ws, sendGate, sub.Replay, WebSocketMessageType.Binary, cts.Token);

            // WRITE loop: live PTY output → WS. Swallow every fault (a dropped socket throws various
            // WebSocket/IO exceptions) — this task is awaited below, and a client disconnect must tear
            // down only this viewer, never surface as an unhandled fault.
            var writeLoop = Task.Run(async () =>
            {
                try
                {
                    await foreach (var chunk in sub.Reader.ReadAllAsync(cts.Token))
                    {
                        // This viewer fell behind far enough to lose output — a frozen phone tab, a
                        // socket under backpressure — and a VT stream with a hole in it does not heal:
                        // the rows that went missing never arrive, and an escape sequence cut in half
                        // takes the next few bytes with it. Everything still queued predates the state
                        // we are about to send, so drop it and hand over the screen as it stands.
                        if (sub.TakeDropped())
                        {
                            while (sub.Reader.TryRead(out _)) { }
                            await SendSizeAsync(ws, sendGate, term.Cols, term.Rows, cts.Token);
                            await SendAsync(ws, sendGate, term.Snapshot(), WebSocketMessageType.Binary, cts.Token);
                            continue;
                        }
                        await SendAsync(ws, sendGate, chunk, WebSocketMessageType.Binary, cts.Token);
                    }
                }
                catch { /* cancelled or socket gone — the read loop below handles teardown */ }
            }, cts.Token);

            // READ loop: WS → PTY (input + control).
            var buf = new byte[16 * 1024];
            while (!cts.IsCancellationRequested)
            {
                WebSocketReceiveResult r;
                try { r = await ws.ReceiveAsync(buf, cts.Token); }
                catch (OperationCanceledException) { break; }
                catch (WebSocketException) { break; }

                if (r.MessageType == WebSocketMessageType.Close) break;
                // Anything at all proves this viewer is still on the other end, which is what keeps it
                // counted in the session's size (see TerminalSubscription.Touch).
                sub.Touch();
                if (r.MessageType == WebSocketMessageType.Binary)
                    await term.WriteAsync(buf.AsMemory(0, r.Count), cts.Token);
                else
                    await HandleControlAsync(buf.AsMemory(0, r.Count), term, sub, ws, sendGate, cts.Token);
            }

            cts.Cancel();
            await writeLoop;
        }
        catch (OperationCanceledException) { }
        finally
        {
            sub.SizeChanged = null; // nothing to tell a socket that is going away
            cts.Cancel();
            if (ws.State == WebSocketState.Open)
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        }
    }

    private static readonly JsonSerializerOptions ControlJson = new() { PropertyNameCaseInsensitive = true };

    private static readonly byte[] PongFrame = "{\"type\":\"pong\"}"u8.ToArray();

    /// <summary>Serializes every send on the socket (see the gate's note in PumpAsync).</summary>
    private static async Task SendAsync(
        WebSocket ws, SemaphoreSlim gate, ReadOnlyMemory<byte> data, WebSocketMessageType type, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try { await ws.SendAsync(data, type, true, ct); }
        finally { gate.Release(); }
    }

    /// <summary>Tell this viewer the size the child is drawn at (see the framing note above).</summary>
    private static async Task SendSizeAsync(
        WebSocket ws, SemaphoreSlim gate, short cols, short rows, CancellationToken ct)
    {
        var frame = JsonSerializer.SerializeToUtf8Bytes(new { type = "size", cols, rows });
        try { await SendAsync(ws, gate, frame, WebSocketMessageType.Text, ct); }
        catch { /* socket gone — the read loop will see it next */ }
    }

    private static async Task HandleControlAsync(
        ReadOnlyMemory<byte> json, ITerminal term, TerminalSubscription sub, WebSocket ws, SemaphoreSlim gate,
        CancellationToken ct)
    {
        ControlMessage? msg;
        try { msg = JsonSerializer.Deserialize<ControlMessage>(json.Span, ControlJson); }
        catch { return; /* ignore malformed control frames */ }

        switch (msg)
        {
            // What this viewer can show, not what the session becomes: the terminal answers with the
            // size it settled on across every viewer, which may be smaller.
            case { Type: "resize" }:
                sub.Resize((short)msg.Cols, (short)msg.Rows);
                break;
            // "I have attached and my screen is blank below the scrollback — draw it." The viewer used
            // to arrange this itself by sending two resizes it did not want, which from out there is
            // indistinguishable from the child working. Asking for it by name lets the layer that
            // performs the redraw be the one that knows not to count it.
            case { Type: "repaint" }:
                term.RequestRepaint();
                break;
            // Liveness probe. A browser can't send a protocol-level ping, so viewers poll with this
            // one and drop the socket once the answers stop — a half-open connection (a phone losing
            // signal, a NAT dropping the flow) otherwise stays "open" forever with a dead terminal.
            case { Type: "ping" }:
                try { await SendAsync(ws, gate, PongFrame, WebSocketMessageType.Text, ct); }
                catch { /* socket gone — the read loop will see it next */ }
                break;
        }
    }

    private sealed record ControlMessage(string Type, int Cols, int Rows);
}
