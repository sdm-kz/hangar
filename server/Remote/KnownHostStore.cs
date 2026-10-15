using System.Text.Json;

namespace ClaudeWeb.Server.Remote;

public enum HostKeyVerdict { Known, Unknown, Changed }

/// <summary>
/// The SSH host keys this app has been told to trust, persisted to
/// %LocalAppData%\ClaudeWeb\ssh-known-hosts.json — trust on first use, the way OpenSSH asks the first
/// time. A key is only ever added because a person looked at its fingerprint and said yes; a host
/// that later presents a <em>different</em> key of the same type is refused until someone says yes
/// to that one too, deliberately.
///
/// <para>Kept apart from the user's own <c>~/.ssh/known_hosts</c> on purpose: that file has a format
/// with hashed names and markers this app would have to round-trip exactly, and a bug here must not
/// be able to corrupt what the user's own ssh relies on.</para>
///
/// <para>Keyed by host, port and key type. A host offers several key types and which one is
/// negotiated can change with either side's software, so a type not seen before is "unknown" (ask)
/// rather than "changed" (alarm).</para>
/// </summary>
public sealed class KnownHostStore
{
    private const int MaxEntries = 2000;

    private readonly string _file;
    private readonly ILogger<KnownHostStore> _log;
    private readonly object _lock = new();
    private Dictionary<string, string> _keys = new(StringComparer.Ordinal);
    private bool _unreadable;

    public KnownHostStore(ILogger<KnownHostStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "ssh-known-hosts.json");
        Load();
    }

    private static string Key(string host, int port, string type) =>
        $"[{host.ToLowerInvariant()}]:{port} {type}";

    public HostKeyVerdict Check(string host, int port, string type, string fingerprint)
    {
        lock (_lock)
            return !_keys.TryGetValue(Key(host, port, type), out var known) ? HostKeyVerdict.Unknown
                : known == fingerprint ? HostKeyVerdict.Known
                : HostKeyVerdict.Changed;
    }

    /// <summary>
    /// Whether a key of some <em>other</em> type is trusted for this host — the case OpenSSH warns
    /// about when a host that used to present one kind of key now presents another.
    /// </summary>
    public bool KnowsOtherType(string host, int port, string type)
    {
        var prefix = $"[{host.ToLowerInvariant()}]:{port} ";
        lock (_lock) return _keys.Keys.Any(k => k.StartsWith(prefix, StringComparison.Ordinal) && k != Key(host, port, type));
    }

    public void Trust(string host, int port, string type, string fingerprint)
    {
        lock (_lock)
        {
            if (_keys.Count >= MaxEntries && !_keys.ContainsKey(Key(host, port, type))) return;
            _keys[Key(host, port, type)] = fingerprint;
            Save();
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            _keys = JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(_file))
                    ?? new Dictionary<string, string>();
            _keys = new Dictionary<string, string>(
                _keys.Where(kv => !string.IsNullOrEmpty(kv.Key) && !string.IsNullOrEmpty(kv.Value)),
                StringComparer.Ordinal);
        }
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _log.LogWarning(ex, "Could not read SSH host keys from {File}; it will not be written this run", _file);
            _keys.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not load SSH host keys from {File}; setting it aside", _file);
            _keys.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "SSH host keys");
        }
    }

    private void Save()
    {
        if (_unreadable) return;
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(_keys, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist SSH host keys to {File}", _file);
        }
    }
}
