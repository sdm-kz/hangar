using System.Text.Json;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// A named grouping of folders. A project is the user's own unit of work — it can span several
/// unrelated folders (a frontend repo, its backend, a notes directory) or none at all while it is
/// being set up. The sidebar groups sessions by folder; a project sits one level above that and
/// collects those folder groups under one heading.
///
/// <para><see cref="Folders"/> holds absolute paths, and a link covers the folder <em>and everything
/// under it</em>: a session started later in a subfolder — a worktree, a nested repo — joins the
/// project on its own. That is the point of linking by path rather than by session id: ids are minted
/// afresh on every resume, folders are stable.</para>
/// </summary>
public sealed record Project(
    string Id,
    string Name,
    /// <summary>Palette colour name (the same names as a session's /color), or null for no accent.</summary>
    string? Color,
    IReadOnlyList<string> Folders);

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
    private const int MaxNameLength = 80;
    private const int MaxColorLength = 32;

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

    // ---- membership ----------------------------------------------------------------------------
    // The same rules the sidebar applies client-side (web/src/lib/projects.ts). They live here too
    // because the tray menu asks the same questions of the same data, and a second answer to "which
    // project is this folder in?" is a second thing to keep in step.

    /// <summary>
    /// A folder path folded to a comparison key: separators unified, trailing ones dropped, case
    /// folded on Windows. Two spellings of one folder have to compare equal, or a link stops covering
    /// the folder it names.
    /// </summary>
    public static string DirKey(string dir)
    {
        var key = dir.Replace('\\', '/').TrimEnd('/');
        return OperatingSystem.IsWindows() ? key.ToLowerInvariant() : key;
    }

    /// <summary>Whether <paramref name="dir"/> is the linked folder itself or sits under it.</summary>
    public static bool Covers(string link, string dir)
    {
        var l = DirKey(link);
        var d = DirKey(dir);
        // The separator on the prefix test is what stops a link to C:\git\app from swallowing
        // C:\git\app-old.
        return d == l || d.StartsWith(l + "/", StringComparison.Ordinal);
    }

    /// <summary>
    /// The project a folder belongs to, or null when nothing links it. Where two projects link
    /// overlapping paths the deeper link wins: linking C:\git\app\web says something more specific
    /// about that folder than linking C:\git, and honouring the specific one is what lets a sub-tree
    /// be split out into its own project.
    /// </summary>
    public static Project? ForDirectory(IReadOnlyList<Project> projects, string? dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return null;
        Project? best = null;
        var bestLen = -1;
        foreach (var p in projects)
            foreach (var f in p.Folders)
            {
                if (!Covers(f, dir)) continue;
                var len = DirKey(f).Length;
                if (len <= bestLen) continue;
                best = p;
                bestLen = len;
            }
        return best;
    }

    // ---- helpers -------------------------------------------------------------------------------

    private static readonly StringComparer PathComparer =
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private int IndexOf(string id) => _projects.FindIndex(p => p.Id == id);

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

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(
                File.ReadAllText(_file), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (p?.Projects is null) return;
            _projects = p.Projects
                .Where(x => !string.IsNullOrWhiteSpace(x.Id) && CleanName(x.Name) is not null)
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
                })
                .ToList();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not read projects from {File}", _file);
        }
    }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_file)!);
            File.WriteAllText(_file, JsonSerializer.Serialize(
                new Persisted(_projects),
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist projects to {File}", _file);
        }
    }
}
