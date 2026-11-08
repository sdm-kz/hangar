using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hangar.Server.Sessions;

/// <summary>
/// A slash command Claude would take in a session's folder. <see cref="Source"/> is <c>builtin</c>,
/// <c>project</c>, <c>user</c> or <c>plugin</c>; <see cref="Dialog"/> marks a command that answers with a
/// picker or a panel in the terminal, or with output only the terminal shows, rather than in the conversation.
/// </summary>
public sealed record SlashCommand(
    string Name,
    string Source,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Description = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Hint = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Dialog = false);

/// <summary>
/// The slash commands for the chat view's autocomplete. Claude has no way to ask for its list short of
/// starting it, so this reads what it reads: the commands and skills in the folder's <c>.claude</c> (and its
/// parents'), in <c>~/.claude</c>, in enabled and synced plugins, plus Claude's own commands, kept below.
/// </summary>
/// <remarks>
/// Everything is read loosely — a file that can't be read or parsed is left out, never fails the list. The
/// built-in table follows Claude Code 2.1; a command a newer Claude adds is missing from the suggestions
/// but can still be typed.
/// </remarks>
public static class SlashCommands
{
    private const int HeadBytes = 8 * 1024;
    private const int MaxDescription = 200;

    // (name, argument hint, description, opens a dialog in the terminal)
    private static readonly (string Name, string? Hint, string Description, bool Dialog)[] BuiltIns =
    [
        ("add-dir", "<path>", "Add a working directory", false),
        ("agents", null, "Manage subagents", true),
        ("background", "[prompt]", "Send this session to the background", false),
        ("btw", "<question>", "Ask a side question without adding to the conversation", true),
        ("clear", null, "Clear the conversation and start fresh", false),
        ("compact", "[instructions]", "Summarize the conversation to free up context", false),
        ("config", null, "Open settings", true),
        ("context", null, "Show what is using the context window", true),
        ("copy", "[N]", "Copy Claude's last response to the clipboard", true),
        ("diff", null, "Show the changes made in this session", true),
        ("doctor", null, "Check the Claude Code installation", true),
        ("effort", "[level]", "Set the effort level", true),
        ("exit", null, "Exit Claude", false),
        ("export", "[file]", "Export the conversation to a file or the clipboard", true),
        ("fast", null, "Toggle fast mode", false),
        ("feedback", null, "Send feedback about Claude Code", true),
        ("fork", "[prompt]", "Copy this conversation into a new background session", false),
        ("goal", "[<condition> | clear]", "Set a goal Claude checks before stopping", false),
        ("help", null, "Show help and available commands", true),
        ("hooks", null, "View hook configuration", true),
        ("ide", null, "Manage IDE integrations", true),
        ("init", null, "Create a CLAUDE.md with notes on this codebase", false),
        ("insights", null, "Generate a report analyzing your Claude Code sessions", false),
        ("login", null, "Sign in to your Anthropic account", true),
        ("logout", null, "Sign out of your Anthropic account", true),
        ("mcp", null, "Manage MCP servers", true),
        ("memory", null, "Edit CLAUDE.md files and memory settings", true),
        ("model", "[model]", "Choose the model", true),
        ("output-style", "[style]", "List output styles or switch to one", true),
        ("permissions", null, "Manage tool permission rules", true),
        ("plan", "[description]", "Enable plan mode or view the current plan", true),
        ("plugin", null, "Manage plugins", true),
        ("privacy-settings", null, "View and update privacy settings", true),
        ("recap", null, "Generate a one-line session recap", false),
        ("reload-plugins", null, "Pick up plugins changed on disk", false),
        ("reload-skills", null, "Pick up skills added or changed on disk", false),
        ("remote-control", null, "Continue this session from claude.ai or the Claude app", true),
        ("rename", "[name]", "Rename the conversation", false),
        ("resume", "[conversation]", "Resume another conversation", true),
        ("rewind", null, "Rewind the conversation or code to an earlier point", true),
        ("security-review", null, "Review the pending changes for security issues", false),
        ("skills", null, "List available skills", true),
        ("status", null, "Show version, model, account and connectivity", true),
        ("tasks", null, "List and manage background tasks", true),
        ("terminal-setup", null, "Set up Shift+Enter for newlines", true),
        ("theme", null, "Change the color theme", true),
        ("ultrareview", "[PR]", "Run a multi-agent cloud review of this branch", false),
        ("usage", null, "Show plan usage, limits and session cost", true),
        ("version", null, "Print the running version", false),
        // Skills that ship with Claude Code.
        ("batch", "<instruction>", "Run a large change in parallel across the codebase", false),
        ("claude-api", null, "Build and debug apps on the Claude API", false),
        ("code-review", null, "Review the current changes", false),
        ("debug", null, "Debug the current session", false),
        ("fewer-permission-prompts", null, "Add allow rules for the commands you approve most", false),
        ("loop", "[interval] <prompt>", "Run a prompt on a recurring interval", false),
        ("schedule", null, "Create a routine that runs on a schedule", false),
        ("simplify", null, "Review changed code for reuse, quality and efficiency", false),
        ("update-config", null, "Change Claude Code settings through Claude", false),
        ("verify", null, "Verify that a change works by running it", false),
    ];

    private static StringComparer NameComparer => StringComparer.Ordinal;

    /// <summary>The commands for a session in <paramref name="workingDirectory"/>, sorted by name.</summary>
    public static IReadOnlyList<SlashCommand> List(string workingDirectory)
    {
        // The first source to name a command wins: the closest project folder, then the user's own, then
        // plugins, then Claude's — the order Claude resolves a clash in.
        var found = new Dictionary<string, SlashCommand>(NameComparer);
        void Add(SlashCommand c) => found.TryAdd(c.Name, c);

        var config = ClaudeProjectData.ConfigDir();
        var home = Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(config));
        var projects = ProjectFolders(workingDirectory, home).ToList();

        foreach (var dir in projects)
        {
            Commands(Path.Combine(dir, ".claude", "commands"), null, "project", Add);
            Skills(Path.Combine(dir, ".claude", "skills"), null, "project", Add);
        }
        Commands(Path.Combine(config, "commands"), null, "user", Add);
        Skills(Path.Combine(config, "skills"), null, "user", Add);
        foreach (var (name, path) in Plugins(config, projects))
        {
            Commands(Path.Combine(path, "commands"), name, "plugin", Add);
            Skills(Path.Combine(path, "skills"), name, "plugin", Add);
        }
        SyncedSkills(config, Add);
        foreach (var b in BuiltIns) Add(new SlashCommand(b.Name, "builtin", b.Description, b.Hint, b.Dialog));

        return found.Values.OrderBy(c => c.Name, NameComparer).ToList();
    }

    // The folder and each parent up to (not including) the home folder, whose .claude is the user's own.
    private static IEnumerable<string> ProjectFolders(string workingDirectory, string? home)
    {
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        for (var dir = workingDirectory; !string.IsNullOrEmpty(dir); dir = Path.GetDirectoryName(dir))
        {
            if (home is not null && string.Equals(Path.TrimEndingDirectorySeparator(dir), home, comparison)) yield break;
            yield return dir;
        }
    }

    // A command is a markdown file; one in a subfolder keeps its own name (the folder only groups it).
    private static void Commands(string dir, string? plugin, string source, Action<SlashCommand> add)
    {
        foreach (var file in Files(dir, "*.md", SearchOption.AllDirectories))
        {
            var meta = Head(file);
            var name = Path.GetFileNameWithoutExtension(file);
            add(new SlashCommand(Qualify(plugin, name), source, meta.Description, meta.Hint));
        }
    }

    // A skill is a folder with a SKILL.md; one marked user-invocable: false is Claude's to call, not yours.
    private static void Skills(string dir, string? plugin, string source, Action<SlashCommand> add)
    {
        foreach (var skillDir in Folders(dir))
        {
            var file = Path.Combine(skillDir, "SKILL.md");
            if (!File.Exists(file)) continue;
            var meta = Head(file);
            if (meta.UserInvocable == false) continue;
            var name = meta.Name is { Length: > 0 } n && !n.Contains(' ') ? n : Path.GetFileName(skillDir);
            add(new SlashCommand(Qualify(plugin, name), source, meta.Description, meta.Hint));
        }
    }

    private static string Qualify(string? plugin, string name) => plugin is null ? name : $"{plugin}:{name}";

    /// <summary>
    /// Enabled plugins, as (name, folder): those switched on in the user's settings or a project's (the
    /// closer setting wins) and installed, plus the ones synced from claude.ai, which are always on.
    /// </summary>
    private static IEnumerable<(string Name, string Path)> Plugins(string config, List<string> projects)
    {
        var enabled = new Dictionary<string, bool>(StringComparer.Ordinal);
        // Furthest first, so a closer folder's setting overwrites it.
        var settings = new List<string> { Path.Combine(config, "settings.json") };
        foreach (var dir in Enumerable.Reverse(projects))
        {
            settings.Add(Path.Combine(dir, ".claude", "settings.json"));
            settings.Add(Path.Combine(dir, ".claude", "settings.local.json"));
        }
        foreach (var file in settings)
        {
            if (ReadJson(file) is not { } doc) continue;
            using (doc)
            {
                if (doc.RootElement.ValueKind == JsonValueKind.Object
                    && doc.RootElement.TryGetProperty("enabledPlugins", out var map) && map.ValueKind == JsonValueKind.Object)
                    foreach (var p in map.EnumerateObject())
                        if (p.Value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                            enabled[p.Name] = p.Value.ValueKind == JsonValueKind.True;
            }
        }

        if (ReadJson(Path.Combine(config, "plugins", "installed_plugins.json")) is { } installed)
        {
            using (installed)
            {
                if (installed.RootElement.ValueKind == JsonValueKind.Object
                    && installed.RootElement.TryGetProperty("plugins", out var plugins) && plugins.ValueKind == JsonValueKind.Object)
                {
                    foreach (var p in plugins.EnumerateObject())
                    {
                        if (!enabled.GetValueOrDefault(p.Name) || p.Value.ValueKind != JsonValueKind.Array) continue;
                        // An install per scope; any one that is still on disk has the same commands.
                        var path = p.Value.EnumerateArray()
                            .Select(e => e.ValueKind == JsonValueKind.Object && e.TryGetProperty("installPath", out var ip)
                                && ip.ValueKind == JsonValueKind.String ? ip.GetString() : null)
                            .LastOrDefault(ip => ip is not null && Directory.Exists(ip));
                        if (path is not null) yield return (p.Name.Split('@')[0], path);
                    }
                }
            }
        }

        foreach (var bucket in Folders(Path.Combine(config, "plugins", "synced")))
        {
            foreach (var dir in Folders(bucket))
            {
                if (ReadJson(Path.Combine(dir, ".claude-plugin", "plugin.json")) is not { } doc) continue;
                string? name;
                using (doc)
                    name = doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty("name", out var n)
                        && n.ValueKind == JsonValueKind.String ? n.GetString() : null;
                if (name is { Length: > 0 }) yield return (name, dir);
            }
        }
    }

    // Skills synced from claude.ai are listed, with their descriptions, in each bucket's manifest.
    private static void SyncedSkills(string config, Action<SlashCommand> add)
    {
        foreach (var bucket in Folders(Path.Combine(config, "skills", "synced")))
        {
            if (ReadJson(Path.Combine(bucket, "manifest.json")) is not { } doc) continue;
            using (doc)
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Object
                    || !doc.RootElement.TryGetProperty("skills", out var skills) || skills.ValueKind != JsonValueKind.Array) continue;
                foreach (var s in skills.EnumerateArray())
                {
                    if (Str(s, "name") is not { Length: > 0 } name) continue;
                    add(new SlashCommand($"anthropic-skills:{name}", "plugin", Shorten(Str(s, "description"))));
                }
            }
        }
    }

    private sealed record Meta(string? Name, string? Description, string? Hint, bool? UserInvocable);

    /// <summary>
    /// The YAML front matter's name, description, argument-hint and user-invocable — read line by line, as
    /// they are written in practice — or, for a file with none, its first line as the description.
    /// </summary>
    private static Meta Head(string file)
    {
        string text;
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            var buffer = new byte[HeadBytes];
            var read = stream.ReadAtLeast(buffer, buffer.Length, throwOnEndOfStream: false);
            text = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return new Meta(null, null, null, null);
        }

        var lines = text.Replace("\r\n", "\n").Split('\n');
        if (lines.Length == 0 || lines[0].Trim() != "---")
        {
            var first = lines.Select(l => l.Trim().TrimStart('#').Trim()).FirstOrDefault(l => l.Length > 0);
            return new Meta(null, Shorten(first), null, null);
        }

        string? name = null, description = null, hint = null;
        bool? invocable = null;
        for (var i = 1; i < lines.Length && lines[i].Trim() != "---"; i++)
        {
            var line = lines[i];
            if (line.Length == 0 || char.IsWhiteSpace(line[0])) continue;
            var colon = line.IndexOf(':');
            if (colon <= 0) continue;
            var key = line[..colon].Trim();
            var value = line[(colon + 1)..].Trim();
            // A folded or literal block (description: > / |): its text is the indented lines that follow.
            if (value is ">" or "|" or ">-" or "|-")
            {
                var parts = new List<string>();
                while (i + 1 < lines.Length && lines[i + 1].Length > 0 && char.IsWhiteSpace(lines[i + 1][0]))
                    parts.Add(lines[++i].Trim());
                value = string.Join(' ', parts);
            }
            value = Unquote(value);
            switch (key)
            {
                case "name": name = value; break;
                case "description": description = value; break;
                case "argument-hint": hint = value; break;
                case "user-invocable": invocable = !value.Equals("false", StringComparison.OrdinalIgnoreCase); break;
            }
        }
        return new Meta(name, Shorten(description), hint is { Length: > 0 } ? hint : null, invocable);
    }

    private static string Unquote(string v) =>
        v.Length >= 2 && (v[0] == '"' && v[^1] == '"' || v[0] == '\'' && v[^1] == '\'') ? v[1..^1] : v;

    private static string? Shorten(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        text = text.Trim();
        return text.Length <= MaxDescription ? text : text[..MaxDescription].TrimEnd() + "…";
    }

    private static IEnumerable<string> Files(string dir, string pattern, SearchOption option)
    {
        try { return Directory.Exists(dir) ? Directory.GetFiles(dir, pattern, option) : []; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    private static IEnumerable<string> Folders(string dir)
    {
        try { return Directory.Exists(dir) ? Directory.GetDirectories(dir) : []; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return []; }
    }

    private static JsonDocument? ReadJson(string file)
    {
        try { return File.Exists(file) ? JsonDocument.Parse(File.ReadAllBytes(file)) : null; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException) { return null; }
    }

    private static string? Str(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
}
