using System.Text.Json;
using System.Text.Json.Nodes;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// Registers ClaudeWeb's <c>http</c> hooks in <c>~/.claude/settings.json</c> so every launched session
/// reports its lifecycle events back to the app (consumed by <see cref="HookEventStore"/> to drive
/// reliable busy/idle/waiting status). Best-effort and conservative, mirroring <see cref="ClaudeBypassStore"/>:
/// backs the file up once, writes atomically, and only merges our own handlers — a handler is identified
/// by its <c>/api/hooks</c> URL, so re-running just refreshes the port and never duplicates or disturbs
/// the user's other hooks.
///
/// The hooks carry correlation via headers interpolated from environment variables we inject into each
/// session's process (<c>CLAUDEWEB_SESSION_ID</c> / <c>CLAUDEWEB_HOOK_TOKEN</c>). For a plain <c>claude</c>
/// run those vars are unset, so the headers are empty and the server treats the callback as a no-op.
/// </summary>
public static class ClaudeHookStore
{
    private static string SettingsPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "settings.json");

    // Events we register handlers for — exactly those HookEventStore turns into status transitions.
    private static readonly string[] Events =
    {
        "SessionStart", "SessionEnd", "UserPromptSubmit",
        "PreToolUse", "PostToolUse", "PostToolUseFailure",
        "SubagentStart", "Notification", "PermissionRequest",
        "Stop", "StopFailure",
    };

    private const string UrlPath = "/api/hooks"; // discriminates our handler within the settings file

    public static void EnsureConfigured(int port, ILogger log)
    {
        try
        {
            var path = SettingsPath;
            var url = $"http://127.0.0.1:{port}{UrlPath}";

            JsonObject root;
            if (File.Exists(path))
            {
                root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject();
            }
            else
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                root = new JsonObject();
            }

            if (root["hooks"] is not JsonObject hooks)
            {
                hooks = new JsonObject();
                root["hooks"] = hooks;
            }

            bool changed = false;
            foreach (var evt in Events)
            {
                // Leave anything unexpected (a non-array value) untouched rather than clobber user data.
                if (hooks[evt] is not null && hooks[evt] is not JsonArray)
                {
                    log.LogWarning("Skipping hook event {Event}: existing settings value is not an array", evt);
                    continue;
                }
                if (hooks[evt] is not JsonArray groups)
                {
                    groups = new JsonArray();
                    hooks[evt] = groups;
                }

                if (FindOurHandler(groups) is { } existing)
                {
                    // Already registered — just refresh the URL in case the port changed.
                    if (existing["url"]?.GetValue<string>() != url)
                    {
                        existing["url"] = url;
                        changed = true;
                    }
                }
                else
                {
                    groups.Add(new JsonObject
                    {
                        ["matcher"] = "",
                        ["hooks"] = new JsonArray { BuildHandler(url) },
                    });
                    changed = true;
                }
            }

            if (!changed)
                return; // nothing to write — hooks already current

            // One-time backup so the user can restore if anything looks wrong.
            var backup = path + ".claudeweb-hooks-backup";
            if (File.Exists(path) && !File.Exists(backup))
                try { File.Copy(path, backup); } catch { /* non-fatal */ }

            // Atomic-ish replace to avoid a torn write.
            var tmp = path + ".claudeweb-hooks.tmp";
            File.WriteAllText(tmp, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            if (File.Exists(path))
            {
                try { File.Replace(tmp, path, null); }
                catch { File.Copy(tmp, path, overwrite: true); try { File.Delete(tmp); } catch { } }
            }
            else
            {
                File.Move(tmp, path);
            }

            log.LogInformation("Registered ClaudeWeb hooks in ~/.claude/settings.json (endpoint {Url})", url);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not register ClaudeWeb hooks");
        }
    }

    // Our handler = an http hook whose url path is /api/hooks, in any matcher group of the event.
    private static JsonObject? FindOurHandler(JsonArray groups)
    {
        foreach (var group in groups)
        {
            if (group is not JsonObject g || g["hooks"] is not JsonArray handlers) continue;
            foreach (var h in handlers)
            {
                if (h is not JsonObject ho) continue;
                var url = ho["url"]?.GetValue<string>();
                if (ho["type"]?.GetValue<string>() == "http" && url is not null && url.Contains(UrlPath, StringComparison.OrdinalIgnoreCase))
                    return ho;
            }
        }
        return null;
    }

    private static JsonObject BuildHandler(string url) => new()
    {
        ["type"] = "http",
        ["url"] = url,
        ["timeout"] = 5,
        ["headers"] = new JsonObject
        {
            ["X-Session-Id"] = "$CLAUDEWEB_SESSION_ID",
            ["X-Hook-Token"] = "$CLAUDEWEB_HOOK_TOKEN",
        },
        ["allowedEnvVars"] = new JsonArray { "CLAUDEWEB_SESSION_ID", "CLAUDEWEB_HOOK_TOKEN" },
    };
}
