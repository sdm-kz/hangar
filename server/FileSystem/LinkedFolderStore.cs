using System.Text.Json;

namespace ClaudeWeb.Server.FileSystem;

/// <summary>
/// Extra folders the user has attached to a session so its Files panel can browse (and edit) them
/// alongside the session's own working directory.
///
/// Links are keyed by the session's <em>working directory</em>, not its id: a session id is minted
/// afresh every time a conversation is resumed (see <c>SessionManager.Restore</c>), so id-keyed links
/// would evaporate on the first restart — which is exactly what they have to survive. Keying by folder
/// also means every session opened on a project inherits the same links, which is what you want.
/// Persisted to %LocalAppData%\ClaudeWeb\linked-folders.json.
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
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "linked-folders.json");
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
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read linked folders from {File}", _file);
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            File.WriteAllText(_file, JsonSerializer.Serialize(
                new Persisted(_links),
                new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist linked folders to {File}", _file);
        }
    }
}
