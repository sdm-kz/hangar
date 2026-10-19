using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Hangar.Server.Nodes;

/// <summary>A peer this node reaches, as the API shows it — everything but the token.</summary>
/// <param name="Url">Normalized by <see cref="NodeIdentityStore.NormalizeUrl"/>: no trailing slash.</param>
/// <param name="Fingerprint">
/// The pinned SHA-256 of the peer's certificate, for an https peer whose certificate the OS does not trust
/// (a self-signed one). Null for http, and for a certificate that validates — see <see cref="PeerHttp"/>.
/// </param>
public sealed record OutboundPeer(
    string Id,
    string Name,
    string Url,
    string? Color,
    string? Fingerprint,
    bool Enabled,
    DateTimeOffset AddedAt);

/// <summary>
/// The peers this node reaches and the token it holds for each, persisted to <c>nodes.json</c>.
/// </summary>
/// <remarks>
/// The tokens are the one thing in here worth stealing — each is a shell on another machine — so on Windows
/// they are sealed with DPAPI for the current user (the daemon always runs as the user, a service included).
/// Elsewhere the data folder is already owner-only (<c>Program.PrepareDataFolder</c>), and the file is made
/// so as well.
/// </remarks>
public sealed class PeerStore
{
    public const int MaxPeers = 64;
    private const string DpapiPrefix = "dpapi:";
    private const string PlainPrefix = "plain:";
    private static readonly byte[] DpapiEntropy = Encoding.UTF8.GetBytes("Hangar.PeerToken.v1");

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private sealed record Stored(
        string Id,
        string Name,
        string Url,
        string? Color,
        string? Fingerprint,
        bool Enabled,
        DateTimeOffset AddedAt,
        string Token);

    private readonly string _file;
    private readonly ILogger<PeerStore> _log;
    private readonly object _lock = new();
    private List<Stored> _peers = new();
    private bool _unreadable;
    // Tokens as unsealed, by peer id: the proxy wants one on every request it forwards, and DPAPI is not
    // free. Dropped on every change, so a re-pair or a forget is seen at once.
    private readonly Dictionary<string, string> _unsealed = new();

    /// <summary>Raised after any change, so whatever caches a connection per peer can drop it.</summary>
    public event Action? Changed;

    public PeerStore(ILogger<PeerStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("nodes.json");
        Load();
    }

    public IReadOnlyList<OutboundPeer> List()
    {
        lock (_lock) return _peers.Select(View).ToList();
    }

    public bool IsFull
    {
        get { lock (_lock) return _peers.Count >= MaxPeers; }
    }

    public OutboundPeer? Get(string id)
    {
        lock (_lock) return _peers.FirstOrDefault(p => p.Id == id) is { } p ? View(p) : null;
    }

    /// <summary>The token this node presents to <paramref name="id"/>, or null when there is none it can use.</summary>
    public string? TokenFor(string id)
    {
        Stored? peer;
        lock (_lock)
        {
            if (_unsealed.TryGetValue(id, out var cached)) return cached;
            peer = _peers.FirstOrDefault(p => p.Id == id);
        }
        if (peer is null || Unseal(peer.Token) is not { } token) return null;
        lock (_lock)
            // Only if it is still the same token: a re-pair while this was unsealing must not be undone.
            if (_peers.FirstOrDefault(p => p.Id == id)?.Token == peer.Token) _unsealed[id] = token;
        return token;
    }

    /// <summary>Add a peer, or replace the one with the same id (pairing again).</summary>
    /// <returns>Null when saved; otherwise why not.</returns>
    public string? Upsert(OutboundPeer peer, string token)
    {
        string sealedToken;
        try { sealedToken = Seal(token); }
        catch (CryptographicException ex)
        {
            // DPAPI has nothing to seal with — a service whose user profile isn't loaded, say.
            _log.LogWarning("Could not seal the token for node {Name} ({Error})", peer.Name, ex.GetType().Name);
            return "This node can't store the token securely (DPAPI failed); see the log.";
        }
        lock (_lock)
        {
            var i = _peers.FindIndex(p => p.Id == peer.Id);
            if (i < 0 && _peers.Count >= MaxPeers) return $"this node already has {MaxPeers} peers";
            var stored = new Stored(peer.Id, peer.Name, peer.Url, peer.Color, peer.Fingerprint, peer.Enabled, peer.AddedAt, sealedToken);
            if (i < 0) _peers.Add(stored);
            else _peers[i] = stored;
            Save();
        }
        Changed?.Invoke();
        return null;
    }

    /// <summary>Change what this node calls a peer and how it reaches it. A null field is left as it was.</summary>
    public OutboundPeer? Update(string id, string? name, string? color, string? url, bool? enabled)
    {
        OutboundPeer? result;
        lock (_lock)
        {
            var i = _peers.FindIndex(p => p.Id == id);
            if (i < 0) return null;
            var p = _peers[i];
            if (Clip(name, 64) is { } newName) p = p with { Name = newName };
            if (color is not null) p = p with { Color = Clip(color, 32) };
            // A new address is a new server as far as a pinned certificate goes: the pin goes with the old one.
            if (url is not null && url != p.Url) p = p with { Url = url, Fingerprint = null };
            if (enabled is not null) p = p with { Enabled = enabled.Value };
            _peers[i] = p;
            Save();
            result = View(p);
        }
        Changed?.Invoke();
        return result;
    }

    /// <summary>Pin <paramref name="fingerprint"/> as this peer's certificate — trusting a changed one, deliberately.</summary>
    public bool Trust(string id, string? fingerprint)
    {
        lock (_lock)
        {
            var i = _peers.FindIndex(p => p.Id == id);
            if (i < 0) return false;
            _peers[i] = _peers[i] with { Fingerprint = fingerprint };
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    public bool Remove(string id)
    {
        lock (_lock)
        {
            if (_peers.RemoveAll(p => p.Id == id) == 0) return false;
            Save();
        }
        Changed?.Invoke();
        return true;
    }

    /// <summary>Trimmed and bounded; null when blank.</summary>
    private static string? Clip(string? value, int max)
    {
        var trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > max ? trimmed[..max] : trimmed;
    }

    private static OutboundPeer View(Stored p) =>
        new(p.Id, p.Name, p.Url, p.Color, p.Fingerprint, p.Enabled, p.AddedAt);

    private static string Seal(string token)
    {
        if (!OperatingSystem.IsWindows()) return PlainPrefix + token;
        var bytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(token), DpapiEntropy, DataProtectionScope.CurrentUser);
        return DpapiPrefix + Convert.ToBase64String(bytes);
    }

    private string? Unseal(string sealedToken)
    {
        try
        {
            if (sealedToken.StartsWith(PlainPrefix, StringComparison.Ordinal)) return sealedToken[PlainPrefix.Length..];
            if (sealedToken.StartsWith(DpapiPrefix, StringComparison.Ordinal) && OperatingSystem.IsWindows())
            {
                var bytes = ProtectedData.Unprotect(Convert.FromBase64String(sealedToken[DpapiPrefix.Length..]),
                    DpapiEntropy, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(bytes);
            }
        }
        catch (Exception ex)
        {
            // Sealed by another Windows user, or on another machine (a copied data folder): the peer has
            // to be paired again from here. Not the token in the log — just that it could not be opened.
            _log.LogWarning("Could not unseal a peer token in {File} ({Error}); pair that node again", _file, ex.GetType().Name);
        }
        return null;
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            _peers = (JsonSerializer.Deserialize<List<Stored>>(File.ReadAllText(_file), JsonOpts) ?? new())
                .Where(p => p is not null && !string.IsNullOrEmpty(p.Id) && !string.IsNullOrEmpty(p.Url) && !string.IsNullOrEmpty(p.Token))
                .ToList();
        }
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _log.LogWarning(ex, "Could not read the peers from {File}; it will not be written this run", _file);
            _peers.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Not the exception's message in the log: System.Text.Json quotes the offending JSON, and a
            // plain-sealed token could be in it.
            _log.LogWarning("Could not load the peers from {File} ({Error}); setting it aside", _file, ex.GetType().Name);
            _peers.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "peers");
        }
    }

    private void Save()
    {
        _unsealed.Clear(); // under the lock, like every caller
        if (_unreadable) return;
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(_peers, JsonOpts));
            if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(_file, UnixFileMode.UserRead | UnixFileMode.UserWrite);
        }
        catch (Exception ex) { _log.LogWarning(ex, "Could not persist the peers to {File}", _file); }
    }
}
