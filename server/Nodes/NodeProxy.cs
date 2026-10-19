using System.Collections.Concurrent;
using System.Net;
using Hangar.Server.Auth;
using Microsoft.AspNetCore.Http.Features;
using Yarp.ReverseProxy.Forwarder;

namespace Hangar.Server.Nodes;

/// <summary>
/// <c>/n/{nodeId}/…</c>: a paired peer's whole API and sockets, forwarded through this node, so the browser
/// reaches a session on any node from the one origin it was loaded from — one login, no CORS, and only this
/// node has to be reachable from the phone. YARP's forwarder does the work: it streams bodies both ways
/// (uploads, downloads, previews) and carries WebSocket upgrades (terminals, <c>/hub/events</c>).
/// </summary>
/// <remarks>
/// <para><b>Credentials.</b> The browser presents this node's token; it is stripped — header and
/// <c>?access_token=</c> alike — and the peer token goes on instead, in the header (a server client may
/// set one on a WebSocket upgrade too; only browsers are confined to the query string). The browser
/// never sees a peer token.</para>
/// <para><b>One hop.</b> A request that authenticated with a peer token never gets here as a proxy request
/// — see <see cref="HandleAsync"/> — and every forwarded request carries <see cref="ViaHeader"/>, which a
/// node refuses to forward on. No loops, and no chains through a node.</para>
/// </remarks>
public sealed class NodeProxy
{
    public const string ViaHeader = "X-Hangar-Via";

    // Never through someone else: a session's own calls go to its own node via HANGAR_URL, the hooks the same,
    // pairing is between two nodes and a person, the login is per node, and the automation API has a key of
    // its own.
    private static readonly string[] LocalOnly =
        ["/api/self", "/api/hooks", "/api/nodes", "/api/node", "/api/auth", "/api/external", "/api/daemon"];

    private readonly IHttpForwarder _forwarder;
    private readonly PeerStore _peers;
    private readonly PeerTokenStore _inbound;
    private readonly NodeIdentityStore _identity;
    private readonly TokenStore _tokens;
    private readonly ILogger<NodeProxy> _log;

    // One connection pool per peer, built for its URL and pinned certificate. Rebuilt when either changes, and
    // the old one retired at once — which is the point when a peer is forgotten, disabled or its certificate
    // re-trusted: what was relayed on the old terms stops. Disposing the pool alone would not do that (an
    // upgraded connection, a terminal, is no longer the pool's), so every request through it is tied to
    // `Cut`, and retiring cancels it.
    private sealed record Client(string Signature, HttpMessageInvoker Invoker, CancellationTokenSource Cut);
    private readonly ConcurrentDictionary<string, Client> _clients = new();

    private static readonly ForwarderRequestConfig RequestConfig = new()
    {
        // The default 100 s idle limit would cut a terminal that sits quiet: the peer's WebSocket keep-alive
        // pings every 2 minutes, and that is all the traffic an idle terminal has.
        ActivityTimeout = TimeSpan.FromMinutes(10),
        // HTTP/1.1 is what the peer speaks on plain http, and what a WebSocket upgrade needs.
        Version = HttpVersion.Version11,
        VersionPolicy = HttpVersionPolicy.RequestVersionOrLower,
    };

    public NodeProxy(IHttpForwarder forwarder, PeerStore peers, PeerTokenStore inbound, NodeIdentityStore identity,
        TokenStore tokens, ILogger<NodeProxy> log)
    {
        _forwarder = forwarder;
        _peers = peers;
        _inbound = inbound;
        _identity = identity;
        _tokens = tokens;
        _log = log;
        _peers.Changed += DropStaleClients;
    }

    public async Task HandleAsync(HttpContext ctx, string nodeId)
    {
        if (!ctx.Request.Path.StartsWithSegments($"/n/{nodeId}", out var rest) || !rest.HasValue) rest = "/";

        // An open node (no password) proxying would hand its peers to anyone who can reach it.
        if (_tokens.AuthDisabled)
        {
            await Fail(ctx, StatusCodes.Status403Forbidden, "this node has no password set, so it does not reach other nodes");
            return;
        }

        // The ticketed HTML preview is requested by a sandboxed frame, which cannot present this node's token
        // — same as /api/preview here (see TokenAuthMiddleware). The ticket in the path is the credential,
        // checked by the peer that minted it.
        var isPreview = HttpMethods.IsGet(ctx.Request.Method) && rest.StartsWithSegments("/api/preview");
        if (!isPreview)
        {
            var token = TokenAuthMiddleware.ExtractToken(ctx.Request);
            if (_inbound.Validate(token) is not null)
            {
                await Fail(ctx, StatusCodes.Status403Forbidden, "a node is reached directly, never through another node");
                return;
            }
            if (!_tokens.IsValid(token))
            {
                await Fail(ctx, StatusCodes.Status401Unauthorized, "unauthorized");
                return;
            }
        }
        if (ctx.Request.Headers.ContainsKey(ViaHeader))
        {
            await Fail(ctx, StatusCodes.Status403Forbidden, "a node is reached directly, never through another node");
            return;
        }

        if (!(rest.StartsWithSegments("/api") || rest.StartsWithSegments("/hub"))
            || LocalOnly.Any(p => rest.StartsWithSegments(p, StringComparison.OrdinalIgnoreCase)))
        {
            await Fail(ctx, StatusCodes.Status404NotFound, "not available through another node");
            return;
        }

        if (_peers.Get(nodeId) is not { Enabled: true } peer)
        {
            await Fail(ctx, StatusCodes.Status404NotFound, "unknown node");
            return;
        }
        if (_peers.TokenFor(peer.Id) is not { } peerToken)
        {
            await Fail(ctx, StatusCodes.Status502BadGateway, "this node's token for that node can't be read; pair it again");
            return;
        }

        // The peer enforces its own limits on what it accepts; this node is only passing it along. Not for the
        // preview's login-free GETs, though: nothing past this node's own limit is owed to an unknown caller.
        if (!isPreview && ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
            limit.MaxRequestBodySize = null;

        if (ClientFor(peer) is not { } client)
        {
            await Fail(ctx, StatusCodes.Status404NotFound, "unknown node");
            return;
        }
        ForwarderError error;
        using (client.Cut.Token.Register(ctx.Abort))
        {
            var transformer = new Transformer(rest, peerToken, _identity.Current.Id);
            error = await _forwarder.SendAsync(ctx, peer.Url, client.Invoker, RequestConfig, transformer);
        }
        if (error == ForwarderError.None || client.Cut.IsCancellationRequested) return;

        var failure = ctx.Features.Get<IForwarderErrorFeature>()?.Exception;
        if (failure is not null && PeerHttp.IsCertificateFailure(failure))
        {
            _log.LogWarning("Node {Name} presented a certificate other than the trusted one", peer.Name);
            await Fail(ctx, StatusCodes.Status502BadGateway, "node certificate changed");
            return;
        }
        // A client that went away mid-request is not the node's fault, and not worth a line in the log.
        if (error is not (ForwarderError.RequestCanceled or ForwarderError.UpgradeRequestCanceled))
            _log.LogDebug(failure, "Forwarding to node {Name} failed: {Error}", peer.Name, error);
        await Fail(ctx, error == ForwarderError.RequestTimedOut ? StatusCodes.Status504GatewayTimeout : StatusCodes.Status502BadGateway,
            error switch
            {
                ForwarderError.Request => "node offline",
                ForwarderError.RequestTimedOut => "the node did not answer in time",
                // It answered, then cut the request off — what a node does with a body over its size limit.
                ForwarderError.RequestBodyDestination => "the node refused the request (too large?)",
                _ => "the connection to the node failed",
            });
    }

    /// <returns>The client for <paramref name="peer"/> as it stands now; null when it changed or went away meanwhile.</returns>
    private Client? ClientFor(OutboundPeer peer)
    {
        var signature = Signature(peer);
        while (true)
        {
            if (_clients.TryGetValue(peer.Id, out var existing))
            {
                if (existing.Signature == signature) return existing;
                Retire(peer.Id, existing);
                continue;
            }
            var created = new Client(signature,
                new HttpMessageInvoker(PeerHttp.CreateHandler(peer.Fingerprint), disposeHandler: true), new CancellationTokenSource());
            if (!_clients.TryAdd(peer.Id, created))
            {
                created.Invoker.Dispose();
                created.Cut.Dispose();
                continue;
            }
            // The peer may have been forgotten or changed between the caller reading it and the add above —
            // after DropStaleClients ran for that change, which would leave this client behind for good.
            if (_peers.Get(peer.Id) is { } now && Signature(now) == signature) return created;
            Retire(peer.Id, created);
            return null;
        }
    }

    private void Retire(string id, Client client)
    {
        if (!_clients.TryRemove(new KeyValuePair<string, Client>(id, client))) return;
        client.Cut.Cancel();
        client.Invoker.Dispose();
    }

    private static string Signature(OutboundPeer peer) => $"{peer.Url}\n{peer.Fingerprint}\n{peer.Enabled}";

    private void DropStaleClients()
    {
        var current = _peers.List().ToDictionary(p => p.Id, Signature);
        foreach (var (id, client) in _clients)
        {
            if (current.TryGetValue(id, out var signature) && signature == client.Signature) continue;
            Retire(id, client);
        }
    }

    private static async Task Fail(HttpContext ctx, int status, string error)
    {
        if (ctx.Response.HasStarted) return;
        ctx.Response.Clear();
        ctx.Response.StatusCode = status;
        await ctx.Response.WriteAsJsonAsync(new { error });
    }

    /// <summary>The per-request rewrite: the path under the peer, the credentials, and the hop mark.</summary>
    private sealed class Transformer(PathString rest, string peerToken, string selfId) : HttpTransformer
    {
        public override async ValueTask TransformRequestAsync(HttpContext ctx, HttpRequestMessage proxyRequest,
            string destinationPrefix, CancellationToken ct)
        {
            await base.TransformRequestAsync(ctx, proxyRequest, destinationPrefix, ct);

            proxyRequest.RequestUri = RequestUtilities.MakeDestinationAddress(destinationPrefix, rest,
                WithoutToken(ctx.Request.QueryString));
            proxyRequest.Headers.Authorization = new("Bearer", peerToken);
            proxyRequest.Headers.Remove(ViaHeader);
            proxyRequest.Headers.TryAddWithoutValidation(ViaHeader, selfId);
            // Let the peer's host name be the peer's, not this node's.
            proxyRequest.Headers.Host = null;
        }

        /// <summary>
        /// The query as the browser wrote it, less <c>access_token</c>: the browser's token for this node means
        /// nothing to the peer — and must not reach it. Filtered as text rather than parsed and rebuilt, so the
        /// rest keeps its encoding (a bare <c>?flag</c> stays bare, a <c>+</c> stays a <c>+</c>).
        /// </summary>
        private static QueryString WithoutToken(QueryString query)
        {
            if (!query.HasValue) return query;
            var kept = query.Value!.TrimStart('?').Split('&')
                .Where(pair =>
                {
                    var key = pair.Split('=', 2)[0];
                    // Ignoring case, as ASP.NET's own query lookup does: ?ACCESS_TOKEN= logs in here just the same.
                    return !string.Equals(Uri.UnescapeDataString(key.Replace('+', ' ')), "access_token", StringComparison.OrdinalIgnoreCase);
                })
                .ToList();
            return kept.Count == 0 ? QueryString.Empty : new QueryString("?" + string.Join('&', kept));
        }

        public override async ValueTask<bool> TransformResponseAsync(HttpContext ctx, HttpResponseMessage? proxyResponse,
            CancellationToken ct)
        {
            // A 401 from the peer means it no longer takes this node's token. Passed on as it is, the SPA would
            // read it as its own login having gone and sign out of this node.
            if (proxyResponse?.StatusCode == HttpStatusCode.Unauthorized)
            {
                ctx.Response.StatusCode = StatusCodes.Status502BadGateway;
                await ctx.Response.WriteAsJsonAsync(new { error = "node unauthorized" }, ct);
                return false;
            }
            var copy = await base.TransformResponseAsync(ctx, proxyResponse, ct);
            Confine(ctx.Response.Headers);
            return copy;
        }

        /// <summary>
        /// What a peer answers is served on this node's origin — where the browser keeps this node's token. A
        /// local response that could run script there is made safe by the endpoint that serves it (the HTML
        /// preview's sandbox, the raw file endpoints' nosniff); a peer's is only as safe as the peer, and a
        /// compromised one would otherwise have a page here that reads the token and owns this node too. So
        /// every proxied response gets the preview's sandbox — an opaque origin, whatever the peer sent — and
        /// nothing that would outlive the response on this origin (a cookie, a service worker's scope, a wipe).
        /// The API's own callers are unaffected: fetch, XHR, sockets, images and downloads ignore all of it.
        /// </summary>
        private static void Confine(IHeaderDictionary headers)
        {
            headers.ContentSecurityPolicy = "sandbox allow-scripts allow-forms allow-popups allow-modals";
            headers.XContentTypeOptions = "nosniff";
            headers.Remove("Set-Cookie");
            headers.Remove("Service-Worker-Allowed");
            headers.Remove("Clear-Site-Data");
        }
    }
}
