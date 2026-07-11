using System.Net.WebSockets;
using System.Text.Json;

namespace ClaudeWeb.Server.Sessions.Pty;

/// <summary>
/// Bridges a browser WebSocket to a <see cref="TerminalChannel"/>. Framing is by opcode:
/// <list type="bullet">
///   <item>server → client: <b>Binary</b> = raw VT output (fed straight to xterm.js).</item>
///   <item>client → server: <b>Binary</b> = raw keystroke/paste bytes → PTY stdin;
///         <b>Text</b> = JSON control, e.g. <c>{"type":"resize","cols":120,"rows":40}</c>.</item>
/// </list>
/// </summary>
public static class TerminalSocket
{
    public static async Task PumpAsync(WebSocket ws, TerminalChannel term, CancellationToken hostCt)
    {
        using var cts = CancellationTokenSource.CreateLinkedTokenSource(hostCt);
        using var sub = term.Subscribe();
        try
        {
            // 1) Replay recent scrollback so a reconnecting viewer sees current screen state.
            if (sub.Replay.Length > 0)
                await ws.SendAsync(sub.Replay, WebSocketMessageType.Binary, true, cts.Token);

            // WRITE loop: live PTY output → WS. Swallow every fault (a dropped socket throws various
            // WebSocket/IO exceptions) — this task is awaited below, and a client disconnect must tear
            // down only this viewer, never surface as an unhandled fault.
            var writeLoop = Task.Run(async () =>
            {
                try
                {
                    await foreach (var chunk in sub.Reader.ReadAllAsync(cts.Token))
                        await ws.SendAsync(chunk, WebSocketMessageType.Binary, true, cts.Token);
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
                if (r.MessageType == WebSocketMessageType.Binary)
                    await term.WriteAsync(buf.AsMemory(0, r.Count), cts.Token);
                else
                    HandleControl(buf.AsSpan(0, r.Count), term);
            }

            cts.Cancel();
            await writeLoop;
        }
        catch (OperationCanceledException) { }
        finally
        {
            cts.Cancel();
            if (ws.State == WebSocketState.Open)
                try { await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "", CancellationToken.None); } catch { }
        }
    }

    private static readonly JsonSerializerOptions ControlJson = new() { PropertyNameCaseInsensitive = true };

    private static void HandleControl(ReadOnlySpan<byte> json, TerminalChannel term)
    {
        try
        {
            var msg = JsonSerializer.Deserialize<ControlMessage>(json, ControlJson);
            if (msg is { Type: "resize" })
                term.Resize((short)msg.Cols, (short)msg.Rows);
        }
        catch { /* ignore malformed control frames */ }
    }

    private sealed record ControlMessage(string Type, int Cols, int Rows);
}
