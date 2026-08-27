using System.Text.Json;

namespace ClaudeWeb.Server.Update;

/// <summary>
/// Identity of one build, written by scripts\build.ps1 as build.json next to the exe. Two builds are
/// the same iff their <see cref="BuildId"/> matches — that's the whole comparison the updater makes;
/// the rest is for the UI to show ("built 5 minutes ago, commit a1b2c3d").
/// </summary>
/// <param name="BuildId">Stable name for this build: UTC build timestamp + short commit.</param>
/// <param name="Commit">Short commit hash the build came from; null outside a git checkout.</param>
/// <param name="Branch">Branch the build came from; null outside a git checkout.</param>
/// <param name="BuiltAtUtc">When the build ran.</param>
public sealed record BuildStamp(string BuildId, string? Commit, string? Branch, DateTime? BuiltAtUtc)
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    /// <summary>The build.json inside <paramref name="folder"/>, or null when it's missing or unreadable.</summary>
    public static BuildStamp? Read(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder)) return null;
        try
        {
            var path = Path.Combine(folder, "build.json");
            if (!File.Exists(path)) return null;
            var stamp = JsonSerializer.Deserialize<BuildStamp>(File.ReadAllText(path), JsonOpts);
            // A stamp with no id can't be compared, so it's no more useful than a missing one.
            return string.IsNullOrWhiteSpace(stamp?.BuildId) ? null : stamp;
        }
        catch
        {
            // Mid-write, half-copied, or hand-edited into nonsense: treat as "no stamp here" and let
            // the next read pick it up. A staged build is polled, so this self-corrects.
            return null;
        }
    }
}
