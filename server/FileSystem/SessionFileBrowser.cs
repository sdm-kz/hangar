namespace ClaudeWeb.Server.FileSystem;

public sealed record FileEntry(string Name, string Path, bool IsDir, long Size);

public sealed record FileListing(string Path, IReadOnlyList<FileEntry> Entries);

/// <summary>
/// Read-only browsing of files under a session's working directory. All access is confined
/// to the working directory (path-traversal is rejected) since paths come from the browser.
/// </summary>
public static class SessionFileBrowser
{
    /// <summary>Resolve a relative path against the root, or null if it escapes the root.</summary>
    public static string? ResolveSafe(string root, string? rel)
    {
        var fullRoot = Path.GetFullPath(root);
        var combined = string.IsNullOrWhiteSpace(rel)
            ? fullRoot
            : Path.GetFullPath(Path.Combine(fullRoot, rel.Replace('/', Path.DirectorySeparatorChar)));

        var rootWithSep = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;

        return combined.Equals(fullRoot, StringComparison.OrdinalIgnoreCase)
               || combined.StartsWith(rootWithSep, StringComparison.OrdinalIgnoreCase)
            ? combined
            : null;
    }

    public static FileListing? List(string root, string? rel)
    {
        var full = ResolveSafe(root, rel);
        if (full is null || !Directory.Exists(full)) return null;

        var entries = new List<FileEntry>();
        try
        {
            foreach (var d in Directory.EnumerateDirectories(full))
            {
                if (IsHidden(d)) continue;
                entries.Add(new FileEntry(Path.GetFileName(d), RelOf(root, d), true, 0));
            }
            foreach (var f in Directory.EnumerateFiles(full))
            {
                if (IsHidden(f)) continue;
                long size = 0;
                try { size = new FileInfo(f).Length; } catch { }
                entries.Add(new FileEntry(Path.GetFileName(f), RelOf(root, f), false, size));
            }
        }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }

        entries.Sort((a, b) =>
            a.IsDir != b.IsDir ? (a.IsDir ? -1 : 1)
                               : string.Compare(a.Name, b.Name, StringComparison.OrdinalIgnoreCase));

        return new FileListing((rel ?? "").Replace('\\', '/'), entries);
    }

    /// <summary>Read a text file within the root, or null if the path escapes the root, doesn't exist,
    /// or can't be read.</summary>
    public static string? ReadTextSafe(string root, string rel)
    {
        var full = ResolveSafe(root, rel);
        if (full is null || !File.Exists(full)) return null;
        try { return File.ReadAllText(full); } catch { return null; }
    }

    /// <summary>Overwrite a text file within the root. Returns false if the path escapes the root
    /// or its parent directory does not exist.</summary>
    public static bool Write(string root, string rel, string content)
    {
        var full = ResolveSafe(root, rel);
        if (full is null) return false;
        var dir = Path.GetDirectoryName(full);
        if (dir is null || !Directory.Exists(dir)) return false;
        File.WriteAllText(full, content);
        return true;
    }

    /// <summary>Write bytes to a file within the root, creating parent directories as needed.
    /// Returns the full path written, or null if the path escapes the root.</summary>
    public static string? WriteBytes(string root, string rel, byte[] bytes)
    {
        var full = ResolveSafe(root, rel);
        if (full is null) return null;
        var dir = Path.GetDirectoryName(full);
        if (dir is null) return null;
        Directory.CreateDirectory(dir); // e.g. .claudeweb/uploads/ may not exist yet
        File.WriteAllBytes(full, bytes);
        return full;
    }

    /// <summary>Create a directory (and any missing parents) at <paramref name="rel"/> under the
    /// root. <paramref name="rel"/> may be several segments deep (e.g. "a/b/c"). Returns the created
    /// path relative to the root, or null if it's empty, resolves to the root itself, or escapes it.</summary>
    public static string? CreateDir(string root, string rel)
    {
        if (string.IsNullOrWhiteSpace(rel)) return null;
        var full = ResolveSafe(root, rel);
        if (full is null) return null;
        if (full.Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) return null; // no-op
        Directory.CreateDirectory(full);
        return RelOf(root, full);
    }

    /// <summary>Rename a file or directory in place (same parent). <paramref name="newName"/> is a bare
    /// name — separators and invalid filename chars are rejected. Returns false if the source escapes the
    /// root/is missing, the name is invalid, or the target already exists.</summary>
    public static bool Rename(string root, string rel, string newName)
    {
        var full = ResolveSafe(root, rel);
        if (full is null || full.Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) return false;
        var clean = newName.Trim();
        if (clean.Length == 0 || clean.Contains('/') || clean.Contains('\\')
            || clean.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;

        var parent = Path.GetDirectoryName(full);
        if (parent is null) return false;
        var target = Path.Combine(parent, clean);
        if (File.Exists(target) || Directory.Exists(target)) return false;
        try
        {
            if (Directory.Exists(full)) Directory.Move(full, target);
            else if (File.Exists(full)) File.Move(full, target);
            else return false;
            return true;
        }
        catch { return false; }
    }

    /// <summary>Delete a file or directory (recursively) within the root. Refuses to delete the root
    /// itself or a path that escapes it. Returns false on any failure.</summary>
    public static bool Delete(string root, string rel)
    {
        var full = ResolveSafe(root, rel);
        if (full is null || full.Equals(Path.GetFullPath(root), StringComparison.OrdinalIgnoreCase)) return false;
        try
        {
            if (Directory.Exists(full)) Directory.Delete(full, recursive: true);
            else if (File.Exists(full)) File.Delete(full);
            else return false;
            return true;
        }
        catch { return false; }
    }

    /// <summary>Save an uploaded file's stream into <paramref name="relFolder"/> under the root,
    /// using a clobber-free name derived from <paramref name="fileName"/> (any directory parts are
    /// stripped). Returns the written path relative to the root, or null if the folder escapes the
    /// root or does not exist.</summary>
    public static async Task<string?> SaveUpload(string root, string? relFolder, string fileName, Stream content)
    {
        var folderFull = ResolveSafe(root, relFolder);
        if (folderFull is null || !Directory.Exists(folderFull)) return null;

        var safeName = Path.GetFileName(fileName); // discard any path components in the client name
        if (string.IsNullOrWhiteSpace(safeName)) return null;

        var target = UniquePath(folderFull, safeName);
        await using var fs = File.Create(target);
        await content.CopyToAsync(fs);
        return RelOf(root, target);
    }

    /// <summary>A path in <paramref name="dir"/> for <paramref name="name"/> that doesn't collide
    /// with an existing file/dir — appends " (1)", " (2)", … before the extension as needed.</summary>
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

    private static readonly HashSet<string> SearchSkipDirs = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", "node_modules", "bin", "obj", ".vs", ".idea", "dist", "out", ".next", "target",
    };

    /// <summary>Recursively find files whose name matches <paramref name="query"/> (case-insensitive),
    /// skipping heavy/hidden directories, capped at <paramref name="max"/> results.</summary>
    public static IReadOnlyList<FileEntry> Search(string root, string query, int max = 200)
    {
        var results = new List<FileEntry>();
        if (string.IsNullOrWhiteSpace(query)) return results;
        var q = query.Trim();
        var fullRoot = Path.GetFullPath(root);
        if (!Directory.Exists(fullRoot)) return results;

        var stack = new Stack<string>();
        stack.Push(fullRoot);
        while (stack.Count > 0 && results.Count < max)
        {
            var dir = stack.Pop();
            string[] files, subs;
            try { files = Directory.GetFiles(dir); subs = Directory.GetDirectories(dir); }
            catch { continue; }

            foreach (var f in files)
            {
                if (results.Count >= max) break;
                if (IsHidden(f)) continue;
                var name = Path.GetFileName(f);
                if (name.Contains(q, StringComparison.OrdinalIgnoreCase))
                {
                    long size = 0;
                    try { size = new FileInfo(f).Length; } catch { }
                    results.Add(new FileEntry(name, RelOf(root, f), false, size));
                }
            }
            foreach (var d in subs)
            {
                var name = Path.GetFileName(d);
                if (SearchSkipDirs.Contains(name) || IsHidden(d)) continue;
                stack.Push(d);
            }
        }
        results.Sort((a, b) => string.Compare(a.Path, b.Path, StringComparison.OrdinalIgnoreCase));
        return results;
    }

    public static string ContentType(string path)
    {
        return Path.GetExtension(path).ToLowerInvariant() switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".gif" => "image/gif",
            ".webp" => "image/webp",
            ".svg" => "image/svg+xml",
            ".bmp" => "image/bmp",
            ".ico" => "image/x-icon",
            ".avif" => "image/avif",
            ".mp4" or ".m4v" => "video/mp4",
            ".webm" => "video/webm",
            ".ogv" => "video/ogg",
            ".mov" => "video/quicktime",
            ".pdf" => "application/pdf",
            _ => "application/octet-stream",
        };
    }

    private static string RelOf(string root, string full) =>
        Path.GetRelativePath(Path.GetFullPath(root), full).Replace('\\', '/');

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
