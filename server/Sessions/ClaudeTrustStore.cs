using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hangar.Server.Sessions;

/// <summary>
/// Pre-accepts Claude Code's workspace-trust prompt for a folder by writing
/// <c>projects[folder].hasTrustDialogAccepted = true</c> into <c>~/.claude.json</c>, so a launched
/// interactive session doesn't block on the trust dialog. Best-effort and conservative:
/// backs the file up once, writes atomically, and only ADDS entries for folders not already present.
/// </summary>
public static class ClaudeTrustStore
{
    private static string ConfigPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude.json");

    public static void EnsureTrusted(string folder, ILogger log)
    {
        try
        {
            var path = ConfigPath;
            if (!File.Exists(path))
            {
                log.LogWarning("~/.claude.json not found; cannot pre-trust {Folder}", folder);
                return;
            }

            // Claude keys projects by forward-slash paths (case-sensitive), e.g. "C:/Git/proj".
            var key = Path.GetFullPath(folder).Replace('\\', '/');

            var root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            if (root is null) return;

            if (root["projects"] is not JsonObject projects)
            {
                projects = new JsonObject();
                root["projects"] = projects;
            }

            if (projects[key] is JsonObject existing)
            {
                if (existing["hasTrustDialogAccepted"]?.GetValue<bool>() == true)
                    return; // already trusted — nothing to do, and we don't disturb existing entries
                existing["hasTrustDialogAccepted"] = true;
            }
            else
            {
                projects[key] = new JsonObject
                {
                    ["allowedTools"] = new JsonArray(),
                    ["hasTrustDialogAccepted"] = true,
                    ["projectOnboardingSeenCount"] = 1,
                };
            }

            // One-time backup so the user can restore if anything looks wrong.
            var backup = path + ".claudeweb-backup";
            if (!File.Exists(backup))
                try { File.Copy(path, backup); } catch { /* non-fatal */ }

            // Atomic-ish replace to avoid a torn write.
            var tmp = path + ".claudeweb.tmp";
            File.WriteAllText(tmp, root.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            try { File.Replace(tmp, path, null); }
            catch { File.Copy(tmp, path, overwrite: true); try { File.Delete(tmp); } catch { } }

            log.LogInformation("Pre-trusted folder {Key} in ~/.claude.json", key);
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Auto-trust failed for {Folder}", folder);
        }
    }
}
