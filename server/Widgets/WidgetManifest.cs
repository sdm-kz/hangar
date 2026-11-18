using System.Text.Json;
using System.Text.RegularExpressions;

namespace Hangar.Server.Widgets;

/// <summary>One finding about a widget's files: which file, where in it, and what is wrong.</summary>
public sealed record WidgetIssue(string File, string Message, string? Path = null, int? Line = null);

/// <summary>A param as the manifest declares it (see widget.schema.json, <c>$defs/param</c>).</summary>
public sealed record WidgetParam(
    string Name,
    string Type,
    string? Label,
    string? Pattern,
    JsonElement? Default,
    bool Required,
    IReadOnlyList<string> From,
    JsonElement Schema);

/// <summary>
/// A widget's <c>widget.json</c>, read: what <see cref="WidgetRunner"/> and the client need, with the
/// defaults filled in. Built only from a manifest that has passed <see cref="Check"/>.
/// </summary>
public sealed record WidgetManifest(
    string Name,
    string Title,
    string? Description,
    string? Icon,
    IReadOnlyList<WidgetParam> Params,
    IReadOnlyList<string> Placements,
    string? Badge,
    int? PopoverWidth,
    int? PopoverHeight,
    IReadOnlyList<string> Secrets,
    string SourceKind,
    string Run,
    string? Prompt,
    IReadOnlyList<string> Tools,
    string Model,
    JsonElement? Schema,
    TimeSpan? Refresh,
    TimeSpan Timeout)
{
    public const string ManifestFile = "widget.json";
    public const string ViewFile = "view.html";
    public const string DefaultModel = "claude-haiku-4-5-20251001";

    public static readonly TimeSpan MinNodeRefresh = TimeSpan.FromSeconds(30);
    public static readonly TimeSpan MinClaudeRefresh = TimeSpan.FromMinutes(15);

    // Where a file in a widget's folder may be, and what it may be: the folder itself or one level
    // down, plain names, and only the kinds a widget is made of. Nothing dotted (the preview's rule:
    // a dotted entry is how a secret would hide), nothing that climbs out.
    private static readonly Regex FilePath = new(@"^([a-z0-9][a-z0-9_-]*/)?[a-z0-9][a-z0-9._-]*\.(json|html|mjs|js|md|css|txt)$",
        RegexOptions.CultureInvariant);

    public const int MaxFiles = 20;
    public const int MaxFileBytes = 256 * 1024;
    public const int MaxTotalBytes = 1024 * 1024;

    private static readonly Lazy<JsonElement> SchemaDoc = new(() =>
    {
        using var doc = JsonDocument.Parse(WidgetGuide.Resource("widget.schema.json"));
        return doc.RootElement.Clone();
    });

    /// <summary>The manifest schema, as served in the guide and as every write is checked against.</summary>
    public static JsonElement ManifestSchema => SchemaDoc.Value;

    public static bool IsValidFilePath(string path) => FilePath.IsMatch(path) && !path.Contains("..", StringComparison.Ordinal);

    /// <summary>
    /// Check a complete set of a widget's files, as they would be after a write. Errors stop the write;
    /// warnings go back with a write that succeeds. Returns the read manifest when there were no errors.
    /// </summary>
    public static (WidgetManifest? Manifest, List<WidgetIssue> Errors, List<WidgetIssue> Warnings) Check(
        string name, IReadOnlyDictionary<string, string> files)
    {
        var errors = new List<WidgetIssue>();
        var warnings = new List<WidgetIssue>();

        if (files.Count > MaxFiles) errors.Add(new("", $"a widget has at most {MaxFiles} files (this has {files.Count})"));
        var total = 0;
        foreach (var (path, content) in files)
        {
            if (!IsValidFilePath(path))
                errors.Add(new(path, "not a file a widget may have: lowercase names, at most one folder deep, " +
                                     "ending .json, .html, .mjs, .js, .md, .css or .txt"));
            var bytes = System.Text.Encoding.UTF8.GetByteCount(content);
            total += bytes;
            if (bytes > MaxFileBytes) errors.Add(new(path, $"is {bytes / 1024} KB; a widget file may be at most {MaxFileBytes / 1024} KB"));
        }
        if (total > MaxTotalBytes) errors.Add(new("", $"the files add up to {total / 1024} KB; at most {MaxTotalBytes / 1024} KB"));

        if (!files.TryGetValue(ManifestFile, out var manifestText))
        {
            errors.Add(new(ManifestFile, "is missing"));
            return (null, errors, warnings);
        }
        if (!files.ContainsKey(ViewFile)) errors.Add(new(ViewFile, "is missing: every widget has a view"));

        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(manifestText, new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            root = doc.RootElement.Clone();
        }
        catch (JsonException ex)
        {
            errors.Add(new(ManifestFile, $"is not valid JSON: {ex.Message}", Line: ex.LineNumber is { } l ? (int)l + 1 : null));
            return (null, errors, warnings);
        }

        foreach (var e in MiniSchema.Validate(ManifestSchema, root))
            errors.Add(new(ManifestFile, e.Message, e.Path.Length == 0 ? "/" : e.Path));
        if (errors.Count > 0)
        {
            // The view is checked anyway, so one answer lists everything wrong rather than half of it.
            if (files.TryGetValue(ViewFile, out var early)) CheckView(early, errors, warnings);
            return (null, errors, warnings);
        }

        var m = Read(root);
        if (!string.Equals(m.Name, name, StringComparison.Ordinal))
            errors.Add(new(ManifestFile, $"name is \"{m.Name}\" but it is being written as \"{name}\"", "/name"));

        foreach (var p in m.Params)
        {
            if (p.Pattern is { } pat && MiniSchema.PatternError(pat) is { } why)
                errors.Add(new(ManifestFile, $"pattern does not compile: {why}", $"/params/{p.Name}/pattern"));
            if (!Regex.IsMatch(p.Name, "^[a-zA-Z][a-zA-Z0-9_]{0,39}$"))
                errors.Add(new(ManifestFile, "a param's name is letters, digits and _, starting with a letter", $"/params/{p.Name}"));
        }

        switch (m.SourceKind)
        {
            case "node":
                if (!files.ContainsKey(m.Run)) errors.Add(new(m.Run, $"is missing: source.run names it", "/source/run"));
                if (m.Refresh is { } nr && nr < MinNodeRefresh)
                    errors.Add(new(ManifestFile, $"a node source refreshes at most every 30s; got {Text(nr)}", "/source/refresh"));
                if (m.Prompt is not null || m.Tools.Count > 0)
                    warnings.Add(new(ManifestFile, "prompt and tools are for a claude source; a node source ignores them", "/source"));
                break;
            case "claude":
                if (string.IsNullOrWhiteSpace(m.Prompt)) errors.Add(new(ManifestFile, "a claude source needs a prompt", "/source/prompt"));
                if (m.Schema is null) errors.Add(new(ManifestFile, "a claude source needs a schema for its answer", "/source/schema"));
                if (m.Refresh is { } cr && cr < MinClaudeRefresh)
                    errors.Add(new(ManifestFile, $"a claude source refreshes at most every 15 min; got \"{Text(cr)}\"", "/source/refresh"));
                if (m.Secrets.Count > 0)
                    warnings.Add(new(ManifestFile, "a claude source is never given secrets; its MCP connectors bring their own sign-in", "/secrets"));
                if (m.Tools.Count == 0)
                    warnings.Add(new(ManifestFile, "no tools: the run can only answer from the prompt itself", "/source/tools"));
                break;
        }

        if (m.Badge is not null && !m.Placements.Any(p => p is "tab-popover" or "header"))
            warnings.Add(new(ManifestFile, "badge is shown only by the tab-popover and header placements", "/badge"));

        if (files.TryGetValue(ViewFile, out var view)) CheckView(view, errors, warnings);

        return (errors.Count == 0 ? m : null, errors, warnings);
    }

    /// <summary>Read a manifest that has already passed the schema (anything else throws).</summary>
    public static WidgetManifest Read(JsonElement root)
    {
        string? Str(JsonElement e, string n) => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
        int? Int(JsonElement e, string n) => e.TryGetProperty(n, out var v) && v.TryGetInt32(out var i) ? i : null;
        List<string> Strs(JsonElement e, string n) => e.TryGetProperty(n, out var v) && v.ValueKind == JsonValueKind.Array
            ? v.EnumerateArray().Select(x => x.GetString()).OfType<string>().ToList()
            : [];

        var name = Str(root, "name")!;
        var parms = new List<WidgetParam>();
        if (root.TryGetProperty("params", out var ps) && ps.ValueKind == JsonValueKind.Object)
            foreach (var p in ps.EnumerateObject())
            {
                var def = p.Value;
                JsonElement? dflt = def.TryGetProperty("default", out var d) ? d.Clone() : null;
                var required = def.TryGetProperty("required", out var req) ? req.ValueKind == JsonValueKind.True : dflt is null;
                parms.Add(new WidgetParam(p.Name, Str(def, "type") ?? "string", Str(def, "label"), Str(def, "pattern"),
                    dflt, required, Strs(def, "from"), def.Clone()));
            }

        var source = root.GetProperty("source");
        var kind = Str(source, "kind")!;
        var placements = Strs(root, "placements");
        JsonElement? popover = root.TryGetProperty("popover", out var pop) ? pop : null;

        return new WidgetManifest(
            Name: name,
            Title: Str(root, "title") ?? name,
            Description: Str(root, "description"),
            Icon: Str(root, "icon"),
            Params: parms,
            Placements: placements.Count > 0 ? placements.Distinct().ToList() : ["tab"],
            Badge: Str(root, "badge"),
            PopoverWidth: popover is { } pw ? Int(pw, "width") : null,
            PopoverHeight: popover is { } ph ? Int(ph, "height") : null,
            Secrets: Strs(root, "secrets").Distinct().ToList(),
            SourceKind: kind,
            Run: Str(source, "run") ?? "fetch.mjs",
            Prompt: Str(source, "prompt"),
            Tools: Strs(source, "tools").Distinct().ToList(),
            Model: Str(source, "model") ?? DefaultModel,
            Schema: source.TryGetProperty("schema", out var s) ? s.Clone() : null,
            Refresh: ParseRefresh(Str(source, "refresh")),
            Timeout: TimeSpan.FromSeconds(Int(source, "timeoutSeconds") ?? (kind == "claude" ? 120 : 30)));
    }

    /// <summary>"30s", "5m", "1h" as a span; null for "manual" or nothing.</summary>
    public static TimeSpan? ParseRefresh(string? text)
    {
        if (text is null or "manual") return null;
        var m = Regex.Match(text, "^([1-9][0-9]*)(s|m|h)$");
        if (!m.Success || !int.TryParse(m.Groups[1].Value, out var n)) return null;
        return m.Groups[2].Value switch { "s" => TimeSpan.FromSeconds(n), "m" => TimeSpan.FromMinutes(n), _ => TimeSpan.FromHours(n) };
    }

    private static string Text(TimeSpan t) => t.TotalHours >= 1 && t.TotalHours % 1 == 0 ? $"{t.TotalHours}h"
        : t.TotalMinutes >= 1 && t.TotalMinutes % 1 == 0 ? $"{t.TotalMinutes}m"
        : $"{t.TotalSeconds}s";

    // The view runs where it cannot reach the network (see WidgetView's CSP), so a reference out of it
    // is a view that will come up broken. A script, stylesheet, image or frame loaded from elsewhere
    // simply does not load: that is an error, said now rather than discovered as an empty pane. A
    // fetch() will throw at runtime: a warning, since the code may never take that path.
    // A view is up to 256 KB, possibly on one line, written by whoever wrote it: each look is bounded.
    private static readonly TimeSpan ScanLimit = TimeSpan.FromMilliseconds(250);
    private static readonly Regex ExternalLoad = new(
        @"<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*\b(src|href|data)\s*=\s*[""']?\s*(https?:)?//",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ScanLimit);
    private static readonly Regex CssImport = new(@"@import\s+(url\()?\s*[""']?\s*(https?:)?//|url\(\s*[""']?\s*(https?:)?//",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ScanLimit);
    private static readonly Regex NetworkCall = new(@"\b(fetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource\s*\(|navigator\.sendBeacon)",
        RegexOptions.CultureInvariant, ScanLimit);
    private static readonly Regex OutLink = new(@"<a\b[^>]*\bhref\s*=\s*[""']?\s*https?://",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, ScanLimit);

    private static void CheckView(string html, List<WidgetIssue> errors, List<WidgetIssue> warnings)
    {
        try { ScanView(html, errors, warnings); }
        catch (RegexMatchTimeoutException)
        {
            errors.Add(new(ViewFile, "could not be checked in reasonable time; break its long lines up"));
        }
    }

    private static void ScanView(string html, List<WidgetIssue> errors, List<WidgetIssue> warnings)
    {
        var lines = html.Split('\n');
        for (var i = 0; i < lines.Length; i++)
        {
            var line = lines[i];
            if (ExternalLoad.IsMatch(line) || CssImport.IsMatch(line))
                errors.Add(new(ViewFile, "loads something from the network; a view has no network — inline it, or fetch the data in the source", Line: i + 1));
            else if (NetworkCall.IsMatch(line))
                warnings.Add(new(ViewFile, "makes a network call; a view has no network, so it will fail — get the data through hangar.onData", Line: i + 1));
            if (OutLink.IsMatch(line))
                warnings.Add(new(ViewFile, "an <a href> cannot navigate out of the view; call hangar.openUrl(url) on click instead", Line: i + 1));
        }
    }
}
