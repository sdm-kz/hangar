using System.Text.Json;

namespace Hangar.Server.FileSystem;

/// <summary>
/// GitHub repositories attached to a session beyond the one its own folder points at, persisted to
/// %LocalAppData%\Hangar\session-repos.json.
///
/// <para>A session works in one folder, but the work rarely stays there: a change in one repo is
/// answered by a change in another, and a folder opened a level up holds several repos with no
/// remote of its own. The reviews worth having to hand are the ones the work touches, which is not
/// something a single <c>git remote</c> can say.</para>
///
/// <para>Keyed by <b>working directory</b> rather than session id, the way <see cref="LinkedFolderStore"/>
/// is and for the same reason: the id is minted afresh every time a conversation is resumed, and what
/// the link is about is the folder being worked in.</para>
///
/// <para>A linked repo needs no checkout. <c>gh</c> answers for any repo by name, so this is a list of
/// names — which is what lets a session reach a repo it only has to read.</para>
/// </summary>
public sealed class SessionRepoStore
{
    private const int MaxFolders = 500;
    private const int MaxReposPerFolder = 20;

    private readonly string _file;
    private readonly ILogger<SessionRepoStore> _log;
    private readonly object _lock = new();
    private Dictionary<string, List<string>> _repos = new(StringComparer.OrdinalIgnoreCase);

    public SessionRepoStore(ILogger<SessionRepoStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("session-repos.json");
        Load();
    }

    /// <summary>
    /// "owner/name", as GitHub writes it, or null for anything else. The value is about to be an
    /// argument to gh and a key in a store, and a leading dash would be read as a flag.
    /// </summary>
    public static string? Clean(string? repo)
    {
        var text = repo?.Trim();
        if (string.IsNullOrEmpty(text)) return null;
        // A pasted URL is what people have in the clipboard, so take the owner/name out of one.
        if (text.Contains("://") || text.StartsWith("git@", StringComparison.Ordinal))
            text = GitHubService.ParseRemote(text) ?? "";
        var parts = text.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length != 2) return null;
        // ASCII, because that is what a GitHub owner or repository name is — and because the client
        // checks the same rule (cleanRepoName in lib/sessionRepos.ts) to refuse a slip without a
        // round trip. char.IsLetterOrDigit would be the wider of the two, letting "Ωwner/repo" be
        // stored and drawn here while every gh call on it answered 404.
        static bool Ok(char c) =>
            c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '.' or '_' or '-';
        // Not just the leading dash — a part of nothing but dots as well. The name is interpolated
        // into a REST path (see ShasAsync and FileAsync), so ".." would be a path segment rather
        // than a repository; no real owner or repository is called "." or ".." either way.
        if (parts.Any(s => s.Length is 0 or > 100 || s[0] == '-' ||
                           !s.Any(c => char.IsAsciiLetterOrDigit(c)) || !s.All(Ok))) return null;
        return $"{parts[0]}/{parts[1]}";
    }

    /// <summary>The repos linked to a folder, in the order they were added.</summary>
    public IReadOnlyList<string> Get(string workingDir)
    {
        lock (_lock)
            return _repos.TryGetValue(Key(workingDir), out var list) ? list.ToList() : Array.Empty<string>();
    }

    /// <summary>Link a repo. Returns the folder's list after the change, or null when the name is not one.</summary>
    public IReadOnlyList<string>? Add(string workingDir, string? repo)
    {
        var clean = Clean(repo);
        if (clean is null) return null;
        lock (_lock)
        {
            var key = Key(workingDir);
            if (!_repos.TryGetValue(key, out var list)) _repos[key] = list = new();
            if (!list.Contains(clean, StringComparer.OrdinalIgnoreCase) && list.Count < MaxReposPerFolder)
                list.Add(clean);
            Trim();
            Save();
            return list.ToList();
        }
    }

    /// <summary>Unlink a repo. Returns the folder's list after the change.</summary>
    public IReadOnlyList<string> Remove(string workingDir, string? repo)
    {
        var clean = Clean(repo);
        lock (_lock)
        {
            var key = Key(workingDir);
            if (clean is null || !_repos.TryGetValue(key, out var list)) return Get(workingDir);
            if (list.RemoveAll(r => string.Equals(r, clean, StringComparison.OrdinalIgnoreCase)) > 0)
            {
                if (list.Count == 0) _repos.Remove(key);
                Save();
            }
            return list.ToList();
        }
    }

    private static string Key(string workingDir)
    {
        try { return Path.GetFullPath(workingDir).TrimEnd('/', '\\'); }
        catch { return workingDir; }
    }

    private void Trim()
    {
        while (_repos.Count > MaxFolders) _repos.Remove(_repos.Keys.First());
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var saved = JsonSerializer.Deserialize<Dictionary<string, List<string>>>(File.ReadAllText(_file));
            if (saved is null) return;
            foreach (var (key, list) in saved.Take(MaxFolders))
                // Key() as well as Clean(): a hand-edited file can spell a folder differently from
                // the way one written here does, and an un-normalised key simply never matches.
                if (!string.IsNullOrWhiteSpace(key) && list is not null)
                    _repos[Key(key)] = list.Select(Clean).Where(r => r is not null).Take(MaxReposPerFolder).ToList()!;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not load {File}; starting with no linked repos", _file);
            _repos = new(StringComparer.OrdinalIgnoreCase);
        }
    }

    private void Save()
    {
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(_repos, new JsonSerializerOptions { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not save linked repos to {File}", _file);
        }
    }
}
