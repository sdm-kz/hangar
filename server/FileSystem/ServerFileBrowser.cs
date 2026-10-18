namespace Hangar.Server.FileSystem;

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
/// Where a typed path leads (see <see cref="ServerFileBrowser.Resolve"/>): the folder to open, and the
/// file it named, if it named one. <paramref name="Error"/> says why there is nowhere to go.
/// </summary>
public sealed record FsResolved(bool Found, string? Dir, string? File, string? Path = null, string? Error = null)
{
    public static FsResolved NotFound(string? path, string error) => new(false, null, null, path, error);
}

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

    /// <summary>
    /// Turn a path someone typed or pasted into the folder the Files tree should open. Lenient about
    /// how it was written — either slash on any platform, surrounding quotes from a copied path, a
    /// leading <c>~</c> for the home folder, a path relative to <paramref name="baseDir"/> — and
    /// strict about what comes back: the real on-disk spelling of every segment, because the tree
    /// keys its rows by exact path and <c>c:/git</c> would otherwise open beside <c>C:\Git</c> rather
    /// than onto it. A file resolves to the folder holding it, with the file named alongside.
    /// </summary>
    public static FsResolved Resolve(string? input, string? baseDir, string? defaultFolder)
    {
        var raw = (input ?? "").Trim();
        // A path copied from Explorer ("Copy as path") or a shell arrives quoted.
        if (raw.Length >= 2 && (raw[0] == '"' && raw[^1] == '"' || raw[0] == '\'' && raw[^1] == '\''))
            raw = raw[1..^1].Trim();
        if (raw.Length == 0) return FsResolved.NotFound(null, "Type a path.");

        // Both separators mean "separator" here. On Windows both already are; elsewhere a backslash is
        // a legal filename character, but nobody types one into an address bar meaning that.
        var sep = Path.DirectorySeparatorChar;
        raw = raw.Replace('/', sep).Replace('\\', sep);

        if (raw == "~" || raw.StartsWith("~" + sep))
            raw = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + raw[1..];

        string full;
        try
        {
            if (!Path.IsPathRooted(raw))
            {
                var root = !string.IsNullOrWhiteSpace(baseDir) && Directory.Exists(baseDir) ? baseDir!
                    : !string.IsNullOrWhiteSpace(defaultFolder) && Directory.Exists(defaultFolder) ? defaultFolder!
                    : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                raw = Path.Combine(root, raw);
            }
            // "C:" alone, or "C:foo", is relative to the server's current directory on C: as far as
            // GetFullPath is concerned -- never what someone typing it meant.
            if (raw.Length >= 2 && raw[1] == ':' && (raw.Length == 2 || raw[2] != sep))
                raw = raw[..2] + sep + raw[2..];
            full = Path.GetFullPath(raw);
        }
        catch (Exception ex) when (ex is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return FsResolved.NotFound(null, "That isn't a valid path.");
        }

        var isDir = Directory.Exists(full);
        if (!isDir && !File.Exists(full)) return FsResolved.NotFound(full, "Nothing at that path.");
        var real = TrueCase(full);

        // The tree starts at its drive roots and lists neither hidden nor system entries, so a path
        // outside those can exist and still never be shown -- refused here, rather than sending the
        // tree after rows that will not appear (a network share, a CD drive, ~/.config, a .git folder).
        var drive = DriveRoots().FirstOrDefault(d => real.StartsWith(d.Path, StringComparison.OrdinalIgnoreCase));
        if (drive is null) return FsResolved.NotFound(real, "That drive isn't in the Files tree.");
        var dir = isDir ? real : Path.GetDirectoryName(real);
        if (dir is null) return FsResolved.NotFound(real, "No folder holds that file.");
        if (HiddenBelow(drive.Path, dir))
            return FsResolved.NotFound(real, "That's inside a hidden folder, which the Files tree doesn't list.");
        // A hidden file still has a visible folder to land in; there is just no row of its to point at.
        var file = isDir || IsHidden(real) ? null : real;
        return new FsResolved(true, dir, file);
    }

    /// <summary>Whether any folder between <paramref name="root"/> (exclusive) and <paramref name="dir"/> is hidden.</summary>
    private static bool HiddenBelow(string root, string dir)
    {
        // The root itself is skipped: a Windows drive root reports Hidden|System, and is listed anyway.
        var cur = dir;
        while (cur.Length > root.Length)
        {
            if (IsHidden(cur)) return true;
            cur = Path.GetDirectoryName(cur) ?? root;
        }
        return false;
    }

    /// <summary>
    /// An existing path as the filesystem spells it, so a case-insensitive match comes back in the
    /// case on disk. The drive root takes the form the tree's own roots use (<c>C:\</c>), and a trailing
    /// separator is dropped from everything below it.
    /// </summary>
    private static string TrueCase(string full)
    {
        var root = Path.GetPathRoot(full);
        if (string.IsNullOrEmpty(root)) return full;
        // Drive letters are listed upper-case (DriveInfo), so a typed "c:" has to become "C:".
        var cur = root.Length >= 2 && root[1] == ':' ? char.ToUpperInvariant(root[0]) + root[1..] : root;
        var rest = full[root.Length..].Split(
            new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
        // Only Windows needs the lookup: there a name matches whatever its case. Elsewhere the path
        // exists exactly as typed, so as typed is how it is spelled.
        var lookup = OperatingSystem.IsWindows()
            ? new EnumerationOptions { MatchType = MatchType.Simple, MatchCasing = MatchCasing.CaseInsensitive, AttributesToSkip = 0, IgnoreInaccessible = true }
            : null;
        foreach (var seg in rest)
        {
            var name = seg;
            if (lookup is not null)
            {
                try
                {
                    // The segment as the pattern, matched literally (Simple): only the entry it names is
                    // turned into an object, not every sibling -- which matters in node_modules.
                    var hit = new DirectoryInfo(cur).EnumerateFileSystemInfos(seg, lookup).FirstOrDefault();
                    if (hit is not null) name = hit.Name;
                }
                catch { /* unreadable parent: keep the segment as typed */ }
            }
            cur = Path.Combine(cur, name);
        }
        return cur;
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

    /// <summary>Delete a file or directory (recursively) by absolute path. Returns false on failure.</summary>
    public static bool Delete(string path)
    {
        if (string.IsNullOrWhiteSpace(path)) return false;
        try
        {
            var full = Path.GetFullPath(path);
            if (Directory.Exists(full)) { Directory.Delete(full, recursive: true); return true; }
            if (File.Exists(full)) { File.Delete(full); return true; }
            return false;
        }
        catch { return false; }
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
