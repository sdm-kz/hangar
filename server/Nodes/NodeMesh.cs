using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hangar.Server.Nodes;

/// <summary>A peer as the mesh sees it right now, for <c>/hub/events</c>' <c>nodes</c> and the push notifier.</summary>
/// <param name="Status">
/// <c>connecting</c> (not heard from yet), <c>online</c>, <c>offline</c>, <c>unauthorized</c>, <c>incompatible</c> or
/// <c>certificate</c> (it presents a certificate other than the pinned one).
/// </param>
/// <param name="LastSeen">When the last frame came from it — set once it stops being online, null while it is.</param>
/// <param name="Snapshot">Its own <c>/hub/events</c> message, verbatim; null unless online.</param>
public sealed record MeshNode(
    string Id,
    string Name,
    string? Color,
    string Status,
    string? Error,
    string? Version,
    string? Os,
    DateTimeOffset? LastSeen,
    JsonElement? Snapshot);

/// <summary>
/// The live picture of every peer, held here so the browser, the tray and the push notifier read it off this
/// node's own <c>/hub/events</c> (plans/multi-node.md §5). One socket per enabled peer, to its
/// <c>/hub/events?client=peer</c>, reconnected with a backoff; its snapshot is kept whole and passed on unparsed.
/// </summary>
/// <remarks>
/// <para><b>Tick.</b> A peer client gets the slow tick a tray does, unless it is told <c>fast</c>: this node says
/// so while a browser is looking at it (<see cref="SetFast"/>), and <c>slow</c> once none is.</para>
/// <para><b>Status.</b> A socket's failure says nothing about why, so before each connect the peer is probed
/// (<see cref="NodePairing.ProbeAsync"/>) — which is also where its version comes from, and how a certificate
/// change or a revoked token is told apart from a machine that is off.</para>
/// </remarks>
public sealed class NodeMesh : BackgroundService
{
    // Silence longer than this on a socket the peer keeps alive every few seconds means it is dead.
    private static readonly TimeSpan Stale = TimeSpan.FromSeconds(15);
    // A machine back from a reboot shows up within this; probing one that is off this often costs nothing.
    private static readonly TimeSpan MaxBackoff = TimeSpan.FromSeconds(20);
    // A snapshot is a few kilobytes per dozen sessions; this is only there so a peer can't fill this node's memory.
    // A snapshot is passed on to every browser here on every change, so this is far above anything real (a
    // few kilobytes per dozen sessions) but well short of what would make each of those a burden.
    private const int MaxFrame = 2 * 1024 * 1024;

    private readonly PeerStore _peers;
    private readonly NodePairing _pairing;
    private readonly ILogger<NodeMesh> _log;
    private readonly ConcurrentDictionary<string, Link> _links = new();
    private readonly SemaphoreSlim _reconcile = new(0, 1);
    private volatile bool _fast;

    /// <summary>Raised when any peer's status or snapshot changes — never for a keep-alive.</summary>
    public event Action? Changed;

    public NodeMesh(PeerStore peers, NodePairing pairing, ILogger<NodeMesh> log)
    {
        _peers = peers;
        _pairing = pairing;
        _log = log;
        _peers.Changed += Reconcile;
    }

    /// <summary>Every enabled peer, in the order they were added, named as this node calls them.</summary>
    public IReadOnlyList<MeshNode> Nodes()
    {
        var list = new List<MeshNode>();
        foreach (var peer in _peers.List())
        {
            if (!peer.Enabled) continue;
            var state = _links.TryGetValue(peer.Id, out var link) ? link.State : null;
            list.Add(new MeshNode(peer.Id, peer.Name, peer.Color, state?.Status ?? "connecting", state?.Error,
                state?.Version, state?.Os, state?.LastSeen, state?.Snapshot));
        }
        return list;
    }

    /// <summary>Whether a browser is looking at this node, and so whether the peers should send at a browser's pace.</summary>
    public void SetFast(bool fast)
    {
        if (_fast == fast) return;
        _fast = fast;
        foreach (var link in _links.Values) link.SendMode();
    }

    private void Reconcile()
    {
        try { _reconcile.Release(); } catch (SemaphoreFullException) { /* one is pending */ }
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try { Apply(ct); }
            catch (Exception ex) { _log.LogWarning(ex, "Could not bring the node connections up to date"); }
            try { await _reconcile.WaitAsync(ct); }
            catch (OperationCanceledException) { break; }
        }
        foreach (var (id, link) in _links)
            if (_links.TryRemove(id, out _)) link.Stop();
    }

    /// <summary>One link per enabled peer, on its current address, certificate and token; anything else goes.</summary>
    private void Apply(CancellationToken ct)
    {
        var wanted = new Dictionary<string, (OutboundPeer Peer, string Signature)>();
        foreach (var peer in _peers.List())
            if (peer.Enabled && _peers.TokenFor(peer.Id) is { } token)
                wanted[peer.Id] = (peer, Signature(peer, token));

        var changed = false;
        foreach (var (id, link) in _links)
        {
            if (wanted.TryGetValue(id, out var w) && w.Signature == link.Signature) continue;
            if (_links.TryRemove(new KeyValuePair<string, Link>(id, link))) link.Stop();
            changed = true;
        }
        foreach (var (id, (peer, signature)) in wanted)
        {
            if (_links.ContainsKey(id)) continue;
            var link = new Link(this, peer, signature);
            _links[id] = link;
            link.Start(ct);
            changed = true;
        }
        if (changed) Changed?.Invoke();
    }

    // The token is in it so a re-pair (same address, new token) reconnects; hashed, so it isn't kept twice in the clear.
    private static string Signature(OutboundPeer peer, string token) =>
        $"{peer.Url}\n{peer.Fingerprint}\n{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)))}";

    private void Raise()
    {
        try { Changed?.Invoke(); }
        catch (Exception ex) { _log.LogDebug(ex, "A mesh listener failed"); }
    }

    public override void Dispose()
    {
        _peers.Changed -= Reconcile;
        base.Dispose();
    }

    private sealed record LinkState(string Status, string? Error, string? Version, string? Os, DateTimeOffset? LastSeen,
        JsonElement? Snapshot);

    /// <summary>The connection to one peer, for as long as its address, certificate and token stay as they were.</summary>
    private sealed class Link(NodeMesh mesh, OutboundPeer peer, string signature)
    {
        private readonly CancellationTokenSource _stop = new();
        private readonly SemaphoreSlim _sending = new(1, 1);
        private ClientWebSocket? _socket;
        private string? _lastRaw;
        private DateTimeOffset? _lastFrame;

        public string Signature { get; } = signature;
        public LinkState? State { get; private set; }

        public void Start(CancellationToken hostCt)
        {
            var linked = CancellationTokenSource.CreateLinkedTokenSource(hostCt, _stop.Token);
            _ = Task.Run(async () =>
            {
                try { await RunAsync(linked.Token); }
                finally
                {
                    // Its registration on the host's token goes with it: links are replaced on every re-pair.
                    linked.Dispose();
                    _stop.Dispose();
                }
            });
        }

        public void Stop()
        {
            try { _stop.Cancel(); } catch (ObjectDisposedException) { }
        }

        /// <summary>Tell the peer the pace this node wants now.</summary>
        public void SendMode()
        {
            if (_socket is { State: WebSocketState.Open } ws) _ = SendModeAsync(ws);
        }

        // The pace is read once the send is this one's turn, so whichever send goes last says what is current.
        private async Task SendModeAsync(ClientWebSocket ws)
        {
            try
            {
                await _sending.WaitAsync(_stop.Token);
                try
                {
                    var text = mesh._fast ? "fast" : "slow";
                    await ws.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, _stop.Token);
                }
                finally { _sending.Release(); }
            }
            catch { /* stopped, or a dead socket — which the receive loop notices */ }
        }

        private void Set(LinkState state)
        {
            if (State == state) return;
            State = state;
            mesh.Raise();
        }

        /// <summary>Not online any more: the snapshot goes, and the time it was last heard from stays.</summary>
        private void Lost(string status, string? error, string? version = null, string? os = null)
        {
            _lastRaw = null;
            var lastSeen = _lastFrame ?? State?.LastSeen;
            Set(new LinkState(status, error, version ?? State?.Version, os ?? State?.Os, lastSeen, null));
        }

        private async Task RunAsync(CancellationToken ct)
        {
            var delay = TimeSpan.FromSeconds(1);
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    var probe = await mesh._pairing.ProbeAsync(peer, ct);
                    if (probe.Status != "online")
                    {
                        Lost(probe.Status, probe.Error, probe.Node?.Version, probe.Node?.Os);
                    }
                    else
                    {
                        var (version, os) = (probe.Node?.Version, probe.Node?.Os);
                        if (await FollowAsync(version, os, ct)) delay = TimeSpan.FromSeconds(1);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    mesh._log.LogDebug(ex, "The connection to node {Name} failed", peer.Name);
                    Lost("offline", "The connection to it dropped.");
                }

                try { await Task.Delay(delay, ct); }
                catch (OperationCanceledException) { break; }
                delay = TimeSpan.FromTicks(Math.Min(delay.Ticks * 2, MaxBackoff.Ticks));
            }
        }

        /// <summary>Hold the socket until it ends. True when it got as far as a snapshot, which resets the backoff.</summary>
        private async Task<bool> FollowAsync(string? version, string? os, CancellationToken ct)
        {
            if (mesh._peers.TokenFor(peer.Id) is not { } token)
            {
                Lost("unauthorized", "The token for this node can't be read here; pair it again.");
                return false;
            }
            var uri = new UriBuilder(peer.Url + "/hub/events")
            {
                Scheme = peer.Url.StartsWith("https:", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws",
                Query = "client=peer",
            }.Uri;

            using var invoker = new HttpMessageInvoker(PeerHttp.CreateHandler(peer.Fingerprint), disposeHandler: true);
            using var ws = new ClientWebSocket();
            ws.Options.SetRequestHeader("Authorization", $"Bearer {token}");
            ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(30);
            using (var connectCt = CancellationTokenSource.CreateLinkedTokenSource(ct))
            {
                connectCt.CancelAfter(TimeSpan.FromSeconds(15));
                await ws.ConnectAsync(uri, invoker, connectCt.Token);
            }
            _socket = ws;
            await SendModeAsync(ws);

            var gotOne = false;
            var buffer = new byte[16 * 1024];
            using var frame = new MemoryStream();
            while (!ct.IsCancellationRequested)
            {
                frame.SetLength(0);
                WebSocketReceiveResult r;
                using (var stale = CancellationTokenSource.CreateLinkedTokenSource(ct))
                {
                    stale.CancelAfter(Stale);
                    try
                    {
                        do
                        {
                            r = await ws.ReceiveAsync(buffer, stale.Token);
                            if (r.MessageType == WebSocketMessageType.Close) break;
                            frame.Write(buffer, 0, r.Count);
                            if (frame.Length > MaxFrame) throw new InvalidDataException("snapshot too large");
                        } while (!r.EndOfMessage);
                    }
                    catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                    {
                        Lost("offline", "It stopped answering.");
                        return gotOne;
                    }
                }
                if (r.MessageType == WebSocketMessageType.Close)
                {
                    // Its own restart, an update, a revoke: whichever, the probe on the way back in says.
                    Lost("offline", "It closed the connection.");
                    return gotOne;
                }
                _lastFrame = DateTimeOffset.UtcNow;
                if (r.MessageType != WebSocketMessageType.Text) continue;

                var raw = Encoding.UTF8.GetString(frame.GetBuffer(), 0, (int)frame.Length);
                // The peer re-sends an unchanged snapshot every few seconds as its keep-alive: same bytes, no news.
                if (raw == _lastRaw) continue;
                if (Parse(raw) is not { } snapshot) continue;
                _lastRaw = raw;
                gotOne = true;
                Set(new LinkState("online", null, version, os, null, snapshot));
            }
            return gotOne;
        }

        /// <summary>
        /// The snapshot as it is passed on: a JSON object, less any picture of the peer's own peers — a peer
        /// that sent one (a build that doesn't know it is talking to a peer) must not get a second hop that way.
        /// </summary>
        private static JsonElement? Parse(string raw)
        {
            try
            {
                using var doc = JsonDocument.Parse(raw);
                if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
                if (!doc.RootElement.TryGetProperty("nodes", out _) && !doc.RootElement.TryGetProperty("node", out _))
                    return doc.RootElement.Clone();
                var obj = JsonNode.Parse(raw)!.AsObject();
                obj.Remove("nodes");
                obj.Remove("node");
                return JsonSerializer.SerializeToElement(obj);
            }
            catch (JsonException) { return null; }
        }
    }
}
