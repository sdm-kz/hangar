using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

// Project and ProjectGroup, and the rules for which project a session falls under (ProjectMembership),
// live in shared\Contract\Projects.cs: the tray menu arranges sessions by the same rules.

/// <summary>
/// Server-side store for projects, persisted to %LocalAppData%\ClaudeWeb\projects.json so they follow
/// the user across every browser and device pointed at this app — like <see cref="RecentsStore"/>, and
/// unlike the sidebar's per-browser view preferences (pins, manual order, collapse state).
///
/// Every mutation returns the full list, so a caller can replace its state from the response instead
/// of patching it and hoping the two agree.
/// </summary>
public sealed class ProjectStore
{
    private const int MaxProjects = 100;
    private const int MaxFoldersPerProject = 100;
    private const int MaxGroupsPerProject = 50;
    // A virtual folder is something you file sessions into by hand, so this is a backstop against a
    // runaway writer rather than a limit anyone reaches. Membership keys are never cleaned up (a
    // conversation that is gone looks exactly like one that just isn't loaded), so the list is capped.
    private const int MaxSessionsPerGroup = 500;
    private const int MaxNameLength = 80;
    private const int MaxColorLength = 32;
    private const int MaxIconLength = 40;

    private readonly string _file;
    private readonly ILogger<ProjectStore> _log;
    private readonly object _lock = new();
    private List<Project> _projects = new();

    public ProjectStore(ILogger<ProjectStore> log)
    {
        _log = log;
        _file = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ClaudeWeb", "projects.json");
        Load();
    }

    /// <summary>Every project, in creation order.</summary>
    public IReadOnlyList<Project> List()
    {
        lock (_lock) return Snapshot();
    }

    /// <summary>Create a project. Returns the updated list, or null when the name is blank or at capacity.</summary>
    public IReadOnlyList<Project>? Create(string? name, string? color, IEnumerable<string>? folders = null)
    {
        var clean = CleanName(name);
        if (clean is null) return null;

        lock (_lock)
        {
            if (_projects.Count >= MaxProjects) return null;
            var links = (folders ?? Array.Empty<string>())
                .Select(Normalize)
                .Where(p => p is not null)
                .Select(p => p!)
                .Distinct(PathComparer)
                .Take(MaxFoldersPerProject)
                .ToList();
            // A folder belongs to exactly one project, so claiming it takes it off whoever had it.
            foreach (var f in links) Unlink(f);
            _projects.Add(new Project(Guid.NewGuid().ToString("n"), clean, CleanColor(color), links));
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// Rename and/or recolour a project. A null field leaves that one as it was; an empty colour
    /// clears the accent. Returns null when there is no such project (or the new name is blank).
    /// </summary>
    public IReadOnlyList<Project>? Update(string id, string? name, string? color)
    {
        lock (_lock)
        {
            var i = IndexOf(id);
            if (i < 0) return null;
            var p = _projects[i];
            var clean = name is null ? p.Name : CleanName(name);
            if (clean is null) return null; // a rename to blank is a slip, not an intent
            _projects[i] = p with { Name = clean, Color = color is null ? p.Color : CleanColor(color) };
            Save();
            return Snapshot();
        }
    }

    /// <summary>Delete a project. Returns the updated list, or null when there is no such project.</summary>
    public IReadOnlyList<Project>? Delete(string id)
    {
        lock (_lock)
        {
            var i = IndexOf(id);
            if (i < 0) return null;
            _projects.RemoveAt(i);
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// Link a folder to a project, taking it away from whichever project already had it — a folder
    /// group can only sit under one heading. Returns null when the project or the path is unusable.
    /// </summary>
    public IReadOnlyList<Project>? AddFolder(string id, string? path)
    {
        var full = Normalize(path);
        if (full is null) return null;

        lock (_lock)
        {
            var i = IndexOf(id);
            if (i < 0) return null;
            // Unlink first (it may rewrite this very project's entry, so re-read it afterwards): moving
            // a folder between projects and re-adding it to its own are then the same code path.
            Unlink(full);
            var p = _projects[i];
            if (p.Folders.Count >= MaxFoldersPerProject) return Snapshot();
            _projects[i] = p with { Folders = p.Folders.Append(full).ToList() };
            Save();
            return Snapshot();
        }
    }

    /// <summary>Unlink a folder from a project. Returns the updated list.</summary>
    public IReadOnlyList<Project>? RemoveFolder(string id, string? path)
    {
        var full = Normalize(path);
        lock (_lock)
        {
            var i = IndexOf(id);
            if (i < 0) return null;
            if (full is null) return Snapshot();
            var p = _projects[i];
            var kept = p.Folders.Where(f => !Same(f, full)).ToList();
            if (kept.Count != p.Folders.Count)
            {
                _projects[i] = p with { Folders = kept };
                Save();
            }
            return Snapshot();
        }
    }

    // ---- virtual folders -------------------------------------------------------------------------

    /// <summary>
    /// Membership key for a session whose conversation id isn't known yet — the first seconds of a
    /// fresh session. <see cref="Rekey"/> folds it into the real one the moment a hook reports it,
    /// exactly as <see cref="PinStore"/> does for a pin set in that same window.
    /// </summary>
    public static string SessionKey(string sessionId) => "session:" + sessionId;

    /// <summary>Add a virtual folder to a project. Returns null when the project or the name is unusable.</summary>
    public IReadOnlyList<Project>? AddGroup(string projectId, string? name, string? color, string? icon)
    {
        var clean = CleanName(name);
        if (clean is null) return null;

        lock (_lock)
        {
            var i = IndexOf(projectId);
            if (i < 0) return null;
            var p = _projects[i];
            if (p.Groups.Count >= MaxGroupsPerProject) return Snapshot();
            var group = new ProjectGroup(
                Guid.NewGuid().ToString("n"), clean, CleanColor(color), CleanIcon(icon), Array.Empty<string>());
            _projects[i] = p with { Groups = p.Groups.Append(group).ToList() };
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// Rename, recolour or re-icon a virtual folder, wherever it lives — a group id is unique across
    /// projects, so the caller doesn't have to say which project holds it. A null field is left as it
    /// was; an empty colour or icon clears it. Returns null when there is no such group.
    /// </summary>
    public IReadOnlyList<Project>? UpdateGroup(string groupId, string? name, string? color, string? icon)
    {
        lock (_lock)
        {
            var (i, j) = Find(groupId);
            if (i < 0) return null;
            var p = _projects[i];
            var g = p.Groups[j];
            var clean = name is null ? g.Name : CleanName(name);
            if (clean is null) return null; // a rename to blank is a slip, not an intent
            _projects[i] = p with
            {
                Groups = Replace(p.Groups, j, g with
                {
                    Name = clean,
                    Color = color is null ? g.Color : CleanColor(color),
                    Icon = icon is null ? g.Icon : CleanIcon(icon),
                }),
            };
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// Delete a virtual folder. Its sessions are untouched — they simply go back to showing under the
    /// folder they run in. Returns null when there is no such group.
    /// </summary>
    public IReadOnlyList<Project>? DeleteGroup(string groupId)
    {
        lock (_lock)
        {
            var (i, j) = Find(groupId);
            if (i < 0) return null;
            var p = _projects[i];
            _projects[i] = p with { Groups = p.Groups.Where((_, k) => k != j).ToList() };
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// File sessions into a virtual folder, or (with a null <paramref name="groupId"/>) take them out
    /// of whichever ones hold them. A session sits in at most one, so this clears the others first.
    ///
    /// <para>One entry of <paramref name="sessionKeys"/> per session, holding every key that session
    /// could be filed under — its conversation id and the <c>session:</c> fallback — because a
    /// membership written before the conversation id arrived may still be sitting under the fallback.
    /// All of them are cleared; the first is what a new membership is written under.</para>
    ///
    /// <para>Several at once is not a convenience: a fork is drawn under the session it branched from,
    /// so a branch moves as a unit or the tree it is drawn as comes apart. Written and saved once, and
    /// so seen by every browser as one move rather than a row landing at a time.</para>
    ///
    /// Returns null when there is no such group, or when no entry has a usable key.
    /// </summary>
    public IReadOnlyList<Project>? SetSessionGroup(
        IReadOnlyList<IReadOnlyList<string>> sessionKeys, string? groupId)
    {
        // Per session, in the order given: what to clear is all of its keys, what to write is the first.
        var sets = sessionKeys
            .Select(keys => keys.Where(k => !string.IsNullOrEmpty(k)).ToList())
            .Where(keys => keys.Count > 0)
            .ToList();
        if (sets.Count == 0) return null;
        var usable = sets.SelectMany(keys => keys).ToHashSet(StringComparer.Ordinal);

        lock (_lock)
        {
            var target = groupId is null ? (Project: -1, Group: -1) : Find(groupId);
            if (groupId is not null && target.Project < 0) return null;

            var changed = false;
            for (var i = 0; i < _projects.Count; i++)
            {
                var p = _projects[i];
                if (!p.Groups.Any(g => g.Sessions.Any(usable.Contains))) continue;
                _projects[i] = p with
                {
                    Groups = p.Groups
                        .Select(g => g.Sessions.Any(usable.Contains)
                            ? g with { Sessions = g.Sessions.Where(s => !usable.Contains(s)).ToList() }
                            : g)
                        .ToList(),
                };
                changed = true;
            }

            if (groupId is not null)
            {
                var (pi, gi) = target;
                var p = _projects[pi];
                var g = p.Groups[gi];
                // Newest last, and trimmed from the front: the oldest membership is the one whose
                // conversation is most likely gone for good. The clearing pass above ran over the
                // target group too, so nothing being written here is still in the list.
                var members = g.Sessions.Concat(sets.Select(keys => keys[0])).ToList();
                if (members.Count > MaxSessionsPerGroup) members.RemoveRange(0, members.Count - MaxSessionsPerGroup);
                _projects[pi] = p with { Groups = Replace(p.Groups, gi, g with { Sessions = members }) };
                changed = true;
            }

            if (changed) Save();
            return Snapshot();
        }
    }

    /// <summary>The virtual folder a membership key sits in, or null. A null/blank key never does.</summary>
    public string? GroupOf(string? key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        lock (_lock)
            foreach (var p in _projects)
                foreach (var g in p.Groups)
                    if (g.Sessions.Contains(key, StringComparer.Ordinal))
                        return g.Id;
        return null;
    }

    /// <summary>
    /// Move a membership from one key to another, keeping its place — used when a session's
    /// conversation id finally arrives and the <c>session:</c> fallback it was filed under stops being
    /// the key anyone will look it up by. Returns whether anything moved.
    /// </summary>
    public bool Rekey(string from, string to)
    {
        if (string.IsNullOrEmpty(from) || string.IsNullOrEmpty(to) || from == to) return false;
        lock (_lock)
        {
            bool Holds(ProjectGroup g, string key) => g.Sessions.Contains(key, StringComparer.Ordinal);

            // Nothing filed under the old key means there is nothing to move — and the guard matters
            // more than it looks: this runs on every conversation id that arrives, including for a
            // reopened session whose conversation is ALREADY filed under <paramref name="to"/>. Without
            // it, the sweep below would read that as a stale duplicate and delete the very grouping the
            // reopen was supposed to preserve.
            if (!_projects.Any(p => p.Groups.Any(g => Holds(g, from)))) return false;

            for (var i = 0; i < _projects.Count; i++)
            {
                var p = _projects[i];
                // Every group holding either key is rewritten, not just the ones holding the old key:
                // an entry under the new key can be sitting in a DIFFERENT box (the same conversation
                // filed there on an earlier run), and leaving it would put one session in two boxes
                // with the stale one winning, since GroupOf answers with the first it finds.
                if (!p.Groups.Any(g => Holds(g, from) || Holds(g, to))) continue;
                _projects[i] = p with
                {
                    Groups = p.Groups
                        .Select(g => Holds(g, from) || Holds(g, to)
                            ? g with
                            {
                                Sessions = g.Sessions
                                    .Where(s => s != to)
                                    .Select(s => s == from ? to : s)
                                    .ToList(),
                            }
                            : g)
                        .ToList(),
                };
            }
            Save();
            return true;
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private static readonly StringComparer PathComparer =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private int IndexOf(string id) => _projects.FindIndex(p => p.Id == id);

    /// <summary>
    /// Where a virtual folder lives, as (project index, group index), or (-1, -1) when no project
    /// holds one with that id. Group ids are unique across the whole file, so a caller only ever has
    /// to name the group. The caller holds the lock.
    /// </summary>
    private (int Project, int Group) Find(string groupId)
    {
        for (var i = 0; i < _projects.Count; i++)
        {
            var j = _projects[i].Groups.ToList().FindIndex(g => g.Id == groupId);
            if (j >= 0) return (i, j);
        }
        return (-1, -1);
    }

    /// <summary>The list with one entry swapped out — records are immutable, so an edit is a rebuild.</summary>
    private static List<ProjectGroup> Replace(IReadOnlyList<ProjectGroup> groups, int index, ProjectGroup group)
    {
        var next = groups.ToList();
        next[index] = group;
        return next;
    }

    private IReadOnlyList<Project> Snapshot() => _projects.ToArray();

    /// <summary>Drop a folder from every project that links it. The caller holds the lock.</summary>
    private void Unlink(string full)
    {
        for (var i = 0; i < _projects.Count; i++)
        {
            var p = _projects[i];
            if (!p.Folders.Any(f => Same(f, full))) continue;
            _projects[i] = p with { Folders = p.Folders.Where(f => !Same(f, full)).ToList() };
        }
    }

    private static string? CleanName(string? name)
    {
        var trimmed = name?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > MaxNameLength ? trimmed[..MaxNameLength] : trimmed;
    }

    private static string? CleanColor(string? color)
    {
        var trimmed = color?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > MaxColorLength ? trimmed[..MaxColorLength] : trimmed;
    }

    /// <summary>
    /// An icon name, trimmed and bounded. Which names mean anything is the client's business (it owns
    /// the icon set), so an unknown one is stored as given and drawn as the default — the same deal
    /// the colour has with the palette.
    /// </summary>
    private static string? CleanIcon(string? icon)
    {
        var trimmed = icon?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > MaxIconLength ? trimmed[..MaxIconLength] : trimmed;
    }

    private static string? Normalize(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            var full = Path.GetFullPath(path.Trim());
            // Trim a trailing separator so C:\a\b and C:\a\b\ are one link — but keep a drive root
            // (C:\) whole, since trimming that leaves "C:" which resolves to a working directory.
            var trimmed = full.TrimEnd('/', '\\');
            return trimmed.EndsWith(':') ? full : trimmed;
        }
        catch { return null; }
    }

    private static bool Same(string a, string b) => PathComparer.Equals(a, b);

    private sealed record Persisted(List<Project>? Projects);

    /// <summary>
    /// A project's virtual folders as read back off disk: nameless or id-less entries dropped, ids
    /// deduplicated (they address a group on their own, so two of one id would make "which group?"
    /// unanswerable), and every list bounded the way a write bounds it. <paramref name="seen"/> spans
    /// the whole file, because the ambiguity a repeated id creates spans it too.
    /// </summary>
    private static List<ProjectGroup> CleanGroups(IReadOnlyList<ProjectGroup>? groups, HashSet<string> seen)
    {
        if (groups is null) return new List<ProjectGroup>();
        return groups
            // `g is not null` is not paranoia: a hand-edited (or truncated) file can hold a null
            // entry. Throwing here is caught by Load as content it can't load — the file is set aside
            // rather than half-loaded — but skipping the bad entry keeps the rest of the project.
            .Where(g => g is not null && !string.IsNullOrWhiteSpace(g.Id) && CleanName(g.Name) is not null
                && seen.Add(g.Id))
            .Take(MaxGroupsPerProject)
            .Select(g => g with
            {
                Name = CleanName(g.Name)!,
                Color = CleanColor(g.Color),
                Icon = CleanIcon(g.Icon),
                Sessions = (g.Sessions ?? Array.Empty<string>())
                    .Where(s => !string.IsNullOrEmpty(s))
                    .Distinct(StringComparer.Ordinal)
                    .Take(MaxSessionsPerGroup)
                    .ToList(),
            })
            .ToList();
    }

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(
                File.ReadAllText(_file), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (p?.Projects is null) return;
            var seenGroups = new HashSet<string>(StringComparer.Ordinal);
            _projects = p.Projects
                // `x is not null` for the same reason CleanGroups checks it below: a hand-edited or
                // truncated file can hold a null entry, and one skipped project beats losing the file.
                .Where(x => x is not null && !string.IsNullOrWhiteSpace(x.Id) && CleanName(x.Name) is not null)
                .Take(MaxProjects)
                .Select(x => x with
                {
                    Name = CleanName(x.Name)!,
                    Color = CleanColor(x.Color),
                    Folders = (x.Folders ?? Array.Empty<string>())
                        .Select(Normalize)
                        .Where(f => f is not null)
                        .Select(f => f!)
                        .Distinct(PathComparer)
                        .Take(MaxFoldersPerProject)
                        .ToList(),
                    Groups = CleanGroups(x.Groups, seenGroups),
                })
                .ToList();
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read projects from {File}; it will not be written this run", _file);
            _projects.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load projects from {File}; setting it aside", _file);
            _projects.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "projects");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing projects: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Persisted(_projects),
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist projects to {File}", _file);
        }
    }
}
