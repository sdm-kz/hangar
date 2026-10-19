using Hangar.Server.Auth;

namespace Hangar.Server.Nodes;

internal record NodeUpdateRequest(string? Name, string? Color, string? Url);
internal record AddNodeRequest(string? Url, string? Password, bool? Mutual, string? Fingerprint);
internal record PeerUpdateRequest(string? Name, string? Color, string? Url, bool? Enabled);
internal record TrustRequest(string? Fingerprint);

/// <summary>
/// This node's identity and its peers (see plans/multi-node.md): <c>/api/node</c> is who this node is,
/// <c>/api/nodes</c> who it is paired with in both directions, and <c>/n/{id}/…</c> a peer's API through
/// this node (<see cref="NodeProxy"/>).
/// </summary>
/// <remarks>
/// Everything here but <c>GET /api/node</c> is for a person at this node, never for a peer: a request that
/// authenticated with a peer token is turned away from the rest by <see cref="TokenAuthMiddleware"/>, apart
/// from <c>POST /api/nodes/unpair</c>, which is the peer's to call and drops the token it came in with.
/// <c>POST /api/nodes/pair</c> takes no token at all — the other node's password is its credential.
/// </remarks>
internal static class NodeEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/node", (NodePairing pairing, Update.UpdateService updates) =>
            Results.Ok(pairing.Info(updates.Status.Current?.BuildId)));

        app.MapPost("/api/node", (NodeUpdateRequest body, NodeIdentityStore identity, NodePairing pairing, Update.UpdateService updates) =>
            identity.Update(body.Name, body.Color, body.Url) is { } error
                ? Results.BadRequest(new { error })
                : Results.Ok(pairing.Info(updates.Status.Current?.BuildId)));

        app.MapGet("/api/nodes", (PeerStore peers, PeerTokenStore inbound, NodePairing pairing, Update.UpdateService updates) =>
            Results.Ok(new
            {
                self = pairing.Info(updates.Status.Current?.BuildId),
                peers = peers.List(),
                // Never the hash: the key is enough to revoke one, and the list is all a person needs to see.
                allowed = inbound.List().Select(p => new { p.Key, p.NodeId, p.Name, p.Url, p.IssuedAt, p.LastUsedAt }),
            }));

        // Add a node: pair with it over the network, using its password once.
        app.MapPost("/api/nodes", async (AddNodeRequest body, NodePairing pairing, CancellationToken ct) =>
        {
            var result = await pairing.AddAsync(body.Url, body.Password, body.Mutual ?? true, body.Fingerprint, ct);
            if (result.Certificate is not null)
                return Results.Json(new
                {
                    error = result.CertificateChanged
                        ? "The node presented a different certificate from the one you confirmed."
                        : "The node's certificate isn't one this machine trusts. Check its fingerprint before trusting it.",
                    certificate = result.Certificate,
                    changed = result.CertificateChanged,
                }, statusCode: StatusCodes.Status409Conflict);
            return result.Error is { } error
                ? Results.BadRequest(new { error })
                : Results.Ok(new { node = result.Node, mutual = result.Mutual });
        });

        // The other half of the above, on the node being added. No token: see the remarks.
        app.MapPost("/api/nodes/pair", async (PairRequest body, HttpContext ctx, NodePairing pairing, Update.UpdateService updates,
            CancellationToken ct) =>
        {
            var (answer, status, error) = await pairing.AcceptAsync(body, ctx, updates.Status.Current?.BuildId, ct);
            return answer is not null ? Results.Ok(answer) : Results.Json(new { error }, statusCode: status);
        });

        // A peer forgetting this node: it drops the token it was issued, so nothing is left behind here.
        app.MapPost("/api/nodes/unpair", (HttpContext ctx, PeerTokenStore inbound) =>
        {
            if (TokenAuthMiddleware.PeerOf(ctx) is not { NodeId: { } nodeId } peer)
                return Results.Json(new { error = "only a peer node can unpair itself" }, statusCode: StatusCodes.Status403Forbidden);
            // Once the answer is out: revoking the token cuts every request made with it — this one included.
            ctx.Response.OnCompleted(() =>
            {
                inbound.Remove(peer.Key);
                inbound.RemoveNode(nodeId);
                return Task.CompletedTask;
            });
            return Results.Ok();
        });

        app.MapPost("/api/nodes/{id}", (string id, PeerUpdateRequest body, PeerStore peers, TokenStore tokens) =>
        {
            // Pointing a peer somewhere else is how its token would be sent to whoever is there (the next status
            // check, or the forget). On a node with no password, "whoever" is anyone who can reach it.
            if (body.Url is not null && tokens.AuthDisabled)
                return Results.Json(new { error = "this node has no password set, so a node's address can't be changed" },
                    statusCode: StatusCodes.Status403Forbidden);
            string? url = null;
            if (body.Url is not null && (url = NodeIdentityStore.NormalizeUrl(body.Url)) is null)
                return Results.BadRequest(new { error = "the address must be an http:// or https:// URL" });
            return peers.Update(id, body.Name, body.Color, url, body.Enabled) is { } peer
                ? Results.Ok(peer)
                : Results.NotFound(new { error = "unknown node" });
        });

        // Forget a peer: drop this node's token for it, after telling it to drop its record of that token.
        // ?revoke=true also takes away the peer's way in here, for a node to be cut off in both directions.
        app.MapDelete("/api/nodes/{id}", async (string id, bool? revoke, PeerStore peers, PeerTokenStore inbound,
            NodePairing pairing, CancellationToken ct) =>
        {
            var peer = peers.Get(id);
            if (peer is not null)
            {
                await pairing.UnpairAsync(peer, ct);
                peers.Remove(id);
            }
            var revoked = revoke == true && inbound.RemoveNode(id);
            return peer is null && !revoked ? Results.NotFound(new { error = "unknown node" }) : Results.Ok();
        });

        app.MapGet("/api/nodes/{id}/status", async (string id, PeerStore peers, NodePairing pairing, CancellationToken ct) =>
            peers.Get(id) is { } peer
                ? Results.Ok(await pairing.ProbeAsync(peer, ct))
                : Results.NotFound(new { error = "unknown node" }));

        // Trust the certificate a peer presents now, in place of the pinned one — deliberately, after the
        // status probe has shown it to a person. The fingerprint they saw is sent back and must still match.
        app.MapPost("/api/nodes/{id}/trust", async (string id, TrustRequest body, PeerStore peers, NodePairing pairing,
            CancellationToken ct) =>
        {
            if (peers.Get(id) is not { } peer) return Results.NotFound(new { error = "unknown node" });
            if (string.IsNullOrWhiteSpace(body.Fingerprint)) return Results.BadRequest(new { error = "no fingerprint" });
            var probe = await pairing.ProbeAsync(peer with { Fingerprint = body.Fingerprint }, ct);
            if (probe.Status != "online")
                return Results.BadRequest(new { error = probe.Error ?? $"the node is {probe.Status}" });
            peers.Trust(id, body.Fingerprint);
            return Results.Ok(peers.Get(id));
        });

        // Take a node's way in away: its token here stops working on its next request.
        app.MapDelete("/api/nodes/allowed/{key}", (string key, PeerTokenStore inbound) =>
            inbound.Remove(key) ? Results.Ok() : Results.NotFound(new { error = "unknown token" }));

        // A peer's whole API and sockets, through this node.
        app.Map("/n/{nodeId}/{**rest}", (string nodeId, HttpContext ctx, NodeProxy proxy) => proxy.HandleAsync(ctx, nodeId));
    }
}
