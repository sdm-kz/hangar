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
