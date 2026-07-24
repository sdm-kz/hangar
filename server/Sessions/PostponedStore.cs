using System.Collections.Concurrent;
using System.Text.Json;
using ClaudeWeb.Server.FileSystem;

namespace ClaudeWeb.Server.Sessions;

/// <summary>
/// Counts the "postponed messages" a session has stashed (in <c>.claudeweb/postponed/&lt;id&gt;.json</c>
/// under its working directory), for the badge shown next to the session in the list. The pool is
/// keyed per session, so sessions sharing a folder each keep their own. The hub asks for this once
/// per session on every ~1s tick, so the result is cached by the file's last-write time and size — a
/// tick only re-parses the JSON when the pool actually changed on disk.
/// </summary>
public static class PostponedStore
{
    /// <summary>Working-dir-relative path of a session's stashed-messages file (shared with the API endpoints).</summary>
    public static string RelPathFor(string sessionId) => $".claudeweb/postponed/{sessionId}.json";

    private sealed record Entry(long WriteTicks, long Length, int Count);

    private static readonly ConcurrentDictionary<string, Entry> _cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>How many messages are stashed for the given session (0 if none/unreadable).</summary>
    public static int Count(string workingDirectory, string sessionId)
    {
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, RelPathFor(sessionId));
        if (full is null) return 0;

        FileInfo fi;
        try
        {
            fi = new FileInfo(full);
            if (!fi.Exists)
            {
                _cache.TryRemove(full, out _);
                return 0;
            }
        }
        catch { return 0; }

        var ticks = fi.LastWriteTimeUtc.Ticks;
        var len = fi.Length;
        if (_cache.TryGetValue(full, out var cached) && cached.WriteTicks == ticks && cached.Length == len)
            return cached.Count;

        var count = ParseCount(full);
        _cache[full] = new Entry(ticks, len, count);
        return count;
    }

    private static int ParseCount(string full)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(full));
            return doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.GetArrayLength() : 0;
        }
        catch { return 0; }
    }
}
