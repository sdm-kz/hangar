using System.Text.Json;

namespace Hangar.Server.Sessions;

/// <summary>A reusable launch preset: everything needed to relaunch the same session.</summary>
public sealed record RecentSession(
    string WorkingDirectory,
    string Name,
    string Command,
    string Model,
    bool RemoteControl,
    string PermissionMode,
    /// <summary>
    /// Claude Code's own session id for the conversation this preset last launched, captured from the
    /// hook callbacks (see <see cref="HookEventStore.ClaudeSessionIdCaptured"/>). Lets "continue" on a
    /// reused preset resume that EXACT conversation (<c>--resume &lt;id&gt;</c>) instead of whichever one
    /// in the folder happens to be the most recent. Null until a hook has reported it. Deliberately not
    /// part of the dedupe signature — it's a property of the preset, not part of its identity.
    /// </summary>
    string? ClaudeSessionId = null,
    /// <summary>
    /// When this preset was last saved -- launched from the New Session dialog, or taken out of the
    /// session list. Stamped by the store, never taken from the caller, and not part of the identity.
    /// Null on presets saved before it was recorded.
    /// </summary>
    DateTimeOffset? LastUsedAt = null);

/// <summary>The remembered launch presets and folders, shared across every device/browser.</summary>
public sealed record Recents(
    IReadOnlyList<RecentSession> Sessions,
    IReadOnlyList<string> Folders);

/// <summary>
/// Server-side store for the "recent" launch presets and folders shown in the New Session dialog.
/// Persisted to %LocalAppData%\ClaudeWeb\recents.json so they follow the user across devices — these
/// previously lived in each browser's localStorage and so didn't sync. Owns the dedupe logic
/// that used to run client-side.
/// </summary>
public sealed class RecentsStore
{
    // Presets are kept however many there are: a session taken out of the list lands here, and keeping
    // only the newest hundred lost the oldest of them for good. Only the ids held for a preset not yet
    // saved are bounded, since nothing ever claims a stray one.
    private const int MaxPendingIds = 100;
    private const int MaxFolders = 8;

    private readonly string _file;
    private readonly ILogger<RecentsStore> _log;
    private readonly object _lock = new();
    private List<RecentSession> _sessions = new();
    private List<string> _folders = new();
    // Claude session ids learned (from hooks) for a preset signature that isn't stored yet. The client
    // saves the preset in a second request right after launching, so a fast first hook can beat it here;
    // AddSession consults this so the id isn't lost to that race.
    private readonly Dictionary<string, string> _pendingIds = new();

    public RecentsStore(ILogger<RecentsStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "recents.json");
        Load();
    }

    public Recents Get()
    {
        lock (_lock) return Snapshot();
    }

    /// <summary>Save a preset, stamping when it was used. Presets with the same identity collapse to one.</summary>
    public Recents AddSession(RecentSession r)
    {
        if (string.IsNullOrWhiteSpace(r.WorkingDirectory)) return Get();
        var norm = Normalize(r);
        var sig = Sig(norm);
        lock (_lock)
        {
            // Keep the conversation id across a re-save: the client posts the preset without one (it
            // can't know it yet), and a hook may already have reported it for this very launch.
            if (norm.ClaudeSessionId is null)
                norm = norm with
                {
                    ClaudeSessionId = _pendingIds.TryGetValue(sig, out var pending)
                        ? pending
                        : _sessions.FirstOrDefault(x => Sig(x) == sig)?.ClaudeSessionId,
                };
            _pendingIds.Remove(sig);
            norm = norm with { LastUsedAt = DateTimeOffset.Now };
            // A preset already on file keeps its place: the list is the user's to arrange (it can be
            // dragged into any order), and the date on the row now says when it was last used. Only a
            // new one goes in at the top.
            var at = _sessions.FindIndex(x => Sig(x) == sig);
            if (at >= 0) _sessions[at] = norm;
            else _sessions.Insert(0, norm);
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// Stamp the Claude conversation id on the preset a session was launched from, so reusing it can
    /// resume that exact conversation. Called when a hook first reports the id (see
    /// <see cref="HookEventStore.ClaudeSessionIdCaptured"/>). If the preset hasn't been saved yet the id
    /// is held until it is. Returns true when a stored preset changed.
    /// </summary>
    public bool SetClaudeSessionId(RecentSession launchedFrom, string claudeSessionId)
    {
        if (string.IsNullOrWhiteSpace(claudeSessionId)) return false;
        var sig = Sig(Normalize(launchedFrom));
        lock (_lock)
        {
            var i = _sessions.FindIndex(x => Sig(x) == sig);
            if (i < 0)
            {
                if (_pendingIds.Count >= MaxPendingIds) _pendingIds.Clear(); // bound it; these are best-effort
                _pendingIds[sig] = claudeSessionId;
                return false;
            }
            if (_sessions[i].ClaudeSessionId == claudeSessionId) return false;
            _sessions[i] = _sessions[i] with { ClaudeSessionId = claudeSessionId };
            Save();
            return true;
        }
    }

    /// <summary>Whether two presets are the same entry (would collapse onto each other when saved).</summary>
    public static bool SameSession(RecentSession a, RecentSession b) => Sig(Normalize(a)) == Sig(Normalize(b));

    public Recents RemoveSession(RecentSession r)
    {
        var sig = Sig(Normalize(r));
        lock (_lock)
        {
            _sessions.RemoveAll(x => Sig(x) == sig);
            Save();
            return Snapshot();
        }
    }

    /// <summary>Reorder the presets to match the given order (by identity). Presets not named in the
    /// order are appended in their existing order, so a stale client can't drop any.</summary>
    public Recents ReorderSessions(IReadOnlyList<RecentSession>? ordered)
    {
        if (ordered is null || ordered.Count == 0) return Get();
        lock (_lock)
        {
            var rank = new Dictionary<string, int>();
            for (var i = 0; i < ordered.Count; i++)
                rank.TryAdd(Sig(Normalize(ordered[i])), i);

            _sessions = _sessions
                .OrderBy(s => rank.TryGetValue(Sig(s), out var i) ? i : int.MaxValue)
                .ToList();
            Save();
            return Snapshot();
        }
    }

    public Recents AddFolder(string? path)
    {
        var p = (path ?? "").Trim();
        if (p.Length == 0) return Get();
        lock (_lock)
        {
            _folders.RemoveAll(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase));
            _folders.Insert(0, p);
            if (_folders.Count > MaxFolders) _folders = _folders.Take(MaxFolders).ToList();
            Save();
            return Snapshot();
        }
    }

    public Recents RemoveFolder(string? path)
    {
        var p = (path ?? "").Trim();
        lock (_lock)
        {
            _folders.RemoveAll(x => string.Equals(x, p, StringComparison.OrdinalIgnoreCase));
            Save();
            return Snapshot();
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private Recents Snapshot() => new(_sessions.ToArray(), _folders.ToArray());

    private static RecentSession Normalize(RecentSession r) => r with
    {
        WorkingDirectory = r.WorkingDirectory.Trim(),
        Name = (r.Name ?? "").Trim(),
        Command = (r.Command ?? "").Trim(),
        Model = r.Model ?? "",
        PermissionMode = string.IsNullOrEmpty(r.PermissionMode) ? "default" : r.PermissionMode,
    };

    /// <summary>Identity used to dedupe — mirrors the client's original signature.</summary>
    private static string Sig(RecentSession r) => string.Join(' ',
        r.WorkingDirectory.ToLowerInvariant(),
        r.Name,
        r.Command,
        r.Model,
        r.RemoteControl ? "rc" : "norc",
        r.PermissionMode);

    private sealed record Persisted(List<RecentSession>? Sessions, List<string>? Folders);

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_file));
            if (p is null) return;
            _sessions = (p.Sessions ?? new())
                .Where(s => s is not null && !string.IsNullOrWhiteSpace(s.WorkingDirectory))
                .Select(Normalize)
                .ToList();
            _folders = (p.Folders ?? new())
                .Where(f => !string.IsNullOrWhiteSpace(f))
                .Take(MaxFolders)
                .ToList();
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read recents from {File}; it will not be written this run", _file);
            _sessions.Clear();
            _folders.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load recents from {File}; setting it aside", _file);
            _sessions.Clear();
            _folders.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "recents");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing recents: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Persisted(_sessions, _folders),
                new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist recents to {File}", _file);
        }
    }
}
