using System.Text.Json;

namespace Hangar.Server.FileSystem;

/// <summary>
/// Extra folders the user has attached to a session so its Files panel can browse (and edit) them
/// alongside the session's own working directory.
///
/// Links are keyed by the session's <em>working directory</em>, not its id: a session id is minted
/// afresh every time a conversation is resumed (see <c>SessionManager.Restore</c>), so id-keyed links
/// would evaporate on the first restart — which is exactly what they have to survive. Keying by folder
/// also means every session opened on a project inherits the same links, which is what you want.
/// Persisted to %LocalAppData%\Hangar\linked-folders.json.
/// </summary>
public sealed class LinkedFolderStore
{
    private const int MaxPerFolder = 20;

    private readonly string _file;
    private readonly ILogger<LinkedFolderStore> _log;
    private readonly object _lock = new();
    private Dictionary<string, List<string>> _links = new(StringComparer.OrdinalIgnoreCase);

    public LinkedFolderStore(ILogger<LinkedFolderStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("linked-folders.json");
        Load();
    }

    /// <summary>The folders linked to a session's working directory (never null).</summary>
    public IReadOnlyList<string> Get(string workingDir)
    {
        var key = Key(workingDir);
        lock (_lock) return _links.TryGetValue(key, out var list) ? list.ToArray() : Array.Empty<string>();
    }

    /// <summary>
    /// Link <paramref name="path"/> to a session's working directory. Returns the updated list, or null
    /// when the path is missing, isn't a folder, or is the working directory itself.
    /// </summary>
    public IReadOnlyList<string>? Add(string workingDir, string? path)
    {
        var full = Normalize(path);
        if (full is null || !Directory.Exists(full)) return null;
        if (Same(full, workingDir)) return null; // already the session's own root

        var key = Key(workingDir);
        lock (_lock)
        {
            var list = _links.TryGetValue(key, out var existing) ? existing : _links[key] = new List<string>();
            list.RemoveAll(p => Same(p, full));
            list.Insert(0, full);
            if (list.Count > MaxPerFolder) list.RemoveRange(MaxPerFolder, list.Count - MaxPerFolder);
            Save();
            return list.ToArray();
        }
    }

    /// <summary>Unlink a folder. Returns the updated list.</summary>
    public IReadOnlyList<string> Remove(string workingDir, string? path)
    {
        var full = Normalize(path);
        if (full is null) return Get(workingDir);

        var key = Key(workingDir);
        lock (_lock)
        {
            if (!_links.TryGetValue(key, out var list)) return Array.Empty<string>();
            list.RemoveAll(p => Same(p, full));
            if (list.Count == 0) _links.Remove(key);
            Save();
            return list.ToArray();
        }
    }

    /// <summary>
    /// Validate a requested browse root against the folders linked to <paramref name="workingDir"/>:
    /// the stored path when <paramref name="dir"/> is one of them, otherwise null — so a client can't
    /// point the session file API at an arbitrary folder.
    /// </summary>
    public string? Resolve(string workingDir, string? dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return null;
        var full = Normalize(dir);
        if (full is null) return null;
        var key = Key(workingDir);
        lock (_lock)
        {
            if (!_links.TryGetValue(key, out var list)) return null;
            return list.FirstOrDefault(p => Same(p, full));
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private static string? Normalize(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try { return Path.GetFullPath(path.Trim()); }
        catch { return null; }
    }

    private static string Key(string workingDir) => Normalize(workingDir)?.TrimEnd('/', '\\') ?? workingDir;

    private static bool Same(string a, string b) =>
        string.Equals(Key(a), Key(b),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private sealed record Persisted(Dictionary<string, List<string>>? Links);

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_file));
            if (p?.Links is null) return;
            _links = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
            foreach (var (dir, folders) in p.Links)
            {
                var list = (folders ?? new())
                    .Select(Normalize)
                    .Where(f => f is not null)
                    .Select(f => f!)
                    .Distinct(OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal)
                    .Take(MaxPerFolder)
                    .ToList();
                if (list.Count > 0) _links[Key(dir)] = list;
            }
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read linked folders from {File}; it will not be written this run", _file);
            _links.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load linked folders from {File}; setting it aside", _file);
            _links.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "linked folders");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing linked folders: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Persisted(_links),
                new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist linked folders to {File}", _file);
        }
    }
}
