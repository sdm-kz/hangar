namespace ClaudeWeb.Server.FileSystem;

/// <summary>A file or directory entry with its absolute path (for the general server-fs browser).</summary>
public sealed record FsNode(string Name, string Path, bool IsDir, long Size);

/// <summary>
/// A directory listing for the sidebar Files tree: the folder being listed (<paramref name="Current"/>),
/// its parent, the machine's drive roots (so the tree can start at the top), and the child entries.
/// </summary>
public sealed record FsListing(
    string? Current,
    string? Parent,
    IReadOnlyList<DirEntry> Drives,
    IReadOnlyList<FsNode> Entries);

/// <summary>
/// General read/write access to the server machine's filesystem for the sidebar Files panel. Unlike
/// <see cref="SessionFileBrowser"/> this is NOT confined to a session's working directory — it takes
/// absolute paths, matching the whole-filesystem reach the folder picker already exposes. It is still
/// gated behind the same token auth (all routes live under <c>/api</c>), and every operation swallows
/// IO/permission faults into a null/false result rather than throwing.
/// </summary>
public static class ServerFileBrowser
{
    /// <summary>List a directory's children (dirs first, then files), or the drive roots when no path
    /// is given. Hidden/system entries are skipped to match the folder picker.</summary>
    public static FsListing Browse(string? path, string? defaultFolder = null)
    {
        var drives = DriveRoots();

        if (string.IsNullOrWhiteSpace(path))
        {
            // Open at the configured default folder (falling back to the user profile) so the tree
            // lands somewhere useful, while still exposing every drive for navigating elsewhere.
            var start = !string.IsNullOrWhiteSpace(defaultFolder) && Directory.Exists(defaultFolder)
                ? defaultFolder!
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Directory.Exists(start)
                ? Browse(start, defaultFolder)
                : new FsListing(null, null, drives, Array.Empty<FsNode>());
        }

        var full = Path.GetFullPath(path.Trim());
        if (!Directory.Exists(full))
            return new FsListing(full, null, drives, Array.Empty<FsNode>());

        var entries = new List<FsNode>();
        try
        {
            foreach (var d in Directory.EnumerateDirectories(full))
            {
                if (IsHidden(d)) continue;
                entries.Add(new FsNode(Path.GetFileName(d), d, true, 0));
            }
            foreach (var f in Directory.EnumerateFiles(full))
            {
                if (IsHidden(f)) continue;
                long size = 0;
                try { size = new FileInfo(f).Length; } catch { }
                entries.Add(new FsNode(Path.GetFileName(f), f, false, size));
            }
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }

        entries.Sort((a, b) =>
            a.IsDir != b.IsDir ? (a.IsDir ? -1 : 1)
                               : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));

        var parent = Directory.GetParent(full)?.FullName;
        return new FsListing(full, parent, drives, entries);
    }

    /// <summary>Overwrite (or create) a text file. Returns false if its parent directory is missing.</summary>
    public static bool WriteText(string path, string content)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full);
        if (dir is null || !Directory.Exists(dir)) return false;
        try { File.WriteAllText(full, content); return true; }
        catch { return false; }
    }

    /// <summary>Create a directory (and any missing parents). Returns its full path, or null on failure.</summary>
    public static string? Mkdir(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        try
        {
            var full = Path.GetFullPath(path);
            Directory.CreateDirectory(full);
            return full;
        }
        catch { return null; }
    }

    /// <summary>Create a new empty file. Returns its full path, or null if the parent is missing or it
    /// already exists.</summary>
    public static string? NewFile(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        var full = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(full);
        if (dir is null || !Directory.Exists(dir)) return null;
        if (File.Exists(full) || Directory.Exists(full)) return null;
        try { using (File.Create(full)) { } return full; }
        catch { return null; }
    }

    /// <summary>Rename a file or directory in place. <paramref name="newName"/> is a bare name (path
    /// separators are rejected). Returns the new full path, or null if the source is missing, the name
    /// is invalid, or the target already exists.</summary>
    public static string? Rename(string path, string newName)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(newName)) return null;
        var clean = newName.Trim();
        // A rename must stay in the same folder: reject separators and any invalid filename chars.
        if (clean.Contains('/') || clean.Contains('\\') ||
            clean.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            return null;

        var full = Path.GetFullPath(path);
        var parent = Path.GetDirectoryName(full);
        if (parent is null) return null;
        var target = Path.Combine(parent, clean);
        if (File.Exists(target) || Directory.Exists(target)) return null;

        try
        {
            if (Directory.Exists(full)) Directory.Move(full, target);
            else if (File.Exists(full)) File.Move(full, target);
            else return null;
            return target;
        }
        catch { return null; }
    }

    /// <summary>Save an uploaded stream into <paramref name="folder"/> under a clobber-free name.
    /// Returns the written full path, or null if the folder is missing.</summary>
    public static async Task<string?> SaveUpload(string folder, string fileName, Stream content)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder)) return null;
        var safeName = Path.GetFileName(fileName); // drop any path parts in the client-supplied name
        if (string.IsNullOrWhiteSpace(safeName)) return null;

        var target = UniquePath(Path.GetFullPath(folder), safeName);
        try
        {
            await using var fs = File.Create(target);
            await content.CopyToAsync(fs);
            return target;
        }
        catch { return null; }
    }

    /// <summary>A path in <paramref name="dir"/> for <paramref name="name"/> that doesn't collide with
    /// an existing entry — appends " (1)", " (2)", … before the extension as needed.</summary>
    private static string UniquePath(string dir, string name)
    {
        var target = Path.Combine(dir, name);
        if (!File.Exists(target) && !Directory.Exists(target)) return target;

        var stem = Path.GetFileNameWithoutExtension(name);
        var ext = Path.GetExtension(name);
        for (var i = 1; ; i++)
        {
            target = Path.Combine(dir, $"{stem} ({i}){ext}");
            if (!File.Exists(target) && !Directory.Exists(target)) return target;
        }
    }

    private static IReadOnlyList<DirEntry> DriveRoots()
    {
        if (!System.Runtime.InteropServices.RuntimeInformation.IsOSPlatform(
                System.Runtime.InteropServices.OSPlatform.Windows))
            return new[] { new DirEntry("/", "/") };

        var list = new List<DirEntry>();
        foreach (var drive in DriveInfo.GetDrives())
        {
            try
            {
                if (drive.IsReady && (drive.DriveType is DriveType.Fixed or DriveType.Removable or DriveType.Network))
                    list.Add(new DirEntry(drive.Name, drive.RootDirectory.FullName));
            }
            catch { }
        }
        return list;
    }

    private static bool IsHidden(string p)
    {
        try
        {
            var a = File.GetAttributes(p);
            return a.HasFlag(FileAttributes.Hidden) || a.HasFlag(FileAttributes.System);
        }
        catch { return false; }
    }
}
