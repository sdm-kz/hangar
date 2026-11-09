using System.Text.Json;

namespace Hangar.Server.Sessions;

/// <summary>
/// A yes/no the user sets on a session, persisted to a file of its own under %LocalAppData%\Hangar so
/// it follows the session across every browser and device. <see cref="PinStore"/> and
/// <see cref="ActivityPauseStore"/> are the two.
///
/// <para>Keyed by <b>Claude's conversation id</b>, not by our session id. A session id is minted afresh
/// every time a conversation is resumed, so an id-keyed flag evaporates on the first reopen — which is
/// exactly what it has to survive. The conversation is the thing the user marked; the session is just
/// the process currently running it.</para>
///
/// <para>A session younger than its first hook has no conversation id yet, so it is marked under a
/// <c>session:</c> fallback key and re-keyed by <see cref="Rekey"/> the moment the id arrives. Without
/// that, marking it in the first seconds of a session would silently do nothing.</para>
/// </summary>
public abstract class ConversationFlagStore
{
    // Far more than anyone marks, but bounded: a key whose conversation is long gone is never cleaned
    // up (we can't tell a forgotten conversation from one that just isn't loaded right now), so the
    // file would otherwise grow for the life of the install.
    private const int MaxKeys = 500;

    /// <summary>Fallback key for a session whose conversation id isn't known yet.</summary>
    public static string SessionKey(string sessionId) => "session:" + sessionId;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _file;
    // The file's one property, which holds the keys: `pins` in pins.json.
    private readonly string _property;
    // What the log calls these keys: "pinned sessions".
    private readonly string _what;
    private readonly ILogger _log;
    private readonly object _lock = new();
    // Insertion-ordered so trimming drops the oldest keys first.
    private LinkedList<string> _keys = new();
    private HashSet<string> _index = new(StringComparer.Ordinal);

    protected ConversationFlagStore(ILogger log, string fileName, string property, string what)
    {
        _log = log;
        _file = AppDataFolder.PathFor(fileName);
        _property = property;
        _what = what;
        Load();
    }

    /// <summary>Whether this key is set. A null/blank key never is.</summary>
    public bool Has(string? key)
    {
        if (string.IsNullOrEmpty(key)) return false;
        lock (_lock) return _index.Contains(key);
    }

    /// <summary>Set or clear a key. Returns whether anything changed.</summary>
    public bool Set(string? key, bool on)
    {
        if (string.IsNullOrEmpty(key)) return false;
        lock (_lock)
        {
            if (on)
            {
                if (!_index.Add(key)) return false;
                _keys.AddLast(key);
                while (_keys.Count > MaxKeys && _keys.First is { } oldest)
                {
                    _index.Remove(oldest.Value);
                    _keys.RemoveFirst();
                }
            }
            else
            {
                if (!_index.Remove(key)) return false;
                for (var node = _keys.First; node is not null; node = node.Next)
                    if (node.Value == key) { _keys.Remove(node); break; }
            }
            Save();
            return true;
        }
    }

    /// <summary>
    /// Move a key's mark onto another key, keeping its place. Used when a session's conversation id
    /// finally arrives and its <c>session:</c> fallback key can be replaced by the real one. A no-op
    /// when nothing is set under <paramref name="from"/>.
    /// </summary>
    public bool Rekey(string? from, string? to)
    {
        if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to) || from == to) return false;
        lock (_lock)
        {
            if (!_index.Contains(from)) return false;
            // Already set under the new key (a /resume into a conversation flagged before): one entry is enough.
            if (_index.Contains(to)) _keys.Remove(from);
            else
                for (var node = _keys.First; node is not null; node = node.Next)
                    if (node.Value == from) { node.Value = to; break; }
            _index.Remove(from);
            _index.Add(to);
            Save();
            return true;
        }
    }

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Dictionary<string, List<string>?>>(File.ReadAllText(_file), Json);
            var keys = p?.FirstOrDefault(kv => string.Equals(kv.Key, _property, StringComparison.OrdinalIgnoreCase)).Value;
            if (keys is null) return;
            _keys = new LinkedList<string>(
                keys.Where(k => !string.IsNullOrWhiteSpace(k)).Distinct(StringComparer.Ordinal).Take(MaxKeys));
            _index = new HashSet<string>(_keys, StringComparer.Ordinal);
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read {What} from {File}; it will not be written this run", _what, _file);
            _keys.Clear();
            _index.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load {What} from {File}; setting it aside", _what, _file);
            _keys.Clear();
            _index.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, _what);
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing {What}: {File} could not be read at startup", _what, _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Dictionary<string, List<string>> { [_property] = _keys.ToList() }, Json));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist {What} to {File}", _what, _file);
        }
    }
}
