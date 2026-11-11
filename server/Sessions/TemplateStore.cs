using System.Text.Json;

namespace Hangar.Server.Sessions;

/// <summary>
/// A <em>session template</em>: a named, reusable way to start a particular kind of session — the
/// project it belongs to, the folder it runs in, the prompt it opens with, and the launch settings
/// that go with it.
///
/// <para>It exists because the same errands come back week after week ("look into this log entry",
/// "review this support request", "ship this Jira issue") and each one is the same launch every time
/// except for one detail: the error text, the request, the issue key. A template holds everything but
/// that detail, so starting the session is picking the template and pasting the detail in.</para>
///
/// <para><see cref="Prompt"/> is that template: the client substitutes the typed detail for a
/// <c>{input}</c> placeholder, and appends it on its own paragraph when the prompt has no
/// placeholder — so <c>/fix-issue {input}</c> and a plain "investigate this log entry"
/// both do the obvious thing. The substitution is the client's: this store only keeps the text.</para>
///
/// <para><see cref="ProjectId"/> is a soft reference. A template whose project has since been deleted
/// is kept and simply shows under "No project" — the same deal a virtual folder's membership gets
/// when its project stops linking the folder.</para>
/// </summary>
public sealed record SessionTemplate(
    string Id,
    string Name,
    /// <summary>The project this template starts a session in, or null when it belongs to none.</summary>
    string? ProjectId,
    /// <summary>Absolute path the session runs in. May be empty while the template is being set up.</summary>
    string WorkingDirectory,
    /// <summary>The prompt template, with an optional <c>{input}</c> placeholder. May be empty.</summary>
    string Prompt,
    /// <summary>"" | opus | sonnet | haiku — as the New Session dialog's model dropdown.</summary>
    string Model,
    bool RemoteControl,
    /// <summary>default | auto | acceptEdits | bypassPermissions.</summary>
    string PermissionMode,
    /// <summary>One line under the name in the picker, saying what this template is for. Null = none.</summary>
    string? Description,
    /// <summary>Placeholder for the "details" box — what to paste in. Null = a generic one.</summary>
    string? InputHint);

/// <summary>
/// The fields of a template, as a create or an update. On an update a null field means "leave that
/// one as it was" — the same convention <c>ProjectRequest</c> uses — so clearing the project or the
/// description is done with an empty string, not a null.
/// </summary>
public sealed record SessionTemplatePatch(
    string? Name = null,
    string? ProjectId = null,
    string? WorkingDirectory = null,
    string? Prompt = null,
    string? Model = null,
    bool? RemoteControl = null,
    string? PermissionMode = null,
    string? Description = null,
    string? InputHint = null);

/// <summary>
/// Server-side store for session templates, persisted to %LocalAppData%\Hangar\templates.json so
/// they follow the user across every browser and device pointed at this app — like
/// <see cref="ProjectStore"/> and <see cref="RecentsStore"/>, and unlike the sidebar's per-browser
/// view preferences.
///
/// Every mutation returns the full list, so a caller can replace its state from the response instead
/// of patching it and hoping the two agree.
/// </summary>
public sealed class TemplateStore
{
    private const int MaxTemplates = 200;
    private const int MaxNameLength = 80;
    private const int MaxPromptLength = 8000;
    private const int MaxHintLength = 200;
    private const int MaxShortLength = 64;

    private readonly string _file;
    private readonly ILogger<TemplateStore> _log;
    private readonly object _lock = new();
    private List<SessionTemplate> _templates = new();

    public TemplateStore(ILogger<TemplateStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("templates.json");
        Load();
    }

    /// <summary>Every template, in creation order.</summary>
    public IReadOnlyList<SessionTemplate> List()
    {
        lock (_lock) return Snapshot();
    }

    /// <summary>
    /// Create a template. Returns the updated list, or null when the name is blank or the store is at
    /// capacity. Everything but the name may be filled in later — a template with no folder yet is a
    /// half-written one, not an invalid one, and the dialog that launches it says so.
    /// </summary>
    public IReadOnlyList<SessionTemplate>? Create(SessionTemplatePatch p)
    {
        var name = CleanName(p.Name);
        if (name is null) return null;

        lock (_lock)
        {
            if (_templates.Count >= MaxTemplates) return null;
            _templates.Add(new SessionTemplate(
                Guid.NewGuid().ToString("n"),
                name,
                Blank(p.ProjectId) ? null : Clip(p.ProjectId!.Trim(), MaxShortLength),
                Normalize(p.WorkingDirectory) ?? "",
                Clip((p.Prompt ?? "").Trim(), MaxPromptLength),
                CleanModel(p.Model),
                p.RemoteControl ?? true,
                CleanPermissionMode(p.PermissionMode),
                Blank(p.Description) ? null : Clip(p.Description!.Trim(), MaxHintLength),
                Blank(p.InputHint) ? null : Clip(p.InputHint!.Trim(), MaxHintLength)));
            Save();
            return Snapshot();
        }
    }

    /// <summary>
    /// Update a template. A null field is left as it was; an empty project id, description or hint
    /// clears that one. Returns null when there is no such template, or the new name is blank.
    /// </summary>
    public IReadOnlyList<SessionTemplate>? Update(string id, SessionTemplatePatch p)
    {
        lock (_lock)
        {
            var i = _templates.FindIndex(t => t.Id == id);
            if (i < 0) return null;
            var t = _templates[i];

            var name = p.Name is null ? t.Name : CleanName(p.Name);
            if (name is null) return null; // a rename to blank is a slip, not an intent

            _templates[i] = t with
            {
                Name = name,
                ProjectId = p.ProjectId is null
                    ? t.ProjectId
                    : Blank(p.ProjectId) ? null : Clip(p.ProjectId.Trim(), MaxShortLength),
                // An empty folder or prompt is a real value here (the field was cleared), so only a
                // null leaves them alone.
                WorkingDirectory = p.WorkingDirectory is null
                    ? t.WorkingDirectory
                    : Normalize(p.WorkingDirectory) ?? "",
                Prompt = p.Prompt is null ? t.Prompt : Clip(p.Prompt.Trim(), MaxPromptLength),
                Model = p.Model is null ? t.Model : CleanModel(p.Model),
                RemoteControl = p.RemoteControl ?? t.RemoteControl,
                PermissionMode = p.PermissionMode is null
                    ? t.PermissionMode
                    : CleanPermissionMode(p.PermissionMode),
                Description = p.Description is null
                    ? t.Description
                    : Blank(p.Description) ? null : Clip(p.Description.Trim(), MaxHintLength),
                InputHint = p.InputHint is null
                    ? t.InputHint
                    : Blank(p.InputHint) ? null : Clip(p.InputHint.Trim(), MaxHintLength),
            };
            Save();
            return Snapshot();
        }
    }

    /// <summary>Delete a template. Returns the updated list, or null when there is no such template.</summary>
    public IReadOnlyList<SessionTemplate>? Delete(string id)
    {
        lock (_lock)
        {
            var i = _templates.FindIndex(t => t.Id == id);
            if (i < 0) return null;
            _templates.RemoveAt(i);
            Save();
            return Snapshot();
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    /// <summary>The permission modes the launcher understands; anything else falls back to the default.</summary>
    private static readonly string[] PermissionModes =
        ["default", "auto", "acceptEdits", "bypassPermissions"];

    private static readonly string[] Models = ["", "opus", "sonnet", "haiku"];

    private IReadOnlyList<SessionTemplate> Snapshot() => _templates.ToArray();

    private static bool Blank(string? s) => string.IsNullOrWhiteSpace(s);

    private static string Clip(string s, int max) => s.Length > max ? s[..max] : s;

    private static string? CleanName(string? name)
    {
        var trimmed = name?.Trim();
        return Blank(trimmed) ? null : Clip(trimmed!, MaxNameLength);
    }

    /// <summary>
    /// A model name folded to one the launcher knows. An unknown one is dropped rather than passed on:
    /// unlike a colour or an icon (which the client draws, and can fall back on), this ends up on
    /// Claude's command line, where a typo is a session that fails to start.
    /// </summary>
    private static string CleanModel(string? model)
    {
        var m = (model ?? "").Trim();
        return Models.Contains(m, StringComparer.OrdinalIgnoreCase) ? m.ToLowerInvariant() : "";
    }

    /// <summary>
    /// A permission mode folded to one the launcher knows, landing on the same value
    /// <see cref="ClaudeSession.NormalizeMode"/> would: anything unrecognised is <c>default</c> —
    /// the mode that asks — and never <c>auto</c>. A typo in a hand-edited file (or in a call to
    /// <c>POST /api/templates</c>) must not quietly buy every session launched from that template
    /// the right to approve its own edits.
    /// </summary>
    private static string CleanPermissionMode(string? mode)
    {
        var m = (mode ?? "").Trim();
        var match = PermissionModes.FirstOrDefault(x => string.Equals(x, m, StringComparison.OrdinalIgnoreCase));
        return match ?? "default";
    }

    /// <summary>
    /// A folder path as the project store spells them, so a template's folder and a project's link
    /// compare equal. An empty path stays empty — a template may be saved before its folder is chosen.
    /// </summary>
    private static string? Normalize(string? path)
    {
        if (Blank(path)) return null;
        try
        {
            var full = Path.GetFullPath(path!.Trim());
            var trimmed = full.TrimEnd('/', '\\');
            return trimmed.EndsWith(':') ? full : trimmed;
        }
        catch { return null; }
    }

    private sealed record Persisted(List<SessionTemplate>? Templates);

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(
                File.ReadAllText(_file), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (p?.Templates is null) return;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            _templates = p.Templates
                // `t is not null` is not paranoia: a hand-edited (or truncated) file can hold a null
                // entry. Throwing here is caught below as content we can't load — the file is set aside
                // rather than half-loaded — but skipping the bad entry keeps the other templates.
                .Where(t => t is not null && !Blank(t.Id) && CleanName(t.Name) is not null && seen.Add(t.Id))
                .Take(MaxTemplates)
                .Select(t => t with
                {
                    Name = CleanName(t.Name)!,
                    ProjectId = Blank(t.ProjectId) ? null : Clip(t.ProjectId!.Trim(), MaxShortLength),
                    WorkingDirectory = Normalize(t.WorkingDirectory) ?? "",
                    Prompt = Clip((t.Prompt ?? "").Trim(), MaxPromptLength),
                    Model = CleanModel(t.Model),
                    PermissionMode = CleanPermissionMode(t.PermissionMode),
                    Description = Blank(t.Description) ? null : Clip(t.Description!.Trim(), MaxHintLength),
                    InputHint = Blank(t.InputHint) ? null : Clip(t.InputHint!.Trim(), MaxHintLength),
                })
                .ToList();
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            // Couldn't get at the file — locked, or permissions. What is in it is presumably fine, so
            // it stays exactly where it is and nothing is written over it for the rest of the run.
            _log.LogWarning(ex, "Could not read session templates from {File}; it will not be written this run", _file);
            _templates.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            // Could not make sense of it — truncated by a stop mid-write, or hand-edited into something
            // that won't load. It will never read any better, so set it aside and carry on from a clean
            // slate; if it can't even be moved, then it must not be written over either.
            _log.LogWarning(ex, "Could not load session templates from {File}; setting it aside", _file);
            _templates.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "session templates");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            // Debug, not a warning: Load() already said this once, loudly, and this runs on every save.
            _log.LogDebug("Not writing session templates: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Persisted(_templates),
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist session templates to {File}", _file);
        }
    }
}
