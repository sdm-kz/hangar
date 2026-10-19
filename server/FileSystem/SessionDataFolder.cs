namespace Hangar.Server.FileSystem;

/// <summary>
/// The folder Hangar keeps its own files in under a session's working directory: images pasted into
/// a session (<c>uploads/</c>), postponed messages (<c>postponed/</c>) and pull-request reviews
/// (<c>reviews/</c>). It ignores itself: the first write into it leaves a <c>.gitignore</c> of
/// <c>*</c> there, so git never lists it and no repo's own <c>.gitignore</c> has to mention it.
/// Before the rename the folder was <c>.claudeweb/</c>; what is in one of those is read where it
/// lies (see <see cref="LegacyName"/>), and nothing new is written there.
/// </summary>
public static class SessionDataFolder
{
    public const string Name = ".hangar";

    /// <summary>The folder's name before the rename. Its uploads stay where they are, since
    /// conversations and postponed messages name them by path.</summary>
    public const string LegacyName = ".claudeweb";

    public const string Uploads = Name + "/uploads";
    public const string LegacyUploads = LegacyName + "/uploads";

    /// <summary>
    /// Make sure the <c>.hangar</c> folder that <paramref name="fullPath"/> is in (or is) ignores
    /// itself. A no-op for a path outside one, and for a folder that already has a <c>.gitignore</c> —
    /// one somebody wrote is theirs. Best-effort: a write that worked is not failed over this.
    /// </summary>
    public static void Claim(string? fullPath)
    {
        if (string.IsNullOrEmpty(fullPath)) return;
        try
        {
            for (var dir = new DirectoryInfo(Path.GetFullPath(fullPath)); dir is not null; dir = dir.Parent)
            {
                if (!dir.Name.Equals(Name, StringComparison.OrdinalIgnoreCase)) continue;
                if (!dir.Exists) return;
                var ignore = Path.Combine(dir.FullName, ".gitignore");
                if (!File.Exists(ignore))
                    File.WriteAllText(ignore, "# Hangar's own files (pasted images, postponed messages, reviews).\n*\n");
                return;
            }
        }
        catch { /* best-effort */ }
    }
}
