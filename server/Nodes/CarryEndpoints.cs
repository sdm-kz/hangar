using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Server.Sessions;

namespace Hangar.Server.Nodes;

internal record MemoryImportRequest(string? Node, string? FromDir, string? ToDir, List<string>? Names, List<string>? Replace);
internal record ConversationImportRequest(string? Node, string? ConversationId, string? ToDir);

/// <summary>
/// Carrying Claude's own data for a folder to another machine (plans/multi-node.md, phase 6): its memory, and a
/// conversation to resume there. Like a paste between machines, the machine it lands on does the work and
/// reads the other through its pairing; nothing is written to another machine through this one.
/// </summary>
internal static class CarryEndpoints
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static void Map(WebApplication app)
    {
        // The read halves, asked of the machine the memory or the conversation is on.
        app.MapGet("/api/claude/memory", (string? dir) =>
        {
            try { return Results.Ok(ClaudeProjectData.ReadMemory(dir ?? "")); }
            catch (Exception ex) { return Results.BadRequest(new { error = ex.Message }); }
        });

        app.MapGet("/api/claude/conversations/{id}/bundle", (string id) =>
        {
            if (!ClaudeProjectData.IsConversationId(id)) return Results.BadRequest(new { error = "That isn't a conversation id." });
            try { return Results.Stream(ClaudeProjectData.Pack(id), "application/zip"); }
            catch (FileNotFoundException ex) { return Results.NotFound(new { error = ex.Message }); }
        });

        // The write halves, on the machine they land on.
        app.MapPost("/api/claude/memory/import", async (MemoryImportRequest body, HttpContext ctx, PeerStore peers,
            NodeIdentityStore identity) =>
        {
            if (Refusal(body.Node, ctx, identity) is { } refused) return refused;
            if (string.IsNullOrWhiteSpace(body.ToDir) || !Directory.Exists(body.ToDir))
                return Results.BadRequest(new { error = $"There's no folder {body.ToDir} on this machine." });
            if (body.Names is not { Count: > 0 }) return Results.BadRequest(new { error = "Pick the memories to copy." });
            try
            {
                var source = Elsewhere(body.Node, identity)
                    ? await FromPeerAsync<ClaudeMemoryListing>(peers, body.Node!,
                        $"/api/claude/memory?dir={Uri.EscapeDataString(body.FromDir ?? "")}", ctx.RequestAborted)
                    : ClaudeProjectData.ReadMemory(body.FromDir ?? "");
                return Results.Ok(ClaudeProjectData.MergeMemory(source, body.ToDir, body.Names, body.Replace));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
        });

        app.MapPost("/api/claude/conversations/import", async (ConversationImportRequest body, HttpContext ctx,
            PeerStore peers, NodeIdentityStore identity) =>
        {
            if (Refusal(body.Node, ctx, identity) is { } refused) return refused;
            if (!ClaudeProjectData.IsConversationId(body.ConversationId))
                return Results.BadRequest(new { error = "That isn't a conversation id." });
            if (string.IsNullOrWhiteSpace(body.ToDir) || !Directory.Exists(body.ToDir))
                return Results.BadRequest(new { error = $"There's no folder {body.ToDir} on this machine." });
            var temp = Path.Combine(Path.GetTempPath(), $"hangar-conversation-{Guid.NewGuid():N}.zip");
            try
            {
                await using (var file = File.Create(temp))
                {
                    if (Elsewhere(body.Node, identity))
                        await DownloadFromPeerAsync(peers, body.Node!,
                            $"/api/claude/conversations/{body.ConversationId}/bundle", file, ctx.RequestAborted);
                    else
                        await using (var packed = ClaudeProjectData.Pack(body.ConversationId!))
                            await packed.CopyToAsync(file, ctx.RequestAborted);
                }
                var written = ClaudeProjectData.Unpack(temp, body.ConversationId!, body.ToDir);
                return Results.Ok(new { written });
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                return Results.BadRequest(new { error = ex.Message });
            }
            finally
            {
                try { File.Delete(temp); } catch { /* the temp folder's to clean */ }
            }
        });
    }

    private static bool Elsewhere(string? node, NodeIdentityStore identity) =>
        !string.IsNullOrEmpty(node) && node != identity.Current.Id;

    // One hop, as everywhere between nodes: asked by another node, this one reads back from that node only —
    // never on to a third, with its own token for it, on that node's say-so.
    private static IResult? Refusal(string? node, HttpContext ctx, NodeIdentityStore identity) =>
        Elsewhere(node, identity) && Auth.TokenAuthMiddleware.PeerOf(ctx) is { } caller && node != caller.NodeId
            ? Results.BadRequest(new { error = "That's on a third machine. Do this from one paired with both." })
            : null;

    private static (HttpClient Http, OutboundPeer Peer) ClientFor(PeerStore peers, string node, TimeSpan timeout)
    {
        if (peers.Get(node) is not { Enabled: true } peer)
            throw new InvalidOperationException("This machine isn't paired with that one.");
        var token = peers.TokenFor(peer.Id)
            ?? throw new InvalidOperationException($"This machine's token for {peer.Name} can't be read; pair it again.");
        var http = new HttpClient(PeerHttp.CreateHandler(peer.Fingerprint), disposeHandler: true) { Timeout = timeout };
        http.DefaultRequestHeaders.Authorization = new("Bearer", token);
        return (http, peer);
    }

    private static async Task<T> FromPeerAsync<T>(PeerStore peers, string node, string path, CancellationToken ct)
    {
        var (http, peer) = ClientFor(peers, node, TimeSpan.FromSeconds(60));
        using (http)
        {
            using var response = await http.GetAsync(peer.Url + path, ct);
            await ThrowUnlessOk(response, peer, ct);
            return await response.Content.ReadFromJsonAsync<T>(Json, ct)
                ?? throw new InvalidOperationException($"{peer.Name} sent nothing.");
        }
    }

    private static async Task DownloadFromPeerAsync(PeerStore peers, string node, string path, Stream into, CancellationToken ct)
    {
        // A long conversation is tens of megabytes: long enough for one over a slow link, not for ever.
        var (http, peer) = ClientFor(peers, node, TimeSpan.FromMinutes(10));
        using (http)
        {
            using var response = await http.GetAsync(peer.Url + path, HttpCompletionOption.ResponseHeadersRead, ct);
            await ThrowUnlessOk(response, peer, ct);
            await response.Content.CopyToAsync(into, ct);
        }
    }

    private static async Task ThrowUnlessOk(HttpResponseMessage response, OutboundPeer peer, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        string? said = null;
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            said = doc.RootElement.TryGetProperty("error", out var e) ? e.GetString() : null;
        }
        catch { /* not a body with words in it */ }
        throw new InvalidOperationException(response.StatusCode switch
        {
            HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden => $"{peer.Name} no longer accepts this machine.",
            HttpStatusCode.NotFound when said is null => $"{peer.Name} runs an older build that can't do this. Update it first.",
            _ => $"{peer.Name}: {said ?? $"it answered {(int)response.StatusCode}"}",
        });
    }
}
