using System.Collections.Concurrent;
using System.Text.Json;
using Hangar.Server.FileSystem;

namespace Hangar.Server.Sessions;

/// <summary>
/// The bookmarks, notes and to-dos the user has put on a conversation in the chat view, in
/// <c>.hangar/marks/&lt;conversation&gt;.json</c> under the session's working directory. The file is the
/// browser's own (a bare array it rewrites whole, as the postponed pool is): the server only keeps it.
///
/// <para>Keyed by <b>Claude's conversation id</b>, not by our session id, for the reason
/// <see cref="ConversationFlagStore"/> gives: a reopen mints a new session id, and the marks are on the
/// conversation, which a resume carries on — the same transcript, its messages under the same uuids the
/// marks point at. Nothing here is ever sent to Claude.</para>
/// </summary>
public static class ChatMarkStore
{
    private static readonly object _gate = new();

    private static string RelPathFor(string conversationId) => $"{SessionDataFolder.Name}/marks/{conversationId}.json";

    /// <summary>The conversation's marks as stored, or null if there are none.</summary>
    public static string? ReadJson(string workingDirectory, string conversationId) =>
        SessionFileBrowser.ReadTextSafe(workingDirectory, RelPathFor(conversationId));

    /// <summary>Replace the conversation's marks. Written to a temp file and moved over, so a reader never sees half of it.</summary>
    public static bool Write(string workingDirectory, string conversationId, byte[] bytes)
    {
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, RelPathFor(conversationId));
        if (full is null) return false;
        var tmp = full + ".tmp";
        lock (_gate)
        {
            try
            {
                var dir = Path.GetDirectoryName(full)!;
                Directory.CreateDirectory(dir);
                SessionDataFolder.Claim(dir);
                File.WriteAllBytes(tmp, bytes);
                File.Move(tmp, full, overwrite: true);
                return true;
            }
            catch
            {
                try { File.Delete(tmp); } catch { /* best-effort */ }
                return false;
            }
        }
    }

    private sealed record Entry(long WriteTicks, long Length, int Count);

    private static readonly ConcurrentDictionary<string, Entry> _cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// How many of the conversation's to-dos are not done yet (0 if none, or no conversation), for the
    /// counter on the session's row. Asked for every session on every ~1s tick of the hub, so cached
    /// by the file's last-write time and size, as <see cref="PostponedStore.Count"/> is.
    /// </summary>
    public static int OpenTodos(string workingDirectory, string? conversationId)
    {
        if (!ClaudeProjectData.IsConversationId(conversationId)) return 0;
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, RelPathFor(conversationId!));
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

        var count = ParseOpenTodos(full);
        _cache[full] = new Entry(ticks, len, count);
        return count;
    }

    private static int ParseOpenTodos(string full)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllText(full));
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return 0;
            var n = 0;
            foreach (var mark in doc.RootElement.EnumerateArray())
                if (mark.ValueKind == JsonValueKind.Object
                    && mark.TryGetProperty("todo", out var todo) && todo.ValueKind == JsonValueKind.Object
                    && !(todo.TryGetProperty("done", out var done) && done.ValueKind == JsonValueKind.True))
                    n++;
            return n;
        }
        catch { return 0; }
    }
}
