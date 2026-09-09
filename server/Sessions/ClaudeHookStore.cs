using System.Net;
using System.Net.NetworkInformation;
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

    /// <param name="port">The port this instance is bound to; hooks are pointed at it.</param>
    /// <param name="force">
    /// Take the registration over even when another instance is live on the port it currently names
    /// (<c>Hooks:Force=true</c>). The guard below is right almost always; this is the way out of the
    /// case where it isn't — a stale registration whose port some unrelated process now holds.
    /// </param>
    public static void EnsureConfigured(int port, ILogger log, bool force = false)
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

            // Stand down if the registration already belongs to an instance that is still up.
            //
            // This file is GLOBAL — one ~/.claude/settings.json for every Claude Code session on the
            // machine — while the handler is identified only by its /api/hooks path, so any second
            // instance used to silently repoint all of them at itself. Start a debug build beside the
            // live app and stop it again, and every session on the machine then fails every tool call
            // with "hook error connect ECONNREFUSED" against a port nothing answers on any more. The
            // instance that is actually running is the one whose hooks should be live, and a port with
            // a listener on it is the only evidence of that available from here.
            if (!force && OwnedByLiveInstance(hooks, port) is { } owner)
            {
                log.LogWarning(
                    "Leaving the Claude hooks in ~/.claude/settings.json pointed at port {Owner}: something is " +
                    "listening there, so another ClaudeWeb is live and owns them. This instance ({Port}) will not " +
                    "receive hook events, so its session status falls back to terminal heuristics. Set " +
                    "Hooks:Force=true to take them over, or Hooks:Enabled=false to stop asking.",
                    owner, port);
                return;
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

    /// <summary>
    /// The port an already-registered handler names, when that is a <b>different</b> instance and
    /// something is still listening there — i.e. the registration is in use and not ours to move.
    /// Null when there is no registration, when it already points at us, or when whatever wrote it
    /// is gone (the ordinary case of a port change, which we then take over as before).
    /// </summary>
    private static int? OwnedByLiveInstance(JsonObject hooks, int ourPort)
    {
        foreach (var evt in Events)
        {
            if (hooks[evt] is not JsonArray groups) continue;
            if (FindOurHandler(groups) is not { } handler) continue;
            if (PortOf(handler["url"]?.GetValue<string>()) is not { } other) continue;
            if (other == ourPort) return null; // already ours — nothing to guard
            return IsListening(other) ? other : null;
        }
        return null;
    }

    private static int? PortOf(string? url) =>
        Uri.TryCreate(url, UriKind.Absolute, out var u) && u.Port > 0 ? u.Port : null;

    /// <summary>
    /// Whether a local socket is accepting on <paramref name="port"/>. Read from the OS listener
    /// table rather than by connecting: this runs on the startup path, and a connect to a port that
    /// blackholes would sit there for the whole handshake timeout.
    /// </summary>
    private static bool IsListening(int port)
    {
        try
        {
            return IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpListeners().Any(e =>
                e.Port == port &&
                // Match how a server binds rather than how a client reaches it: "0.0.0.0" and "::"
                // both answer on loopback, which is where the hook URL points.
                (IPAddress.IsLoopback(e.Address) || e.Address.Equals(IPAddress.Any) ||
                 e.Address.Equals(IPAddress.IPv6Any)));
        }
        catch
        {
            // No listener table to read (locked-down host): assume nothing is there rather than
            // refusing to register, which would leave the hooks broken for a reason nobody can see.
            return false;
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
