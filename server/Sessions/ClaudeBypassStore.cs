using System.Text.Json;
using System.Text.Json.Nodes;

namespace Hangar.Server.Sessions;

/// <summary>
/// Pre-accepts Claude Code's one-time "Bypass Permissions mode" warning by writing
/// <c>skipDangerousModePermissionPrompt = true</c> into <c>~/.claude/settings.json</c>, so a session
/// launched with <c>--dangerously-skip-permissions</c> doesn't block on the acceptance screen (there
/// is no human to press "Yes, I accept" in our headless pseudo-terminal). Best-effort and
/// conservative: backs the file up once, writes atomically, and only ADDS the key if missing.
/// The suppression flag lives in user settings, NOT <c>~/.claude.json</c> (see <see cref="ClaudeTrustStore"/>).
/// </summary>
public static class ClaudeBypassStore
{
    private static string SettingsPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "settings.json");

    public static void EnsurePromptSuppressed(ILogger log)
    {
        try
        {
            var path = SettingsPath;

            JsonObject root;
            if (File.Exists(path))
            {
                root = JsonNode.Parse(File.ReadAllText(path)) as JsonObject ?? new JsonObject();
            }
            else
            {
                // No settings file yet: create a minimal one carrying just the flag.
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                root = new JsonObject();
            }

            if (root["skipDangerousModePermissionPrompt"]?.GetValue<bool>() == true)
                return; // already suppressed — leave the rest of the file untouched

            root["skipDangerousModePermissionPrompt"] = true;

            // One-time backup so the user can restore if anything looks wrong.
            // One made before the rename (.claudeweb-backup) already holds the original.
            var backup = path + ".hangar-backup";
            if (File.Exists(path) && !File.Exists(backup) && !File.Exists(path + ".claudeweb-backup"))
                try { File.Copy(path, backup); } catch { /* non-fatal */ }

            // Atomic-ish replace to avoid a torn write.
            var tmp = path + ".hangar.tmp";
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

            log.LogInformation("Pre-accepted Bypass Permissions mode in ~/.claude/settings.json");
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not pre-accept Bypass Permissions mode");
        }
    }
}
