using System.Runtime.InteropServices;

namespace Hangar.Server.FileSystem;

public sealed record DirEntry(string Name, string Path);

public sealed record BrowseResult(
    string? Current,
    string? Parent,
    IReadOnlyList<DirEntry> Directories,
    IReadOnlyList<DirEntry> Drives,
    bool Exists = true,
    string? Existing = null);

/// <summary>
/// Read-only directory listing used by the folder-picker autocomplete in the UI.
/// Lists subdirectories of a given path (or drive roots when no path is supplied).
/// </summary>
public static class FileSystemBrowser
{
    public static BrowseResult Browse(string? path, string? defaultFolder = null)
    {
        var drives = GetDrives();

        if (string.IsNullOrWhiteSpace(path))
        {
            // Open at the configured default folder, falling back to the user profile.
            var start = !string.IsNullOrWhiteSpace(defaultFolder) && Directory.Exists(defaultFolder)
                ? defaultFolder!
                : Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Directory.Exists(start)
                ? Browse(start)
                : new BrowseResult(null, null, Array.Empty<DirEntry>(), drives);
        }

        var full = Path.GetFullPath(path.Trim());
        if (!Directory.Exists(full))
            // Exists = false with the deepest folder that is there, so the picker can show which part of
            // the typed path is new and offer to create it. Null when not even the drive is.
            return new BrowseResult(full, null, Array.Empty<DirEntry>(), drives, Exists: false, Existing: DeepestExisting(full));

        var dirs = new List<DirEntry>();
        try
        {
            foreach (var d in Directory.EnumerateDirectories(full))
            {
                var name = Path.GetFileName(d);
                if (string.IsNullOrEmpty(name)) continue;
                // Skip hidden/system entries to keep the list clean.
                try
                {
                    var attrs = File.GetAttributes(d);
                    if (attrs.HasFlag(FileAttributes.Hidden) || attrs.HasFlag(FileAttributes.System))
                        continue;
                }
                catch { /* unreadable ACLs etc. — just include it */ }
                dirs.Add(new DirEntry(name, d));
            }
        }
        catch (UnauthorizedAccessException) { /* return what we have */ }
        catch (IOException) { }

        dirs.Sort((a, b) => string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));

        var parent = Directory.GetParent(full)?.FullName;
        return new BrowseResult(full, parent, dirs, drives);
    }

    private static string? DeepestExisting(string full)
    {
        try
        {
            for (var d = new DirectoryInfo(full).Parent; d is not null; d = d.Parent)
                if (d.Exists) return d.FullName;
        }
        catch { /* unreadable or malformed: nothing to anchor on */ }
        return null;
    }

    private static IReadOnlyList<DirEntry> GetDrives()
    {
        if (!RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
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
}
