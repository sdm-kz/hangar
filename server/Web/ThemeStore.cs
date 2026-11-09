using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hangar.Server.Web;

/// <summary>
/// The <c>Ui</c> section of the settings: which colour themes the web UI starts on, and themes of the
/// operator's own on top of the built-in ones.
///
/// <para>The built-in themes (GitHub, Solarized, Dracula, ...) live in the client — they are only
/// colours, and the client is what paints them. The server knows them by id alone, which is all
/// <see cref="LightTheme"/>, <see cref="DarkTheme"/> and a theme's base need.</para>
/// </summary>
public sealed class UiOptions
{
    /// <summary>The theme a browser that has not picked one uses in light mode; empty = the client's default.</summary>
    public string LightTheme { get; set; } = "";

    /// <summary>The theme a browser that has not picked one uses in dark mode; empty = the client's default.</summary>
    public string DarkTheme { get; set; } = "";

    /// <summary>
    /// Themes defined in the settings file. One whose id is a built-in's tunes that built-in in place;
    /// any other is a new theme, drawn from its <see cref="ThemeDefinition.Base"/> with its colours on top.
    /// </summary>
    public List<ThemeDefinition> Themes { get; set; } = new();
}

/// <summary>A theme as the settings file spells it. Everything but the id may be left out.</summary>
public sealed class ThemeDefinition
{
    public string Id { get; set; } = "";
    public string? Name { get; set; }
    /// <summary>The theme this one starts from (a built-in's id, or another theme's); null = the built-in of the same id.</summary>
    public string? Base { get; set; }
    /// <summary>Colour overrides by token: <c>background</c>, <c>primary</c>, <c>syntax-keyword</c>, <c>terminal-red</c>, ...</summary>
    public Dictionary<string, string> Colors { get; set; } = new();
}

/// <summary>A theme the client can draw: a base and the colours that differ from it.</summary>
public sealed record UiTheme(
    string Id,
    /// <summary>Null = the base's name (a settings-file theme that only tunes a built-in).</summary>
    string? Name,
    /// <summary>Null = the built-in of the same id.</summary>
    string? Base,
    IReadOnlyDictionary<string, string> Colors);

/// <summary>A create or an update of a theme made in the UI. On an update a null field is left as it was; colours are replaced whole.</summary>
public sealed record UiThemePatch(string? Name = null, string? Base = null, Dictionary<string, string>? Colors = null);

/// <summary>Everything the client needs to offer the themes: the defaults, and the themes beyond the built-in ones.</summary>
public sealed record UiThemesState(
    string LightTheme,
    string DarkTheme,
    /// <summary>From the settings file — read-only in the UI, which can only copy them.</summary>
    IReadOnlyList<UiTheme> Configured,
    /// <summary>Made (or tuned) in the UI, kept in themes.json.</summary>
    IReadOnlyList<UiTheme> Custom);

/// <summary>
/// The colour themes beyond the built-in ones: those the settings file defines, and those made in the
/// Themes dialog, persisted to %LocalAppData%\Hangar\themes.json so a theme tuned on the PC is there on
/// the phone too — like the templates. Which theme a browser is <em>showing</em> is that browser's own
/// choice and stays in it: a phone in the dark and a desktop in daylight want different ones.
///
/// <para>Colours end up as CSS custom properties, so every value is held to what a colour can look like
/// — no <c>;</c>, quotes, braces or <c>url(</c> — before it is stored or served. The client checks them
/// again against the browser's own idea of a colour before it paints one.</para>
/// </summary>
public sealed class ThemeStore
{
    private const int MaxThemes = 100;
    private const int MaxColors = 80;
    private const int MaxNameLength = 60;
    private const int MaxIdLength = 40;
    private const int MaxValueLength = 120;

    private static readonly Regex TokenPattern = new("^[a-z][a-z0-9-]{0,39}$", RegexOptions.CultureInvariant);
    // #hex, a name, or a colour function — rgb(), oklch(), color-mix(in oklch, ...) — of plain numbers.
    private static readonly Regex ValuePattern = new(@"^[#a-zA-Z0-9.,%/()\s+-]+$", RegexOptions.CultureInvariant);

    private readonly string _file;
    private readonly ILogger<ThemeStore> _log;
    private readonly object _lock = new();
    private readonly string _lightTheme;
    private readonly string _darkTheme;
    private readonly IReadOnlyList<UiTheme> _configured;
    private List<UiTheme> _custom = new();

    public ThemeStore(UiOptions options, ILogger<ThemeStore> log)
    {
        _log = log;
        _file = AppDataFolder.PathFor("themes.json");
        _lightTheme = CleanId(options.LightTheme) ?? "";
        _darkTheme = CleanId(options.DarkTheme) ?? "";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        _configured = (options.Themes ?? new())
            .Where(t => t is not null)
            .Select(t => CleanId(t.Id) is { } id && seen.Add(id)
                ? new UiTheme(id, CleanName(t.Name), CleanId(t.Base), CleanColors(t.Colors))
                : null)
            .OfType<UiTheme>()
            .Take(MaxThemes)
            .ToArray();
        Load();
    }

    public UiThemesState State()
    {
        lock (_lock) return Snapshot();
    }

    /// <summary>Create a theme. Returns null when it has no name or base, or the store is full.</summary>
    public UiThemesState? Create(UiThemePatch p)
    {
        var name = CleanName(p.Name);
        var baseId = CleanId(p.Base);
        if (name is null || baseId is null) return null;
        lock (_lock)
        {
            if (_custom.Count >= MaxThemes) return null;
            _custom.Add(new UiTheme("custom-" + Guid.NewGuid().ToString("n")[..12], name, baseId, CleanColors(p.Colors)));
            Save();
            return Snapshot();
        }
    }

    /// <summary>Update a theme. Returns null when there is no such theme, or the new name or base is blank.</summary>
    public UiThemesState? Update(string id, UiThemePatch p)
    {
        lock (_lock)
        {
            var i = _custom.FindIndex(t => t.Id == id);
            if (i < 0) return null;
            var t = _custom[i];
            var name = p.Name is null ? t.Name : CleanName(p.Name);
            var baseId = p.Base is null ? t.Base : CleanId(p.Base);
            if (name is null || baseId is null) return null;
            _custom[i] = t with
            {
                Name = name,
                Base = baseId,
                Colors = p.Colors is null ? t.Colors : CleanColors(p.Colors),
            };
            Save();
            return Snapshot();
        }
    }

    /// <summary>Delete a theme. Returns null when there is no such theme.</summary>
    public UiThemesState? Delete(string id)
    {
        lock (_lock)
        {
            var i = _custom.FindIndex(t => t.Id == id);
            if (i < 0) return null;
            _custom.RemoveAt(i);
            Save();
            return Snapshot();
        }
    }

    // ---- helpers -------------------------------------------------------------------------------

    private UiThemesState Snapshot() => new(_lightTheme, _darkTheme, _configured, _custom.ToArray());

    private static string? CleanName(string? name)
    {
        var trimmed = name?.Trim();
        if (string.IsNullOrEmpty(trimmed)) return null;
        return trimmed.Length > MaxNameLength ? trimmed[..MaxNameLength] : trimmed;
    }

    /// <summary>Whether a theme id (a base, a default) is one the store would keep.</summary>
    public static bool IsThemeId(string? id) => CleanId(id) is not null;

    private static string? CleanId(string? id)
    {
        var trimmed = id?.Trim().ToLowerInvariant();
        return trimmed is { Length: > 0 and <= MaxIdLength } && TokenPattern.IsMatch(trimmed) ? trimmed : null;
    }

    /// <summary>The colours that look like colours, under names that look like tokens; the rest are dropped.</summary>
    private static IReadOnlyDictionary<string, string> CleanColors(IReadOnlyDictionary<string, string>? colors)
    {
        var clean = new Dictionary<string, string>(StringComparer.Ordinal);
        if (colors is null) return clean;
        foreach (var (key, value) in colors)
        {
            if (clean.Count >= MaxColors) break;
            var token = key?.Trim().ToLowerInvariant();
            var v = value?.Trim();
            if (token is null || !TokenPattern.IsMatch(token)) continue;
            if (string.IsNullOrEmpty(v) || v.Length > MaxValueLength || !ValuePattern.IsMatch(v)) continue;
            if (v.Contains("url", StringComparison.OrdinalIgnoreCase)) continue;
            clean[token] = v;
        }
        return clean;
    }

    private sealed record Persisted(List<UiTheme>? Themes);

    // Set when the state file exists but couldn't be read, which makes Save() stand down — see Load().
    private bool _unreadable;

    private void Load()
    {
        try
        {
            if (!File.Exists(_file)) return;
            var p = JsonSerializer.Deserialize<Persisted>(
                File.ReadAllText(_file), new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (p?.Themes is null) return;
            var seen = new HashSet<string>(StringComparer.Ordinal);
            _custom = p.Themes
                // A hand-edited file can hold a null entry; skipping it keeps the other themes.
                .Where(t => t is not null && !string.IsNullOrWhiteSpace(t.Id) && seen.Add(t.Id))
                .Select(t => CleanName(t.Name) is { } name && CleanId(t.Base) is { } baseId
                    ? new UiTheme(t.Id, name, baseId, CleanColors(t.Colors))
                    : null)
                .OfType<UiTheme>()
                .Take(MaxThemes)
                .ToList();
        }
        // A failed read leaves the store empty, and the next save would write that emptiness back
        // over the file. Which repair that calls for turns on why the read failed — see StateFile.
        catch (Exception ex) when (StateFile.IsAccessFailure(ex))
        {
            _log.LogWarning(ex, "Could not read themes from {File}; it will not be written this run", _file);
            _custom.Clear();
            _unreadable = true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not load themes from {File}; setting it aside", _file);
            _custom.Clear();
            _unreadable = !StateFile.SetAside(_file, _log, "themes");
        }
    }

    private void Save()
    {
        if (_unreadable)
        {
            _log.LogDebug("Not writing themes: {File} could not be read at startup", _file);
            return;
        }
        try
        {
            StateFile.Write(_file, JsonSerializer.Serialize(
                new Persisted(_custom),
                new JsonSerializerOptions(JsonSerializerDefaults.Web) { WriteIndented = true }));
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist themes to {File}", _file);
        }
    }
}
