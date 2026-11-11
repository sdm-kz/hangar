using Hangar.Server.Nodes;

namespace Hangar.Server.Auth;

/// <summary>
/// Gates /api/* and /hub/* behind a bearer token (Authorization header or ?access_token= for the sockets) — a
/// browser's, the tray's local one, or a paired node's peer token. The login endpoint and everything else
/// (the SPA static files) pass through. <c>/n/*</c>, a peer's API through this node, checks its own: see
/// <see cref="NodeProxy"/>.
/// <para>In front of all of that: an instance with no password answers requests made on this machine only
/// (<see cref="LocalRequest"/>) — every path, the login, the sockets and the static files included. Without a
/// password there is nothing else between a caller and a shell, so whoever else can reach the port, whatever
/// it is bound to and whatever proxies it, is turned away until <c>Auth:Password</c> is set.</para>
/// </summary>
public sealed class TokenAuthMiddleware(RequestDelegate next, TokenStore tokens, PeerTokenStore peerTokens)
{
    public async Task Invoke(HttpContext ctx)
    {
        var path = ctx.Request.Path;

        // The tray's token proves the caller can read this user's files, so it is let in however it came.
        if (tokens.AuthDisabled && !LocalRequest.Is(ctx) && !tokens.IsLocalToken(ExtractToken(ctx.Request)))
        {
            const string refusal = "This Hangar has no password set, so it only answers requests made on this machine " +
                                   "(http://localhost:<port>). To use it from anywhere else, open it there and set a " +
                                   "password (or set Auth:Password).";
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            if (path.StartsWithSegments("/api") || path.StartsWithSegments("/hub") || path.StartsWithSegments("/n"))
                await ctx.Response.WriteAsJsonAsync(new { error = refusal });
            else
            {
                ctx.Response.ContentType = "text/plain; charset=utf-8";
                await ctx.Response.WriteAsync(refusal);
            }
            return;
        }

        var isProtected = path.StartsWithSegments("/api") || path.StartsWithSegments("/hub");
        // The login and auth-config endpoints must be reachable before a token exists. The hook
        // callback (/api/hooks) is called by the claude subprocess, which has no browser token; it
        // authenticates with its own X-Hook-Token header, validated inside the endpoint.
        var isPublic = path.StartsWithSegments("/api/auth/login")
            || path.StartsWithSegments("/api/auth/config")
            // The VAPID public key is not secret and the browser needs it before it can subscribe.
            || path.StartsWithSegments("/api/push/config")
            // Another node pairing with this one: its credential is this node's password, in the body,
            // checked inside the endpoint (NodePairing.AcceptAsync).
            || (path.Equals("/api/nodes/pair", StringComparison.OrdinalIgnoreCase) && HttpMethods.IsPost(ctx.Request.Method))
            || path.StartsWithSegments("/api/hooks")
            // Self-service endpoints for a launched session acting on itself (e.g. renaming). Same
            // deal as the hooks: no browser token, authenticated inside the endpoint by the
            // X-Session-Id / X-Hook-Token pair we injected into that session's environment.
            || path.StartsWithSegments("/api/self")
            // The HTML preview's ticketed folder. Requested by a sandboxed frame, which cannot set
            // an Authorization header on its own navigation — and this app keeps its token in
            // localStorage and sets no cookies, so nothing else rides along either. The ticket in
            // the path is therefore the credential, checked inside the endpoint. It is minted from
            // the protected side (/api/fs/preview-ticket), stands for one folder's subtree, reads
            // only, and expires. GET alone: nothing under here writes, and confining the exemption
            // to the verb keeps it that way if something is ever added.
            || (path.StartsWithSegments("/api/preview") && HttpMethods.IsGet(ctx.Request.Method));

        if (!isProtected || isPublic)
        {
            await next(ctx);
            return;
        }

        // External automation endpoints authenticate with an API key in the X-Api-Key header
        // instead of the browser bearer token. This grants access to /api/external/* only.
        // With no password set, a request that got this far was made on this machine (see the gate
        // above), and the rest of the API is already open to it — so is this, key or none; that is
        // what lets scripts\hgr-new-session.ps1 work on a fresh install.
        if (path.StartsWithSegments("/api/external"))
        {
            if (!tokens.AuthDisabled && !tokens.IsValidApiKey(ctx.Request.Headers["X-Api-Key"].ToString()))
            {
                ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
                await ctx.Response.WriteAsJsonAsync(new { error = "unauthorized" });
                return;
            }
            await next(ctx);
            return;
        }

        var token = ExtractToken(ctx.Request);

        // Another node, with the token this one issued it at pairing (see PeerTokenStore). Checked before the
        // browser tokens so that it is marked as a peer however this node is configured: the proxy's hop
        // guard and the node endpoints go by the mark.
        if (peerTokens.Validate(token) is { } peer)
        {
            // A token minted for a pairing still in flight (no node bound yet) proves one thing — that the way
            // back works — and is good for nothing else. Whoever answered at the address being paired with holds
            // it, and the pairing may yet fail.
            var pendingMisuse = peer.NodeId is null
                && !(HttpMethods.IsGet(ctx.Request.Method) && path.Equals("/api/node", StringComparison.OrdinalIgnoreCase));
            if (pendingMisuse || !PeerMayReach(ctx.Request))
            {
                ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
                await ctx.Response.WriteAsJsonAsync(new { error = "not available to another node" });
                return;
            }
            ctx.Items[PeerItem] = peer;
            // Revoking the token cuts this request too — a terminal relayed for a peer stays open for hours,
            // and "revoked" has to mean now, not at its next reconnect.
            using (peerTokens.RevokedToken(peer.Key).Register(ctx.Abort))
                await next(ctx);
            return;
        }

        if (!tokens.IsValid(token))
        {
            ctx.Response.StatusCode = StatusCodes.Status401Unauthorized;
            await ctx.Response.WriteAsJsonAsync(new { error = "unauthorized" });
            return;
        }

        // A socket is a shell or the whole session list, opened with the token in its URL: only from this
        // node's own page (see SocketOrigin). Not asked of a peer above — a socket a node relays carries the
        // browser's Origin, which that node has already held to its own.
        if (ctx.WebSockets.IsWebSocketRequest && !SocketOrigin.Allowed(ctx.Request))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            await ctx.Response.WriteAsJsonAsync(new { error = "not from this node's page" });
            return;
        }

        await next(ctx);
    }

    private const string PeerItem = "Hangar.Peer";

    /// <summary>The peer a request came from, when it authenticated with a peer token; null for anyone else.</summary>
    public static InboundPeer? PeerOf(HttpContext ctx) => ctx.Items[PeerItem] as InboundPeer;

    /// <summary>
    /// What a peer token opens: everything a browser's does — which is a shell on this machine, the same trust
    /// as the password it was paired with — except managing this node's pairings and identity. The one node
    /// endpoint a peer calls is <c>unpair</c>, dropping its own token when it forgets this node.
    /// </summary>
    private static bool PeerMayReach(HttpRequest req)
    {
        if (req.Path.StartsWithSegments("/api/nodes"))
            return HttpMethods.IsPost(req.Method) && req.Path.Equals("/api/nodes/unpair", StringComparison.OrdinalIgnoreCase);
        if (req.Path.StartsWithSegments("/api/node")) return HttpMethods.IsGet(req.Method);
        return true;
    }

    internal static string? ExtractToken(HttpRequest req)
    {
        var header = req.Headers.Authorization.ToString();
        if (header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return header["Bearer ".Length..].Trim();

        // SignalR websocket handshake can only pass the token as a query-string parameter.
        var q = req.Query["access_token"].ToString();
        return string.IsNullOrEmpty(q) ? null : q;
    }
}
