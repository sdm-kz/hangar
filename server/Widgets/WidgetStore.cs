using System.Text.Json;
using System.Text.RegularExpressions;
using Hangar.Contract;
using Hangar.Server.Sessions;

namespace Hangar.Server.Widgets;

/// <summary>A widget type as it is stored: where, its bookkeeping, and its manifest if that reads.</summary>
public sealed record WidgetType(
    /// <summary>"personal" or "project".</summary>
    string Scope,
    /// <summary>The project it belongs to; null for a personal one.</summary>
    string? ProjectId,
    string Name,
    string Folder,
    int Rev,
    DateTimeOffset UpdatedAt,
    string? UpdatedBy,
    /// <summary>Null when widget.json is missing or no longer passes (a hand edit gone wrong).</summary>
    WidgetManifest? Manifest,
    IReadOnlyList<WidgetIssue> Problems)
{
    /// <summary>
    /// A fingerprint of what produces the data — the manifest's params, secrets and source, and the
    /// script it runs — and nothing else. The runner's cache is keyed by it rather than by the
    /// revision, so a rewrite of the view alone keeps the data it has: a claude source costs a model
    /// call and ten seconds and more to fetch again, for a change that cannot have altered it.
    /// </summary>
    public string SourceKey { get; init; } = "";

    /// <summary>Scope and project together: what tells two types of the same name apart.</summary>
    public string Key => ProjectId is null ? $"personal/{Name}" : $"project:{ProjectId}/{Name}";
}

/// <summary>What became of a write.</summary>
public sealed record WidgetWriteResult(
    bool Ok,
    WidgetType? Type,
    IReadOnlyList<WidgetIssue> Errors,
    IReadOnlyList<WidgetIssue> Warnings,
    /// <summary>Set when the write was refused for naming a revision that is not the current one.</summary>
    int? ConflictRev = null,
    bool NotFound = false);

/// <summary>
/// The widget types of this node (docs/design/widgets.md §4): <b>personal</b> ones, listed in
/// <c>%LocalAppData%\Hangar\widgets.json</c>, and <b>project</b> ones, listed in the project's entry
/// in <c>projects.json</c>. Either way the files are in the app-data folder — <c>widgets\personal\&lt;name&gt;\</c>
/// or <c>widgets\&lt;projectId&gt;\&lt;name&gt;\</c> — where a session writing them and a person diffing
/// them can both get at them.
/// </summary>
/// <remarks>
/// <para>Every write is checked as a whole before anything touches the disk (<see cref="WidgetManifest.Check"/>),
/// so a folder only ever holds a widget that passed. A file edited by hand afterwards is read as it is:
/// a manifest that no longer passes shows up as the type's <see cref="WidgetType.Problems"/> rather
/// than as a widget that silently stopped existing.</para>
/// <para><see cref="Revision"/> moves on every write, and rides the session hub's snapshot: that is
/// how every open instance of a type, on every device, learns to reload.</para>
/// </remarks>
public sealed class WidgetStore
{
    public const int MaxPerScope = 50;
    public const string Personal = "personal";
    public const string Project = "project";

    private static readonly Regex NamePattern = new("^[a-z][a-z0-9-]{0,39}$", RegexOptions.CultureInvariant);

    private readonly ProjectStore _projects;
    private readonly ILogger<WidgetStore> _log;
    private readonly string _root;
    private readonly string _indexFile;
    private readonly object _lock = new();
    private List<ProjectWidget> _personal = new();
    private int _revision;

    public WidgetStore(ProjectStore projects, ILogger<WidgetStore> log)
    {
        _projects = projects;
        _log = log;
        _root = AppDataFolder.PathFor("widgets");
        _indexFile = AppDataFolder.PathFor("widgets.json");
        Load();
    }

    public static bool IsValidName(string? name) => name is not null && NamePattern.IsMatch(name);

    public int Revision => Volatile.Read(ref _revision);

    /// <summary>The project a folder falls under, as the sidebar would put it.</summary>
    public Project? ProjectFor(string? workingDirectory) =>
        ProjectMembership.ForDirectory(_projects.List(), workingDirectory);

    /// <summary>
    /// Every type a session in <paramref name="workingDirectory"/> can open, most specific first: its
    /// project's, then the personal ones. A personal type with the name of one of the project's is
    /// listed too, marked shadowed — it is still there, and opening by that name gets the project's.
    /// </summary>
    public IReadOnlyList<(WidgetType Type, bool Shadowed)> VisibleTo(string? workingDirectory)
    {
        var project = ProjectFor(workingDirectory);
        var own = project is null ? [] : project.Widgets.Select(w => Read(Project, project.Id, w)).ToList();
        var names = own.Select(t => t.Name).ToHashSet(StringComparer.OrdinalIgnoreCase);
        List<ProjectWidget> personal;
        lock (_lock) personal = _personal.ToList();
        return own.Select(t => (t, false))
            .Concat(personal.Select(w => Read(Personal, null, w)).Select(t => (t, names.Contains(t.Name))))
            .ToList();
    }

    /// <summary>
    /// The type a name opens in a session in <paramref name="workingDirectory"/>: the project's, else the
    /// personal one. Found by name before anything is read — this is on every fetch's path.
    /// </summary>
    public WidgetType? Resolve(string? workingDirectory, string name)
    {
        bool Named(ProjectWidget w) => string.Equals(w.Name, name, StringComparison.OrdinalIgnoreCase);
        var project = ProjectFor(workingDirectory);
        if (project?.Widgets.FirstOrDefault(Named) is { } own) return Read(Project, project.Id, own);
        ProjectWidget? personal;
        lock (_lock) personal = _personal.FirstOrDefault(Named);
        return personal is null ? null : Read(Personal, null, personal);
    }

    /// <summary>One type by its scope, or null when there is none.</summary>
    public WidgetType? Get(string scope, string? projectId, string name)
    {
        if (scope == Personal)
        {
            ProjectWidget? entry;
            lock (_lock) entry = _personal.FirstOrDefault(w => string.Equals(w.Name, name, StringComparison.OrdinalIgnoreCase));
            return entry is null ? null : Read(Personal, null, entry);
        }
        var project = _projects.List().FirstOrDefault(p => p.Id == projectId);
        var w = project?.Widgets.FirstOrDefault(x => string.Equals(x.Name, name, StringComparison.OrdinalIgnoreCase));
        return w is null ? null : Read(Project, projectId, w);
    }

    /// <summary>A type's files, by path within its folder.</summary>
    public Dictionary<string, string> Files(WidgetType type)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        if (!Directory.Exists(type.Folder)) return files;
        foreach (var full in Directory.EnumerateFiles(type.Folder, "*", SearchOption.AllDirectories))
        {
            var rel = Path.GetRelativePath(type.Folder, full).Replace('\\', '/');
            if (!WidgetManifest.IsValidFilePath(rel)) continue; // something put there by hand; never served
            if (new FileInfo(full) is { Length: > WidgetManifest.MaxFileBytes }) continue;
            try { files[rel] = File.ReadAllText(full); }
            catch (IOException) { /* being written right now; the next read gets it */ }
        }
        return files;
    }

    /// <summary>
    /// Create or change a type. <paramref name="replace"/> makes <paramref name="files"/> the whole set;
    /// otherwise they are merged over what is there, a null removing a file. <paramref name="expectedRev"/>
    /// null means "create": it fails if the type exists. Otherwise it must be the current revision.
    /// </summary>
    public WidgetWriteResult Write(
        string scope, string? projectId, string name,
        IReadOnlyDictionary<string, string?> files, bool replace, int? expectedRev, string? writer)
    {
        if (!IsValidName(name))
            return new(false, null, [new("", "a widget's name is lowercase letters, digits and dashes, starting with a letter, at most 40 long")], []);

        lock (_lock)
        {
            var existing = Get(scope, projectId, name);
            if (existing is null && expectedRev is not null)
                return new(false, null, [new("", $"there is no {scope} widget \"{name}\" to change")], [], NotFound: true);
            if (existing is not null && expectedRev is null)
                return new(false, existing, [new("", $"a {scope} widget \"{name}\" already exists (rev {existing.Rev}); read it and send its rev to change it")], [], ConflictRev: existing.Rev);
            if (existing is not null && expectedRev != existing.Rev)
                return new(false, existing, [new("", $"\"{name}\" has changed since rev {expectedRev}: it is at rev {existing.Rev}. Read it again and merge")], [], ConflictRev: existing.Rev);

            var next = replace || existing is null ? new Dictionary<string, string>(StringComparer.Ordinal) : Files(existing);
            foreach (var (path, content) in files)
            {
                if (content is null) next.Remove(path);
                else next[path] = content;
            }

            var (_, errors, warnings) = WidgetManifest.Check(name, next);
            if (errors.Count > 0) return new(false, existing, errors, warnings);

            var entry = new ProjectWidget(name, (existing?.Rev ?? 0) + 1, DateTimeOffset.UtcNow, writer);
            // Every refusal before the files are touched, so a refused write leaves nothing on disk.
            if (scope == Personal)
            {
                if (existing is null && _personal.Count >= MaxPerScope)
                    return new(false, null, [new("", $"you already have {MaxPerScope} personal widgets")], warnings);
            }
            else if (_projects.List().FirstOrDefault(p => p.Id == projectId) is not { } project)
                return new(false, null, [new("", "that project is gone")], warnings, NotFound: true);
            else if (existing is null && project.Widgets.Count >= MaxPerScope)
                return new(false, null, [new("", $"the project already has {MaxPerScope} widgets")], warnings);

            var folder = FolderOf(scope, projectId, name);
            try { WriteFolder(folder, next); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.LogWarning(ex, "Could not write widget {Folder}", folder);
                return new(false, existing, [new("", $"could not write the files: {ex.Message}")], warnings);
            }

            if (scope == Personal)
            {
                var at = _personal.FindIndex(w => string.Equals(w.Name, name, StringComparison.OrdinalIgnoreCase));
                if (at >= 0) _personal[at] = entry; else _personal.Add(entry);
                SaveIndex();
            }
            else if (_projects.SaveWidget(projectId!, entry) is null)
                // Only if the project went between the check above and here; its files go with it.
                return new(false, null, [new("", "that project is gone")], warnings, NotFound: true);

            Interlocked.Increment(ref _revision);
            _log.LogInformation("Widget {Scope} {Name} written at rev {Rev} by {Writer}", scope, name, entry.Rev, writer ?? "(unknown)");
            return new(true, Read(scope, projectId, entry), [], warnings);
        }
    }

    /// <summary>Remove a type and its files. False when there was none.</summary>
    public bool Delete(string scope, string? projectId, string name)
    {
        lock (_lock)
        {
            var existing = Get(scope, projectId, name);
            if (existing is null) return false;
            if (scope == Personal)
            {
                _personal.RemoveAll(w => string.Equals(w.Name, name, StringComparison.OrdinalIgnoreCase));
                SaveIndex();
            }
            else _projects.DeleteWidget(projectId!, existing.Name);
            try { if (Directory.Exists(existing.Folder)) Directory.Delete(existing.Folder, recursive: true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _log.LogWarning(ex, "Could not remove widget folder {Folder}", existing.Folder);
            }
            Interlocked.Increment(ref _revision);
            return true;
        }
    }

    private static string SourceKeyOf(IReadOnlyDictionary<string, string> files, WidgetManifest m)
    {
        var text = new System.Text.StringBuilder();
        using (var doc = JsonDocument.Parse(files[WidgetManifest.ManifestFile], new JsonDocumentOptions
               { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }))
        {
            foreach (var part in new[] { "params", "secrets", "source" })
                if (doc.RootElement.TryGetProperty(part, out var v)) text.Append(part).Append('=').Append(v.GetRawText()).Append('\n');
        }
        // The script, and anything beside it that it may import: everything but the manifest and the view.
        if (m.SourceKind == "node")
            foreach (var (path, content) in files.OrderBy(kv => kv.Key, StringComparer.Ordinal))
                if (path is not (WidgetManifest.ManifestFile or WidgetManifest.ViewFile))
                    text.Append(path).Append('=').Append(content).Append('\n');
        return Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(text.ToString())))[..16];
    }

    private string FolderOf(string scope, string? projectId, string name) =>
        Path.Combine(_root, scope == Personal ? Personal : projectId!, name);

    // A type as last read, by folder, with the stamp it was read at: reading means every file read and
    // the whole set checked again, and the list, the view and every fetch ask. Listing a folder's files
    // is cheap; a stamp that still matches (same entry, same sizes and times) gets the type as it was,
    // and a hand edit, which changes a time, gets it read again.
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, (string Stamp, WidgetType Type)> _read =
        new(StringComparer.OrdinalIgnoreCase);

    private WidgetType Read(string scope, string? projectId, ProjectWidget entry)
    {
        var folder = FolderOf(scope, projectId, entry.Name);
        var stamp = Stamp(folder, entry);
        if (_read.TryGetValue(folder, out var hit) && hit.Stamp == stamp) return hit.Type;

        var t = new WidgetType(scope, projectId, entry.Name, folder, entry.Rev, entry.UpdatedAt, entry.UpdatedBy, null, []);
        var files = Files(t);
        if (files.Count == 0) t = t with { Problems = [new("", "its files are missing")] };
        else
        {
            var (manifest, errors, _) = WidgetManifest.Check(entry.Name, files);
            t = t with { Manifest = manifest, Problems = errors, SourceKey = manifest is null ? "" : SourceKeyOf(files, manifest) };
        }
        _read[folder] = (stamp, t);
        return t;
    }

    private static string Stamp(string folder, ProjectWidget entry)
    {
        var sb = new System.Text.StringBuilder($"{entry.Rev}|{entry.UpdatedAt.UtcTicks}|{entry.UpdatedBy}");
        try
        {
            if (Directory.Exists(folder))
                foreach (var f in new DirectoryInfo(folder).EnumerateFiles("*", SearchOption.AllDirectories).OrderBy(f => f.FullName, StringComparer.Ordinal))
                    sb.Append('|').Append(f.FullName).Append(':').Append(f.Length).Append(':').Append(f.LastWriteTimeUtc.Ticks);
        }
        catch (IOException) { sb.Append("|unreadable"); }
        return sb.ToString();
    }

    // The new set goes into a folder of its own beside the old one, and the two are swapped: a reader
    // between two of the writes never sees half of each. A swap that fails halfway (an indexer or a
    // virus scanner holding a file just written, which Windows does) puts the old folder back.
    private static void WriteFolder(string folder, IReadOnlyDictionary<string, string> files)
    {
        var parent = Path.GetDirectoryName(folder)!;
        Directory.CreateDirectory(parent);
        var staging = folder + ".new-" + Guid.NewGuid().ToString("n")[..8];
        Directory.CreateDirectory(staging);
        try
        {
            foreach (var (path, content) in files)
            {
                var full = Path.Combine(staging, path.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                File.WriteAllText(full, content);
            }
            var old = folder + ".old-" + Guid.NewGuid().ToString("n")[..8];
            var hadOld = Directory.Exists(folder);
            if (hadOld) Directory.Move(folder, old);
            try { Directory.Move(staging, folder); }
            catch
            {
                if (hadOld) Directory.Move(old, folder);
                throw;
            }
            // The new set is in; the old one is only clutter now, so failing to clear it is no failure.
            if (hadOld)
                try { Directory.Delete(old, recursive: true); }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* left beside it; never read */ }
        }
        finally
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, recursive: true);
        }
    }

    private sealed record Persisted(List<ProjectWidget>? Widgets);

    private void Load()
    {
        try
        {
            if (!File.Exists(_indexFile)) return;
            var p = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(_indexFile), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            _personal = (p?.Widgets ?? [])
                .Where(w => w is not null && IsValidName(w.Name))
                .DistinctBy(w => w.Name, StringComparer.OrdinalIgnoreCase)
                .Take(MaxPerScope)
                .ToList();
        }
        catch (Exception ex)
        {
            // The files are what matter and they are untouched; a lost index costs the list, which
            // the next write starts again.
            _log.LogWarning(ex, "Could not read {File}; personal widgets start empty", _indexFile);
            _personal = new();
        }
    }

    private void SaveIndex()
    {
        try
        {
            StateFile.Write(_indexFile, JsonSerializer.Serialize(new Persisted(_personal),
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist {File}", _indexFile);
        }
    }
}
