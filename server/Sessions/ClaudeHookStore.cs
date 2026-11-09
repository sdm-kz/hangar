using System.Net;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hangar.Server.Sessions;

/// <summary>
/// Registers Hangar's <c>http</c> hooks in <c>~/.claude/settings.json</c> so every launched session
/// reports its lifecycle events back to the app (consumed by <see cref="HookEventStore"/> to drive
/// reliable busy/idle/waiting status). Best-effort and conservative, mirroring <see cref="ClaudeBypassStore"/>:
/// backs the file up once, writes atomically, and only merges our own handlers — a handler is identified
/// by its <c>/api/hooks</c> URL, so re-running just refreshes the port and never duplicates or disturbs
/// the user's other hooks.
///
/// The hooks carry correlation via headers interpolated from environment variables we inject into each
/// session's process (<c>HANGAR_SESSION_ID</c> / <c>HANGAR_HOOK_TOKEN</c>). For a plain <c>claude</c>
/// run those vars are unset, so the headers are empty and the server treats the callback as a no-op.
///
/// <c>SessionStart</c> is the exception: Claude runs only <c>command</c> hooks for it, and skips an
/// <c>http</c> one without a word. It is what reports the conversation a <c>/clear</c> starts, so it is
/// registered as a command that posts the same payload to the same URL with <c>curl</c> (see
/// <see cref="BuildCommand"/>).
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

    // The events Claude runs only command hooks for (see the class summary).
    private static readonly HashSet<string> CommandEvents = new() { "SessionStart" };

    /// <param name="port">The port this instance is bound to; hooks are pointed at it.</param>
    /// <param name="force">
    /// Take the registration over even when another instance is live on the port it currently names
    /// (<c>Hooks:Force=true</c>). The guard below is right almost always; this is the way out of the
    /// case where it isn't — a stale registration whose port some unrelated process now holds.
    /// </param>
    /// <param name="settingsPath">The settings file to write; <c>~/.claude/settings.json</c> unless given.</param>
    public static void EnsureConfigured(int port, ILogger log, bool force = false, string? settingsPath = null)
    {
        try
        {
            var path = settingsPath ?? SettingsPath;
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
                    "listening there, so another Hangar is live and owns them. This instance ({Port}) will not " +
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

                var fresh = CommandEvents.Contains(evt) ? BuildCommand(url) : BuildHandler(url);
                if (FindOurHandler(groups) is (var handlers, var at, var existing))
                {
                    if (existing["type"]?.GetValue<string>() != fresh["type"]?.GetValue<string>()
                        || fresh["type"]?.GetValue<string>() == "command")
                    {
                        // Another kind of handler than this event takes (an http SessionStart written by
                        // an earlier version), or a command, which is all one string: put in the new one.
                        if (JsonNode.DeepEquals(existing, fresh)) continue;
                        handlers[at] = fresh;
                        changed = true;
                        continue;
                    }
                    // Already registered — refresh what may have moved: the URL (a port change) and the
                    // variables the headers name.
                    foreach (var key in new[] { "url", "headers", "allowedEnvVars" })
                    {
                        if (JsonNode.DeepEquals(existing[key], fresh[key])) continue;
                        existing[key] = fresh[key]?.DeepClone();
                        changed = true;
                    }
                }
                else
                {
                    groups.Add(new JsonObject
                    {
                        ["matcher"] = "",
                        ["hooks"] = new JsonArray { fresh },
                    });
                    changed = true;
                }
            }

            if (!changed)
                return; // nothing to write — hooks already current

            // One-time backup so the user can restore if anything looks wrong.
            var backup = path + ".hangar-hooks-backup";
            if (File.Exists(path) && !File.Exists(backup))
                try { File.Copy(path, backup); } catch { /* non-fatal */ }

            // Atomic-ish replace to avoid a torn write.
            var tmp = path + ".hangar-hooks.tmp";
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

            log.LogInformation("Registered Hangar hooks in ~/.claude/settings.json (endpoint {Url})", url);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not register Hangar hooks");
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
            if (FindOurHandler(groups) is not (_, _, var handler)) continue;
            if (PortOf(UrlOf(handler)) is not { } other) continue;
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

    // Our handler = an http hook whose url path is /api/hooks, or a command posting to one, in any matcher
    // group of the event. With the list it is in and its place there, for it to be swapped for another.
    private static (JsonArray Handlers, int At, JsonObject Handler)? FindOurHandler(JsonArray groups)
    {
        foreach (var group in groups)
        {
            if (group is not JsonObject g || g["hooks"] is not JsonArray handlers) continue;
            for (var i = 0; i < handlers.Count; i++)
            {
                if (handlers[i] is JsonObject ho && UrlOf(ho) is { } url && url.Contains(UrlPath, StringComparison.OrdinalIgnoreCase))
                    return (handlers, i, ho);
            }
        }
        return null;
    }

    // The URL a handler calls: an http hook's own, or the one a command of ours posts to.
    private static string? UrlOf(JsonObject handler)
    {
        string? Text(string key) => handler[key] is JsonValue v && v.TryGetValue<string>(out var t) ? t : null;
        return Text("type") switch
        {
            "http" => Text("url"),
            "command" when Text("command") is { } c && OurCommandUrl.Match(c) is { Success: true } m => m.Value,
            _ => null,
        };
    }

    private static readonly System.Text.RegularExpressions.Regex OurCommandUrl =
        new(@"http://127\.0\.0\.1:\d+/api/hooks", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// A command that does what <see cref="BuildHandler"/>'s http hook does: posts the hook's payload (its
    /// stdin) to <paramref name="url"/> with the session's headers. Run by Claude's shell — sh, or Git Bash on
    /// Windows. A plain <c>claude</c> run, which has no session to report, posts nothing; and it says nothing
    /// and always succeeds, since what a SessionStart hook prints is handed to Claude as context and a failure
    /// is shown in the terminal, neither of which a Hangar that isn't answering should cause.
    /// </summary>
    private static JsonObject BuildCommand(string url) => new()
    {
        ["type"] = "command",
        ["command"] =
            "if [ -n \"$HANGAR_SESSION_ID\" ]; then curl -s -m 5 -o /dev/null -X POST " +
            "-H 'Content-Type: application/json' -H \"X-Session-Id: $HANGAR_SESSION_ID\" " +
            $"-H \"X-Hook-Token: $HANGAR_HOOK_TOKEN\" --data-binary @- {url} >/dev/null 2>&1; " +
            "else cat >/dev/null; fi; exit 0",
        ["timeout"] = 10,
    };

    private static JsonObject BuildHandler(string url) => new()
    {
        ["type"] = "http",
        ["url"] = url,
        ["timeout"] = 5,
        ["headers"] = new JsonObject
        {
            ["X-Session-Id"] = "$HANGAR_SESSION_ID",
            ["X-Hook-Token"] = "$HANGAR_HOOK_TOKEN",
        },
        ["allowedEnvVars"] = new JsonArray { "HANGAR_SESSION_ID", "HANGAR_HOOK_TOKEN" },
    };
}
