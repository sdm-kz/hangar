using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Hangar.Server.Auth;

namespace Hangar.Server.Nodes;

/// <summary>Where this node listens, for a peer that has to call it back (mutual pairing without a set URL).</summary>
public sealed class NodeOptions
{
    public int Port { get; set; } = 5099;
    public string Scheme { get; set; } = "http";
}

/// <summary>The node in a pairing request: who is asking, and how to reach it back.</summary>
public sealed record PairNode(string? Id, string? Name, string? Color, string? Url, int? Port, string? Scheme);

/// <summary>
/// <c>POST /api/nodes/pair</c>. <paramref name="Token"/> is the token the caller minted for this node — present
/// when the pairing is mutual, and what this node uses to reach the caller from then on.
/// </summary>
public sealed record PairRequest(string? Password, PairNode? Node, string? Token);

/// <summary>A node's identity on the wire (<c>GET /api/node</c>, and the answer to a pairing).</summary>
public sealed record NodeInfo(
    string Id,
    string Name,
    string? Color,
    string? Url,
    string? Version,
    string Os,
    IReadOnlyList<string> Capabilities,
    // Whether a session can launch there (claude is found). Null from a build that doesn't say.
    bool? CanLaunch = null);

/// <summary>The answer to <c>POST /api/nodes/pair</c>.</summary>
/// <param name="Mutual">"ok" (the caller is now a peer of this node too), "unreachable" (couldn't call it back), or "off".</param>
public sealed record PairResponse(string Token, NodeInfo Node, string Mutual);

/// <summary>What adding a node came to, for the dialog.</summary>
public sealed record AddNodeResult(
    OutboundPeer? Node = null,
    string? Mutual = null,
    string? Error = null,
    CertificateSeen? Certificate = null,
    bool CertificateChanged = false);

/// <summary>
/// Pairing, both halves: <see cref="AddAsync"/> on the node a person is adding a peer from, and
/// <see cref="AcceptAsync"/> on the peer being added. The password is used for this exchange only and never
/// stored; what each side keeps is a token the other minted (see <see cref="PeerTokenStore"/>).
/// </summary>
/// <remarks>
/// <para><b>Mutual pairing.</b> The node adding a peer mints a token for it up front and sends it along, so the
/// peer lists it back without anyone pairing twice. The peer stores it only after it has used it — it calls
/// <c>GET /api/node</c> on the way back and expects the right id — so a node that can reach its peer but not
/// the other way round ends up paired one way, and says so, rather than holding a peer that never answers.</para>
/// <para><b>Certificates on the way back.</b> Nobody is at the peer to look at a fingerprint, so the peer pins
/// whatever the caller presents during this call. That is trust on first use with the first use being a
/// password-authenticated exchange the caller started — the same moment the caller's own pin was made.</para>
/// </remarks>
public sealed class NodePairing(
    NodeIdentityStore identity,
    PeerStore peers,
    PeerTokenStore inbound,
    TokenStore tokens,
    LoginThrottle throttle,
    NodeOptions options,
    Sessions.SessionManagerOptions sessionOptions,
    ILogger<NodePairing> log)
{
    public const string Capability = "node-v1";

    // One pairing started from here at a time. Two in flight to the same node each mint a token there, the
    // second revoking the first, and whichever answer lands last decides which one this node keeps.
    private readonly SemaphoreSlim _adding = new(1, 1);

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    /// <summary>The OS this node runs on, as <see cref="NodeInfo.Os"/> and the stream name it.</summary>
    public static string OsName() =>
        OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "macos" : OperatingSystem.IsLinux() ? "linux" : "other";

    public NodeInfo Info(string? version)
    {
        var me = identity.Current;
        return new NodeInfo(me.Id, me.Name, me.Color, me.Url, version, OsName(), [Capability],
            Diagnostics.EnvironmentReport.ClaudeFound(sessionOptions.ClaudeExecutable));
    }

    // ---- The side a person adds a node from -----------------------------------------------------------

    /// <param name="trustFingerprint">
    /// The certificate fingerprint the person confirmed, on the second try after the first came back with
    /// <see cref="AddNodeResult.Certificate"/>. Null on the first try.
    /// </param>
    public async Task<AddNodeResult> AddAsync(string? url, string? password, bool mutual, string? trustFingerprint,
        CancellationToken ct)
    {
        await _adding.WaitAsync(ct);
        try { return await AddOnceAsync(url, password, mutual, trustFingerprint, ct); }
        finally { _adding.Release(); }
    }

    private async Task<AddNodeResult> AddOnceAsync(string? url, string? password, bool mutual, string? trustFingerprint,
        CancellationToken ct)
    {
        if (identity.IsTemporary)
            return new(Error: "This node's identity (node.json) can't be read, so it can't pair: the other node would " +
                              "remember an identity this one loses at the next start.");
        if (tokens.AuthDisabled)
            return new(Error: "This node has no password set. Set one (Auth:Password) before pairing: otherwise anyone " +
                              "who can reach it gets every node it is paired with.");
        var target = NodeIdentityStore.NormalizeUrl(url);
        if (target is null) return new(Error: "Enter the node's address as an http:// or https:// URL.");
        if (string.IsNullOrEmpty(password)) return new(Error: "Enter the other node's password.");
        if (peers.IsFull && !peers.List().Any(p => p.Url == target))
            return new(Error: $"This node already has {PeerStore.MaxPeers} peers. Forget one first.");

        var me = identity.Current;
        var minted = mutual ? inbound.Issue(null, null, null) : default((string Token, string Key)?);
        var seen = new CertificateSeen();
        try
        {
            using var http = PeerHttp.CreateClient(trustFingerprint, seen);
            var request = new PairRequest(password,
                new PairNode(me.Id, me.Name, me.Color, me.Url, options.Port, options.Scheme), minted?.Token);
            HttpResponseMessage response;
            try
            {
                response = await http.PostAsJsonAsync($"{target}/api/nodes/pair", request, JsonOpts, ct);
            }
            catch (HttpRequestException ex) when (PeerHttp.IsCertificateFailure(ex) && seen.Fingerprint is not null)
            {
                // Not trusted by the OS and not (or not this one) confirmed by the person: show it to them.
                return new(Certificate: seen, CertificateChanged: trustFingerprint is not null);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                return new(Error: $"Could not reach {target}: {Describe(ex)}");
            }

            using (response)
            {
                if (!response.IsSuccessStatusCode)
                    return new(Error: response.StatusCode switch
                    {
                        HttpStatusCode.Unauthorized => "Wrong password for that node.",
                        HttpStatusCode.TooManyRequests => "Too many wrong passwords — that node is refusing for a while.",
                        HttpStatusCode.NotFound or HttpStatusCode.MethodNotAllowed =>
                            "That address doesn't pair: it is not Hangar, or a build from before nodes.",
                        _ => await ErrorOf(response, ct) ?? $"The node answered {(int)response.StatusCode}.",
                    });

                PairResponse? answer;
                try { answer = await response.Content.ReadFromJsonAsync<PairResponse>(JsonOpts, ct); }
                catch (JsonException) { answer = null; }
                if (answer?.Node is null || string.IsNullOrEmpty(answer.Token) || !IsNodeId(answer.Node.Id))
                    return new(Error: "That node gave an answer this build doesn't understand.");
                if (answer.Node.Id == me.Id)
                    return new(Error: "That address is this node.");
                // Whatever answers is taken at its word about who it is, so it must not get to be a node already
                // paired somewhere else: its token and address would replace that node's, and everything meant
                // for it would go here instead.
                if (peers.Get(answer.Node.Id) is { } known && known.Url != target)
                    return new(Error: $"A node with that identity is already paired, at {known.Url}. If it moved, change " +
                                      "its address or forget it first.");

                // A certificate the OS trusts is not pinned (see PeerHttp); a self-signed one is, as confirmed.
                var pin = target.StartsWith("https:", StringComparison.OrdinalIgnoreCase) && !seen.Valid ? seen.Fingerprint : null;
                var node = new OutboundPeer(answer.Node.Id, Clip(answer.Node.Name, 64) ?? target, target,
                    Clip(answer.Node.Color, 32), pin, true, DateTimeOffset.UtcNow);
                if (peers.Upsert(node, answer.Token) is { } refused) return new(Error: refused);

                if (minted is { } m)
                {
                    if (answer.Mutual == "ok") inbound.Bind(m.Key, answer.Node.Id, node.Name, target);
                    else inbound.Remove(m.Key);
                    minted = null; // settled: the finally below must not remove it
                }
                log.LogInformation("Paired with node {Name} ({Id}) at {Url}; mutual: {Mutual}",
                    node.Name, node.Id, target, answer.Mutual);
                return new(Node: peers.Get(node.Id), Mutual: answer.Mutual);
            }
        }
        finally
        {
            // Every way out that didn't finish the pairing: nobody holds the token minted for it.
            if (minted is { } leftover) inbound.Remove(leftover.Key);
        }
    }

    // ---- The side being added ------------------------------------------------------------------------

    /// <returns>The answer, or a status code and the error to send instead.</returns>
    public async Task<(PairResponse? Answer, int Status, string? Error)> AcceptAsync(PairRequest req, HttpContext ctx,
        string? version, CancellationToken ct)
    {
        if (tokens.AuthDisabled)
            return (null, StatusCodes.Status403Forbidden,
                "That node has no password set, so it does not pair. Set one (Auth:Password) first.");

        if (identity.IsTemporary)
            return (null, StatusCodes.Status503ServiceUnavailable,
                "That node's identity (node.json) can't be read, so it can't pair right now.");

        // The password is the login's, so guesses at it here draw on the login's budget (LoginThrottle).
        var caller = ctx.Connection.RemoteIpAddress;
        var who = LoginThrottle.ClientKey(ctx);
        if (!throttle.TryBegin(who, out var wait))
        {
            ctx.Response.Headers.RetryAfter = ((int)Math.Ceiling(wait.TotalSeconds)).ToString();
            return (null, StatusCodes.Status429TooManyRequests, "too many attempts");
        }

        if (!tokens.CheckPassword(req.Password))
        {
            log.LogWarning("A pairing request from {Address} gave the wrong password", who);
            return (null, StatusCodes.Status401Unauthorized, "unauthorized");
        }
        throttle.Succeeded(who);

        var me = identity.Current;
        var nodeId = req.Node?.Id?.Trim();
        if (!IsNodeId(nodeId))
            return (null, StatusCodes.Status400BadRequest, "the pairing request names no node");
        if (nodeId == me.Id)
            return (null, StatusCodes.Status409Conflict,
                "That is this node: both have the same identity. A second instance on one machine needs its own data folder (HANGAR_TEST_ROOT).");

        var name = Clip(req.Node!.Name, 64) ?? nodeId[..Math.Min(8, nodeId.Length)];
        var backUrl = CallerUrl(req.Node, caller);
        var (token, _) = inbound.Issue(nodeId, name, backUrl);

        var mutual = "off";
        if (!string.IsNullOrEmpty(req.Token))
        {
            mutual = "unreachable";
            if (backUrl is not null && await CallBackAsync(backUrl, nodeId, req.Token, ct) is { } pin
                && peers.Upsert(new OutboundPeer(nodeId, name, backUrl, Clip(req.Node.Color, 32), pin.Pin, true, DateTimeOffset.UtcNow),
                    req.Token) is null)
                mutual = "ok";
        }
        log.LogInformation("Paired with node {Name} ({Id}) from {Address}; mutual: {Mutual}", name, nodeId, who, mutual);
        return (new PairResponse(token, Info(version), mutual), StatusCodes.Status200OK, null);
    }

    /// <summary>
    /// The caller's address as this node should use it: the one it says it has, or the address its request
    /// came from with the port it says it listens on.
    /// </summary>
    private static string? CallerUrl(PairNode node, IPAddress? caller)
    {
        if (NodeIdentityStore.NormalizeUrl(node.Url) is { } stated) return stated;
        if (caller is null || node.Port is not (> 0 and < 65536)) return null;
        if (caller.IsIPv4MappedToIPv6) caller = caller.MapToIPv4();
        // A link-local address only means something with its zone (fe80::1%12), which a URL can't carry.
        if (caller.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 && caller.ScopeId != 0) return null;
        var scheme = string.Equals(node.Scheme, "https", StringComparison.OrdinalIgnoreCase) ? "https" : "http";
        var host = caller.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6 ? $"[{caller}]" : caller.ToString();
        return NodeIdentityStore.NormalizeUrl($"{scheme}://{host}:{node.Port}");
    }

    private sealed record Pinned(string? Pin);

    /// <summary>Prove the way back works: the caller must answer to its own token with its own id.</summary>
    /// <returns>The pin to keep (null inside for http or a certificate the OS trusts), or null when it failed.</returns>
    private async Task<Pinned?> CallBackAsync(string url, string nodeId, string token, CancellationToken ct)
    {
        var seen = new CertificateSeen();
        try
        {
            using var http = PeerHttp.CreateClient(null, seen, acceptAny: true, TimeSpan.FromSeconds(10));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{url}/api/node");
            request.Headers.Authorization = new("Bearer", token);
            using var response = await http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                log.LogWarning("Mutual pairing: {Url} answered {Status} on the way back", url, (int)response.StatusCode);
                return null;
            }
            var info = await response.Content.ReadFromJsonAsync<NodeInfo>(JsonOpts, ct);
            if (info?.Id != nodeId)
            {
                log.LogWarning("Mutual pairing: {Url} is a different node ({Id}) than the one pairing", url, info?.Id);
                return null;
            }
            return new Pinned(url.StartsWith("https:", StringComparison.OrdinalIgnoreCase) && !seen.Valid ? seen.Fingerprint : null);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            log.LogWarning("Mutual pairing: could not reach {Url} on the way back: {Error}", url, Describe(ex));
            return null;
        }
    }

    // ---- Talking to a peer that is already paired -------------------------------------------------------

    /// <summary>How a peer is doing, as a person checking on it wants to know.</summary>
    public sealed record PeerStatus(string Status, NodeInfo? Node = null, string? Error = null, CertificateSeen? Certificate = null);

    public async Task<PeerStatus> ProbeAsync(OutboundPeer peer, CancellationToken ct)
    {
        var token = peers.TokenFor(peer.Id);
        if (token is null) return new("unauthorized", Error: "The token for this node can't be read here; pair it again.");
        var seen = new CertificateSeen();
        try
        {
            using var http = PeerHttp.CreateClient(peer.Fingerprint, seen, timeout: TimeSpan.FromSeconds(8));
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{peer.Url}/api/node");
            request.Headers.Authorization = new("Bearer", token);
            using var response = await http.SendAsync(request, ct);
            if (response.StatusCode == HttpStatusCode.Unauthorized) return new("unauthorized", Error: "The node no longer accepts this node's token.");
            if (response.StatusCode == HttpStatusCode.NotFound) return new("incompatible", Error: "The node runs a build from before nodes.");
            if (!response.IsSuccessStatusCode) return new("offline", Error: $"The node answered {(int)response.StatusCode}.");
            var info = await response.Content.ReadFromJsonAsync<NodeInfo>(JsonOpts, ct);
            if (info is null || info.Id != peer.Id) return new("incompatible", info, "A different node answers at this address now.");
            if (info.Capabilities?.Contains(Capability) != true) return new("incompatible", info, "The node's build is too old.");
            return new("online", info);
        }
        catch (HttpRequestException ex) when (PeerHttp.IsCertificateFailure(ex) && seen.Fingerprint is not null)
        {
            return new("certificate", Error: "The node presents a certificate other than the one trusted.", Certificate: seen);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException && !ct.IsCancellationRequested)
        {
            return new("offline", Error: Describe(ex));
        }
    }

    /// <summary>Tell a peer this node is forgetting it, so it drops the token it issued. Best effort.</summary>
    public async Task UnpairAsync(OutboundPeer peer, CancellationToken ct)
    {
        var token = peers.TokenFor(peer.Id);
        if (token is null) return;
        try
        {
            using var http = PeerHttp.CreateClient(peer.Fingerprint, timeout: TimeSpan.FromSeconds(5));
            using var request = new HttpRequestMessage(HttpMethod.Post, $"{peer.Url}/api/nodes/unpair");
            request.Headers.Authorization = new("Bearer", token);
            using var _ = await http.SendAsync(request, ct);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            log.LogInformation("Could not tell {Name} it was forgotten ({Error}); its token for this node stays until revoked there",
                peer.Name, Describe(ex));
        }
    }

    private static async Task<string?> ErrorOf(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            return doc.RootElement.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString() : null;
        }
        catch { return null; }
    }

    private static string Describe(Exception ex) => ex switch
    {
        TaskCanceledException => "it did not answer in time",
        HttpRequestException { InnerException: { } inner } => inner.Message,
        _ => ex.Message,
    };

    /// <summary>A node id as minted (a GUID's 32 hex digits) or anything like it: letters and digits, at most 64.</summary>
    public static bool IsNodeId([System.Diagnostics.CodeAnalysis.NotNullWhen(true)] string? id) =>
        !string.IsNullOrEmpty(id) && id.Length <= 64 && id.All(char.IsAsciiLetterOrDigit);

    private static string? Clip(string? value, int max)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > max ? trimmed[..max] : trimmed;
    }
}
