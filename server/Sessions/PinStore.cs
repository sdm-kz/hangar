using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// Sessions the user has pinned to the top of their folder, persisted to
/// %LocalAppData%\ClaudeWeb\pins.json so a pin follows them across every browser and device — like
/// the recents and projects, and unlike the sidebar's other view preferences, which stay per-browser.
///
/// <para>Pins are keyed by <b>Claude's conversation id</b>, not by our session id. A session id is
/// minted afresh every time a conversation is resumed, so an id-keyed pin evaporates on the first
/// reopen — which is exactly what it has to survive. The conversation is the thing the user pinned;
/// the session is just the process currently running it.</para>
///
/// <para>A session younger than its first hook has no conversation id yet, so it pins under a
/// <c>session:</c> fallback key and is re-keyed by <see cref="Rekey"/> the moment the id arrives.
/// Without that, pinning in the first seconds of a session would silently do nothing.</para>
/// </summary>
public sealed class PinStore
{
    // Far more than anyone pins, but bounded: a key whose conversation is long gone is never cleaned
    // up (we can't tell a forgotten conversation from one that just isn't loaded right now), so the
    // file would otherwise grow for the life of the install.
    private const int MaxPins = 500;

    /// <summary>Fallback key for a session whose conversation id isn't known yet.</summary>
    public static string SessionKey(string sessionId) => "session:" + sessionId;

    private readonly string _file;
    private readonly ILogger<PinStore> _log;
    private readonly object _lock = new();
    // Insertion-ordered so trimming drops the oldest pins first.
    private LinkedList<string> _pins = new();
    private HashSet<string> _index = new(StringComparer.Ordinal);

    public PinStore(ILogger<PinStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "pins.json");
        Load();
    }

    /// <summary>Whether this key is pinned. A null/blank key never is.</summary>
    public bool IsPinned(string? key)
    {
        if (string.IsNullOrEmpty(key)) return false;
        lock (_lock) return _index.Contains(key);
    }

    /// <summary>Pin or unpin a key. Returns whether anything changed.</summary>
    public bool Set(string? key, bool pinned)
    {
        if (string.IsNullOrEmpty(key)) return false;
        lock (_lock)
        {
            if (pinned)
            {
                if (!_index.Add(key)) return false;
                _pins.AddLast(key);
                while (_pins.Count > MaxPins && _pins.First is { } oldest)
                {
                    _index.Remove(oldest.Value);
                    _pins.RemoveFirst();
                }
            }
            else
            {
                if (!_index.Remove(key)) return false;
                for (var node = _pins.First; node is not null; node = node.Next)
                    if (node.Value == key) { _pins.Remove(node); break; }
            }
            Save();
            return true;
        }
    }

    /// <summary>
    /// Move a pin from one key to another, keeping its place. Used when a session's conversation id
    /// finally arrives and its <c>session:</c> fallback key can be replaced by the real one. A no-op
    /// when nothing is pinned under <paramref name="from"/>.
    /// </summary>
    public bool Rekey(string? from, string? to)
    {
        if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to) || from == to) return false;
        lock (_lock)
        {
            if (!_index.Contains(from)) return false;
            for (var node = _pins.First; node is not null; node = node.Next)
                if (node.Value == from) { node.Value = to; break; }
            _index.Remove(from);
            _index.Add(to);
            Save();
            return true;
        }
    }

    private sealed record Persisted(List<string>? Pins);

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(
                File.ReadAllText(_file), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (p?.Pins is null) return;
            _pins = new LinkedList<string>(
                p.Pins.Where(k => !string.IsNullOrWhiteSpace(k)).Distinct(StringComparer.Ordinal).Take(MaxPins));
            _index = new HashSet<string>(_pins, StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read pinned sessions from {File}", _file);
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            File.WriteAllText(_file, JsonSerializer.Serialize(
                new Persisted(_pins.ToList()),
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist pinned sessions to {File}", _file);
        }
    }
}
