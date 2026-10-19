using System.Text.Json;

namespace Hangar.Server.Nodes;

/// <summary>Who this node is: the record in <c>node.json</c>.</summary>
/// <param name="Id">Minted once, never changes. Everything that names a node holds this.</param>
/// <param name="Name">Defaults to the machine name; shown on the node's heading and in pickers.</param>
/// <param name="Color">A palette name, like a project's. Null: no accent.</param>
/// <param name="Url">
/// The address peers reach this node at, sent to a peer during mutual pairing. Null: the peer uses the
/// address the pairing request came from, with this node's port.
/// </param>
public sealed record NodeIdentity(string Id, string Name, string? Color, string? Url);

/// <summary>
/// This node's identity, persisted to <c>node.json</c> in the data folder. The id is minted the first time
/// it is asked for and kept for good: a peer stores it, and a node whose id changed would be a stranger to
/// every peer it had.
/// </summary>
/// <remarks>
/// The data folder is shared by every instance on the machine, so a second instance has the same identity
/// unless it runs with <c>HANGAR_TEST_ROOT</c> — which is why pairing refuses a peer whose id is this one.
/// </remarks>
public sealed class NodeIdentityStore
{
    private const int MaxNameLength = 64;
    private const int MaxColorLength = 32;
    private const int MaxUrlLength = 512;

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _file;
    private readonly ILogger<NodeIdentityStore> _log;
    private readonly object _lock = new();
    private NodeIdentity _identity;
    // Set when node.json is there but couldn't be read: this run gets an identity of its own, and the file
    // is left alone, since the id in it is the one every peer knows this node by.
    private bool _unreadable;

    public NodeIdentityStore(ILogger<NodeIdentityStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("node.json");
        _identity = Load() ?? Mint();
    }

    /// <summary>
    /// Whether this run's identity is a stand-in, node.json having been there but unreadable. Pairing is refused
    /// while it is: a peer would remember an id this node forgets at its next start.
    /// </summary>
    public bool IsTemporary => _unreadable;

    public NodeIdentity Current
    {
        get { lock (_lock) return _identity; }
    }

    /// <summary>
    /// Rename, recolour or re-address this node. A null field is left as it was; an empty colour or URL
    /// clears it. Returns the error to show, or null when it was saved.
    /// </summary>
    public string? Update(string? name, string? color, string? url)
    {
        lock (_lock)
        {
            var next = _identity;
            if (name is not null)
            {
                var clean = name.Trim();
                if (clean.Length == 0) return "the name can't be empty";
                next = next with { Name = clean.Length > MaxNameLength ? clean[..MaxNameLength] : clean };
            }
            if (color is not null)
            {
                var clean = color.Trim();
                next = next with { Color = clean.Length == 0 ? null : clean.Length > MaxColorLength ? clean[..MaxColorLength] : clean };
            }
            if (url is not null)
            {
                var clean = url.Trim();
                if (clean.Length == 0) next = next with { Url = null };
                else if (NormalizeUrl(clean) is { } normalized) next = next with { Url = normalized };
                else return "the address must be an http:// or https:// URL";
            }
            _identity = next;
            Save();
            return null;
        }
    }

    /// <summary>
    /// An http(s) URL with its path, query and trailing slash taken off — the form every peer URL is kept in,
    /// so that "{url}/api/node" is always one slash. Null when <paramref name="url"/> isn't one.
    /// </summary>
    public static string? NormalizeUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url) || url.Length > MaxUrlLength) return null;
        if (!Uri.TryCreate(url.Trim(), UriKind.Absolute, out var uri)) return null;
        if (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) return null;
        if (!string.IsNullOrEmpty(uri.UserInfo)) return null;
        // A reverse proxy may well serve the app under a path, so the path stays; only the slash goes.
        var path = uri.AbsolutePath.TrimEnd('/');
        return $"{uri.Scheme}://{uri.Authority}{path}";
    }

    private NodeIdentity Mint()
    {
        var identity = new NodeIdentity(Guid.NewGuid().ToString("n"), DefaultName(), null, null);
        lock (_lock)
        {
            _identity = identity;
            Save();
        }
        return identity;
    }

    private static string DefaultName()
    {
        var name = Environment.MachineName;
        return string.IsNullOrWhiteSpace(name) ? "Hangar" : name;
    }

    private NodeIdentity? Load()
    {
        try
        {
            if (!File.Exists(_file)) return null;
            var saved = JsonSerializer.Deserialize<NodeIdentity>(File.ReadAllText(_file), JsonOpts);
            // The id must be one a peer accepts (see NodePairing.IsNodeId), or every pairing would fail on it.
            if (saved is null || !NodePairing.IsNodeId(saved.Id)) throw new InvalidDataException("no usable id");
            return saved with { Name = string.IsNullOrWhiteSpace(saved.Name) ? DefaultName() : saved.Name.Trim() };
        }
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _log.LogWarning(ex, "Could not read the node identity from {File}; this run uses a temporary one and " +
                "peers will not recognise it", _file);
            _unreadable = true;
            return new NodeIdentity(Guid.NewGuid().ToString("n"), DefaultName(), null, null);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not load the node identity from {File}; setting it aside and minting a new one", _file);
            _unreadable = !StateFile.SetAside(_file, _log, "node identity");
            return null;
        }
    }

    private void Save()
    {
        if (_unreadable) return;
        try { StateFile.Write(_file, JsonSerializer.Serialize(_identity, JsonOpts)); }
        catch (Exception ex) { _log.LogWarning(ex, "Could not persist the node identity to {File}", _file); }
    }
}
