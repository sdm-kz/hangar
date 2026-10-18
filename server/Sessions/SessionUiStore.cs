using System.Text.Json;

namespace Hangar.Server.Sessions;

/// <summary>
/// How a session was last being looked at — which view tab was showing, which files are open as
/// tabs, which folders the tree has expanded — persisted to
/// %LocalAppData%\Hangar\session-ui.json so it follows the user to every browser and device,
/// like the pins, recents and projects.
///
/// <para>Keyed by <b>Claude's conversation id</b> for the same reason pins are: a session id is
/// minted afresh on every resume, so id-keyed state would evaporate the first time the conversation
/// is reopened — and the open files are a fact about the work, not about the process running it. A
/// session younger than its first hook has no conversation id yet and writes under a
/// <c>session:</c> fallback key, which <see cref="Rekey"/> folds into the real one the moment it
/// arrives.</para>
///
/// <para>The bag itself is opaque here: the client owns its shape and the server only merges it
/// field by field (a JSON null deletes), so a new preference needs no server change. Each entry
/// carries a revision that the session list exposes as <c>SessionInfo.UiRev</c> — that is what tells
/// another browser its copy is stale, without any of this having to ride the socket itself.</para>
/// </summary>
public sealed class SessionUiStore
{
    // A key whose conversation is long gone is never cleaned up (a forgotten conversation looks
    // exactly like one that just is not loaded right now), so the file would otherwise grow for the
    // life of the install.
    private const int MaxEntries = 300;
    private const int MaxFields = 40;            // distinct preferences in one bag
    private const int MaxEntryBytes = 64 * 1024; // a bag is expanded-folder lists, not file content

    /// <summary>Fallback key for a session whose conversation id is not known yet.</summary>
    public static string SessionKey(string sessionId) => "session:" + sessionId;

    /// <summary>A session's saved bag and the revision it was last written at.</summary>
    public sealed record Snapshot(int Rev, IReadOnlyDictionary<string, JsonElement> State);

    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    private sealed class Entry
    {
        public int Rev { get; set; }
        public Dictionary<string, JsonElement> State { get; set; } = new(StringComparer.Ordinal);
    }

    private static readonly Snapshot Empty = new(0, new Dictionary<string, JsonElement>());

    private readonly string _file;
    private readonly ILogger<SessionUiStore> _log;
    private readonly object _lock = new();
    // Insertion-ordered (and explicitly rebuilt on trim) so dropping the front drops the
    // least-recently-touched entries.
    private Dictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public SessionUiStore(ILogger<SessionUiStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("session-ui.json");
        Load();
    }

    /// <summary>The bag saved under a key, or an empty one at revision 0.</summary>
    public Snapshot Get(string? key)
    {
        if (string.IsNullOrEmpty(key)) return Empty;
        lock (_lock)
            return _entries.TryGetValue(key, out var e)
                ? new Snapshot(e.Rev, new Dictionary<string, JsonElement>(e.State, StringComparer.Ordinal))
                : Empty;
    }

    /// <summary>
    /// The revision saved under a key (0 when there is nothing). Cheap enough to stamp on every
    /// session in every list push, which is how other browsers learn their copy is stale.
    /// </summary>
    public int Rev(string? key)
    {
        if (string.IsNullOrEmpty(key)) return 0;
        lock (_lock) return _entries.TryGetValue(key, out var e) ? e.Rev : 0;
    }

    /// <summary>
    /// Merge a patch into a key's bag, field by field: a field whose value is JSON null is removed,
    /// anything else replaces what was there. Returns the merged bag at its new revision, or null
    /// when the patch changes nothing — so a browser echoing back what it already sent does not wake
    /// every other one.
    ///
    /// <para><paramref name="quiet"/> stores the change without advancing the revision: the field is
    /// worth remembering for the next time the session is opened but not worth telling the other
    /// browsers about while it is happening — a tree's scroll offset, which moves continuously. A bag
    /// that does not exist yet still starts at revision 1, so "has saved state" stays readable off
    /// the number alone.</para>
    /// </summary>
    public Snapshot? Merge(string? key, IReadOnlyDictionary<string, JsonElement>? patch, bool quiet = false)
    {
        if (string.IsNullOrEmpty(key) || patch is null || patch.Count == 0) return null;

        lock (_lock)
        {
            var existed = _entries.TryGetValue(key, out var entry);
            entry ??= new Entry();

            var changed = false;
            foreach (var (field, value) in patch)
            {
                if (string.IsNullOrEmpty(field)) continue;
                if (value.ValueKind == JsonValueKind.Null)
                {
                    changed |= entry.State.Remove(field);
                }
                else
                {
                    if (entry.State.TryGetValue(field, out var prev) && Same(prev, value)) continue;
                    if (!entry.State.ContainsKey(field) && entry.State.Count >= MaxFields) continue;
                    entry.State[field] = value.Clone(); // detach from the request's JsonDocument
                    changed = true;
                }
            }
            if (!changed && existed) return null;

            if (!existed || !quiet) entry.Rev++;
            // Re-insert last so this key counts as most-recently-used for trimming.
            _entries.Remove(key);
            _entries[key] = entry;
            Trim();
            Save();
            return new Snapshot(entry.Rev, new Dictionary<string, JsonElement>(entry.State, StringComparer.Ordinal));
        }
    }

    /// <summary>
    /// Fold the bag saved under one key into another, used when a session's conversation id finally
    /// arrives and its <c>session:</c> fallback can be replaced by the real one. The fallback is the
    /// newer of the two — it was written in this run — so its fields win. A no-op when there is
    /// nothing under <paramref name="from"/>.
    /// </summary>
    public bool Rekey(string? from, string? to)
    {
        if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to) || from == to) return false;
        lock (_lock)
        {
            if (!_entries.Remove(from, out var moved)) return false;
            if (_entries.TryGetValue(to, out var target))
            {
                foreach (var (field, value) in moved.State) target.State[field] = value;
                target.Rev++;
                _entries.Remove(to);
                _entries[to] = target;
            }
            else
            {
                _entries[to] = moved;
            }
            Trim();
            Save();
            return true;
        }
    }

    // Two values are the same when their JSON text is — enough to spot a client re-sending what it
    // already sent, which is most of the write traffic.
    private static bool Same(JsonElement a, JsonElement b) =>
        a.ValueKind == b.ValueKind && a.GetRawText() == b.GetRawText();

    private void Trim()
    {
        if (_entries.Count <= MaxEntries) return;
        var keep = _entries.Skip(_entries.Count - MaxEntries).ToList();
        _entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        foreach (var (k, v) in keep) _entries[k] = v;
    }

    private sealed record PersistedEntry(int Rev, Dictionary<string, JsonElement>? State);

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Dictionary<string, PersistedEntry>>(
                File.ReadAllText(_file), JsonOpts);
            if (p is null) return;
            foreach (var (key, value) in p.Take(MaxEntries))
            {
                if (string.IsNullOrWhiteSpace(key) || value is null) continue;
                var state = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var (field, val) in (value.State ?? new()).Take(MaxFields)) state[field] = val;
                _entries[key] = new Entry { Rev = Math.Max(0, value.Rev), State = state };
            }
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read session UI state from {File}; it will not be written this run", _file);
            _entries.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load session UI state from {File}; setting it aside", _file);
            _entries.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "session UI state");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing session UI state: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            var persisted = new Dictionary<string, PersistedEntry>(StringComparer.Ordinal);
            foreach (var (key, entry) in _entries)
            {
                var e = new PersistedEntry(entry.Rev, entry.State);
                // Skip a bag that has grown past what a UI preference should ever be, rather than
                // failing the whole write over one of them.
                if (JsonSerializer.Serialize(e, JsonOpts).Length > MaxEntryBytes) continue;
                persisted[key] = e;
            }
            StateFile.Write(_file, JsonSerializer.Serialize(
                persisted, new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist session UI state to {File}", _file);
        }
    }
}
