using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Hangar.Server.Nodes;

/// <summary>A node allowed in: one peer token this node issued, as kept in <c>peers-in.json</c>.</summary>
/// <param name="Key">This entry's handle in the API: the first hex digits of the hash. Not a secret.</param>
/// <param name="TokenHash">SHA-256 of the token, hex. The token itself is never stored here.</param>
/// <param name="NodeId">The node it was issued to. Null for a moment while a pairing this node started is in flight.</param>
public sealed record InboundPeer(
    string Key,
    string TokenHash,
    string? NodeId,
    string? Name,
    string? Url,
    DateTimeOffset IssuedAt,
    DateTimeOffset? LastUsedAt);

/// <summary>
/// The peer tokens this node has issued — the credentials other nodes use to reach this one — persisted to
/// <c>peers-in.json</c>, <b>hashed</b>: the file says who may come in, and reading it lets nobody do so.
/// </summary>
/// <remarks>
/// <para>Kept apart from the browser tokens (<see cref="Auth.TokenStore"/>) on purpose. Those are dropped after
/// 30 days on the assumption that a browser logs in again; a peer cannot, and it would go dark a month after
/// pairing. And a request that authenticated with one of these is a peer, not a person — which the proxy's
/// hop guard and the node management endpoints need to tell apart.</para>
/// <para>A plain SHA-256 rather than the password's PBKDF2: the token is 32 random bytes, so there is nothing
/// for a slow hash to protect against, and it is checked on every request a peer makes.</para>
/// </remarks>
public sealed class PeerTokenStore
{
    private const int MaxEntries = 200;
    // How stale "last used" may get in the file. It is kept exact in memory; writing the file on every
    // request a peer makes would be a disk write per terminal keystroke relayed through it.
    private static readonly TimeSpan LastUsedPersistEvery = TimeSpan.FromMinutes(5);

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _file;
    private readonly ILogger<PeerTokenStore> _log;
    private readonly object _lock = new();
    private List<InboundPeer> _peers = new();
    private bool _unreadable;
    private DateTimeOffset _lastPersisted = DateTimeOffset.MinValue;
    // One per entry that has had a request through it: cancelled when the entry goes, which is what makes a
    // revocation reach a connection already open — a relayed terminal would otherwise outlive it for hours.
    private readonly Dictionary<string, CancellationTokenSource> _cuts = new();

    public PeerTokenStore(ILogger<PeerTokenStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("peers-in.json");
        Load();
    }

    public IReadOnlyList<InboundPeer> List()
    {
        lock (_lock) return _peers.Where(p => p.NodeId is not null).ToList();
    }

    /// <summary>
    /// Mint a token for <paramref name="nodeId"/> and remember its hash. Any token issued to the same node
    /// before is revoked by this: a node pairs again when it lost the old one, and two live credentials for
    /// one peer is one more than anybody can account for.
    /// </summary>
    /// <returns>The token, which exists nowhere else once the caller has sent it — and the entry's key.</returns>
    public (string Token, string Key) Issue(string? nodeId, string? name, string? url)
    {
        var token = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        var hash = Hash(token);
        lock (_lock)
        {
            if (nodeId is not null) Drop(p => p.NodeId == nodeId);
            if (_peers.Count >= MaxEntries) // the oldest goes; no store grows forever
            {
                var oldest = _peers[0].Key;
                Drop(p => p.Key == oldest);
            }
            _peers.Add(new InboundPeer(hash[..16], hash, nodeId, name, url, DateTimeOffset.UtcNow, null));
            Save();
        }
        return (token, hash[..16]);
    }

    /// <summary>
    /// Name the node a pending token was issued to, once the pairing that minted it has learned who the other
    /// side is. Revokes any earlier token for that node, as <see cref="Issue"/> does.
    /// </summary>
    public void Bind(string key, string nodeId, string? name, string? url)
    {
        lock (_lock)
        {
            var i = _peers.FindIndex(p => p.Key == key);
            if (i < 0) return;
            Drop(p => p.NodeId == nodeId && p.Key != key);
            i = _peers.FindIndex(p => p.Key == key);
            _peers[i] = _peers[i] with { NodeId = nodeId, Name = name, Url = url };
            Save();
        }
    }

    /// <summary>Revoke the token with this key: refused from the next request on, and what is open on it is cut.</summary>
    public bool Remove(string key)
    {
        lock (_lock)
        {
            if (Drop(p => p.Key == key) == 0) return false;
            Save();
            return true;
        }
    }

    /// <summary>Revoke every token issued to <paramref name="nodeId"/>.</summary>
    public bool RemoveNode(string nodeId)
    {
        lock (_lock)
        {
            if (Drop(p => p.NodeId == nodeId) == 0) return false;
            Save();
            return true;
        }
    }

    /// <summary>
    /// The entry <paramref name="token"/> was issued as, or null when it is not a peer token of this node.
    /// A pending one (issued for a pairing still in flight) counts: the other side calls back with it to
    /// prove the way back works before the pairing finishes.
    /// </summary>
    public InboundPeer? Validate(string? token)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 256) return null;
        // A plain compare is enough: what is compared is a hash, and how long it takes to find a mismatch in
        // one tells nobody anything about a token that would produce it.
        var hash = Hash(token);
        lock (_lock)
        {
            var i = _peers.FindIndex(p => string.Equals(p.TokenHash, hash, StringComparison.Ordinal));
            if (i < 0) return null;
            var now = DateTimeOffset.UtcNow;
            _peers[i] = _peers[i] with { LastUsedAt = now };
            if (now - _lastPersisted > LastUsedPersistEvery)
            {
                // Before the write, not after it: a write that keeps failing must not be retried on every
                // request a peer makes, under this lock.
                _lastPersisted = now;
                Save();
            }
            return _peers[i];
        }
    }

    /// <summary>
    /// Cancelled when the entry with this key is revoked — already cancelled when it is gone. A request a peer
    /// makes is tied to it (see TokenAuthMiddleware), so a revocation cuts what is open as well as what comes.
    /// </summary>
    public CancellationToken RevokedToken(string key)
    {
        lock (_lock)
        {
            if (!_peers.Any(p => p.Key == key)) return new CancellationToken(canceled: true);
            if (!_cuts.TryGetValue(key, out var cut)) _cuts[key] = cut = new CancellationTokenSource();
            return cut.Token;
        }
    }

    /// <summary>Remove the matching entries and cut what is open on them. Under the lock; does not save.</summary>
    private int Drop(Predicate<InboundPeer> match)
    {
        var gone = _peers.Where(p => match(p)).Select(p => p.Key).ToList();
        _peers.RemoveAll(match);
        foreach (var key in gone)
            if (_cuts.Remove(key, out var cut))
            {
                cut.Cancel();
                cut.Dispose();
            }
        return gone.Count;
    }

    private static string Hash(string token) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            _peers = (JsonSerializer.Deserialize<List<InboundPeer>>(File.ReadAllText(_file), JsonOpts) ?? new())
                .Where(p => p is not null && !string.IsNullOrEmpty(p.TokenHash) && !string.IsNullOrEmpty(p.Key)
                            // A pending entry outlived the pairing that made it (the app stopped mid-way):
                            // nobody holds its token any more.
                            && p.NodeId is not null)
                .ToList();
        }
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Fail closed: no peer gets in this run, and the file is not written over.
            _log.LogWarning(ex, "Could not read the peer tokens from {File}; no peer can connect this run", _file);
            _peers.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            _log.LogWarning("Could not load the peer tokens from {File} ({Error}); setting it aside — peers must pair again",
                _file, ex.GetType().Name);
            _peers.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "peer tokens");
        }
    }

    private void Save()
    {
        if (_unreadable) return;
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(_peers, JsonOpts));
            _lastPersisted = DateTimeOffset.UtcNow;
        }
        catch (Exception ex) { _log.LogWarning(ex, "Could not persist the peer tokens to {File}", _file); }
    }
}
