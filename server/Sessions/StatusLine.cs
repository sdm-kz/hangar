using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace Hangar.Server.Sessions;

/// <summary>
/// What Claude last said about a session in its status line: the model, and how full the context window is.
/// <see cref="ContextPercent"/> is Claude's own figure — it alone knows the window's size, which depends on
/// the model, the account and a beta or two.
/// </summary>
public sealed record SessionStatus(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Model = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] double? ContextPercent = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] long? ContextWindow = null);

/// <summary>
/// Claude's status line, borrowed to learn a session's model and context use. Claude runs a status-line
/// command whenever its state changes and pipes it a JSON description of the session; Hangar hands each
/// session it launches one (through <c>--settings</c>, so <c>~/.claude/settings.json</c> is left alone) that
/// posts that JSON to <c>/api/self/statusline</c> and prints the answer, which becomes the line Claude shows.
/// </summary>
/// <remarks>
/// Only where no status line is set — in ~/.claude or in the project: a session-wide setting would replace it,
/// and that one was chosen. Then the chat falls back to what the transcript says (the model, and the
/// tokens in context without the percentage).
/// </remarks>
public sealed class StatusLineStore
{
    private readonly ConcurrentDictionary<string, SessionStatus> _byId = new();

    public SessionStatus? Get(string sessionId) => _byId.GetValueOrDefault(sessionId);

    /// <summary>Take in what Claude piped to the status line; returns the line for Claude to show.</summary>
    public string Ingest(string sessionId, JsonElement body)
    {
        var prev = Get(sessionId);
        string? model = null;
        double? percent = null;
        long? window = null;
        if (body.ValueKind == JsonValueKind.Object)
        {
            if (body.TryGetProperty("model", out var m) && m.ValueKind == JsonValueKind.Object)
                model = Str(m, "display_name") ?? Str(m, "id");
            if (body.TryGetProperty("context_window", out var c) && c.ValueKind == JsonValueKind.Object)
            {
                if (c.TryGetProperty("used_percentage", out var p) && p.ValueKind == JsonValueKind.Number)
                    percent = Math.Clamp(p.GetDouble(), 0, 100);
                if (c.TryGetProperty("context_window_size", out var w) && w.ValueKind == JsonValueKind.Number)
                    window = w.GetInt64();
            }
        }
        // The percentage as Claude has it, null included: there is none before the first reply, and none
        // after a /clear, and the one from before would be a reading of a conversation that is gone.
        var status = new SessionStatus(model ?? prev?.Model, percent, window ?? prev?.ContextWindow);
        _byId[sessionId] = status;
        return Line(status);
    }

    /// <summary>The status line itself, which is also what the terminal shows: "Opus 5.5 · 24% context".</summary>
    public static string Line(SessionStatus s) =>
        string.Join(" · ", new[]
        {
            s.Model,
            s.ContextPercent is { } p ? $"{Math.Round(p)}% context" : null,
        }.Where(x => !string.IsNullOrEmpty(x)));

    private static readonly object FileLock = new();
    private static string? _file;

    /// <summary>
    /// The settings file a launch in <paramref name="workingDirectory"/> passes with <c>--settings</c>; null when
    /// a status line is already set — the user's, or the project's, which <c>--settings</c> would override — or
    /// the file can't be written. The session then launches without one.
    /// </summary>
    public static string? SettingsFile(string workingDirectory, ILogger log)
    {
        if (HasStatusLine(workingDirectory)) return null;
        lock (FileLock)
        {
            if (_file is not null) return _file;
            try
            {
                var path = AppDataFolder.PathFor("claude-session-settings.json");
                // The env vars are the ones the hooks use (see ClaudeSession.BuildEnvironment); Claude runs the
                // command in its shell — bash, Git Bash on Windows — which expands them. -m: a Hangar that
                // doesn't answer must not hold the status line up.
                const string command =
                    "curl -s -m 2 -X POST -H \"Content-Type: application/json\" " +
                    "-H \"X-Session-Id: $HANGAR_SESSION_ID\" -H \"X-Hook-Token: $HANGAR_HOOK_TOKEN\" " +
                    "--data-binary @- \"$HANGAR_URL/api/self/statusline\"";
                var json = new JsonObject
                {
                    ["statusLine"] = new JsonObject { ["type"] = "command", ["command"] = command, ["padding"] = 0 },
                }.ToJsonString(new JsonSerializerOptions
                {
                    WriteIndented = true,
                    // Readable quotes in a file someone may open to see what Hangar gave Claude.
                    Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
                });
                // Written once a run, whole: a claude already running may read the old file at any moment.
                if (!File.Exists(path) || File.ReadAllText(path) != json)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                    var temp = path + ".tmp";
                    File.WriteAllText(temp, json);
                    File.Move(temp, path, overwrite: true);
                }
                return _file = path;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                log.LogWarning(ex, "Couldn't write the status-line settings; this session launches without them");
                return null;
            }
        }
    }

    // ~/.claude/settings.json, and .claude/settings.json and settings.local.json in the folder and its parents.
    private static bool HasStatusLine(string workingDirectory)
    {
        var files = new List<string> { Path.Combine(ClaudeProjectData.ConfigDir(), "settings.json") };
        for (var dir = workingDirectory; !string.IsNullOrEmpty(dir); dir = Path.GetDirectoryName(dir))
        {
            files.Add(Path.Combine(dir, ".claude", "settings.json"));
            files.Add(Path.Combine(dir, ".claude", "settings.local.json"));
        }
        return files.Any(SetsStatusLine);
    }

    private static bool SetsStatusLine(string file)
    {
        try
        {
            if (!File.Exists(file)) return false;
            using var doc = JsonDocument.Parse(File.ReadAllBytes(file));
            return doc.RootElement.ValueKind == JsonValueKind.Object
                && doc.RootElement.TryGetProperty("statusLine", out var s) && s.ValueKind == JsonValueKind.Object;
        }
        // Unreadable or half-written: assume one is there rather than risk replacing it.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            return true;
        }
    }

    private static string? Str(JsonElement obj, string name) =>
        obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
