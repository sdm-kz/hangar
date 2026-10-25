using System.Collections.Concurrent;
using System.Text.Json;
using Hangar.Server.FileSystem;

namespace Hangar.Server.Sessions;

/// <summary>
/// Counts the "postponed messages" a session has stashed (in <c>.hangar/postponed/&lt;id&gt;.json</c>
/// under its working directory), for the badge shown next to the session in the list. The pool is
/// keyed per session, so sessions sharing a folder each keep their own. The hub asks for this once
/// per session on every ~1s tick, so the result is cached by the file's last-write time and size — a
/// tick only re-parses the JSON when the pool actually changed on disk.
/// </summary>
public static class PostponedStore
{
    /// <summary>Working-dir-relative path of a session's stashed-messages file.</summary>
    private static string RelPathFor(string sessionId) => $"{SessionDataFolder.Name}/postponed/{sessionId}.json";

    /// <summary>The session's pool as stored (what the GET endpoint answers), or null if there is none.</summary>
    public static string? ReadJson(string workingDirectory, string sessionId)
    {
        return SessionFileBrowser.ReadTextSafe(workingDirectory, RelPathFor(sessionId));
    }

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

    // ---- auto-send ------------------------------------------------------------------------------

    /// <summary>
    /// Working-dir-relative path of the marker that says a session's pool is on auto-send (see
    /// <see cref="PostponedAutoSender"/>). A file beside the pool rather than a field inside it: the
    /// pool is a bare array that every browser rewrites whole, and a flag in there would be lost to
    /// the first save from a tab that loaded it before the flag was set.
    /// </summary>
    private static string AutoRelPathFor(string sessionId) => $"{SessionDataFolder.Name}/postponed/{sessionId}.auto";

    /// <summary>The flag per marker path, read from disk once and then kept here — the hub asks every tick.</summary>
    private static readonly ConcurrentDictionary<string, bool> _auto = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// Serialises every write this process makes to a pool or its marker. The pool has two writers —
    /// a browser's PUT and auto-send taking a message out — and a read-edit-write from one must not
    /// straddle a write from the other, or a stash that landed in between is lost. One lock for all
    /// sessions: the writes are tiny and rare.
    /// </summary>
    private static readonly object _gate = new();

    /// <summary>
    /// Replace a session's pool with <paramref name="bytes"/> (what the PUT endpoint stores). Written to
    /// a temporary file and moved into place, so a reader never sees half of it. False if the path
    /// escapes the folder or the write failed.
    /// </summary>
    public static bool Write(string workingDirectory, string sessionId, byte[] bytes)
    {
        lock (_gate) return WriteAtomic(workingDirectory, RelPathFor(sessionId), bytes);
    }

    private static bool WriteAtomic(string workingDirectory, string rel, byte[] bytes)
    {
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, rel);
        if (full is null) return false;
        var tmp = full + ".tmp";
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

    /// <summary>Whether the session's pool is on auto-send. Off unless someone switched it on.</summary>
    public static bool IsAutoSend(string workingDirectory, string sessionId)
    {
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, AutoRelPathFor(sessionId));
        if (full is null) return false;
        return _auto.GetOrAdd(full, f =>
        {
            try { return File.Exists(f); }
            catch { return false; }
        });
    }

    /// <summary>
    /// Switch auto-send on or off. Returns whether the flag now says what was asked — false only when
    /// the marker could not be written or removed.
    /// </summary>
    public static bool SetAutoSend(string workingDirectory, string sessionId, bool on)
    {
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, AutoRelPathFor(sessionId));
        if (full is null) return false;
        lock (_gate)
        {
            try
            {
                if (on)
                {
                    var dir = Path.GetDirectoryName(full)!;
                    Directory.CreateDirectory(dir);
                    SessionDataFolder.Claim(dir);
                    File.WriteAllText(full, "");
                }
                else if (File.Exists(full))
                {
                    File.Delete(full);
                }
                _auto[full] = on;
                return true;
            }
            catch
            {
                _auto.TryRemove(full, out _); // unsure what is on disk now — read it afresh next time
                return false;
            }
        }
    }

    /// <summary>The most messages a pool holds — the cap the browser keeps it to as well.</summary>
    public const int MaxItems = 100;

    public enum AppendResult { Added, Full, Failed }

    /// <summary>
    /// Add one message at the end of the pool, in the shape the browser writes: a fresh id, the text,
    /// the images as <c>{ path, fullPath }</c> (working-dir-relative and absolute) and the time. Under
    /// the same lock as every other write, re-reading the file first, so it can't undo a browser's save
    /// or auto-send's take that landed a moment before — the race a client's own read-edit-write would
    /// lose. A full pool is refused rather than trimmed: what would go is someone's oldest note.
    /// </summary>
    public static AppendResult Append(string workingDirectory, string sessionId, string text,
        IReadOnlyList<(string Path, string FullPath)> images)
    {
        var rel = RelPathFor(sessionId);
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, rel);
        if (full is null) return AppendResult.Failed;
        lock (_gate)
        {
            // A pool that is there but can't be read (held open by another process for a moment) is
            // not an empty one: writing over it would lose every message in it.
            string? json;
            try { json = File.Exists(full) ? File.ReadAllText(full) : null; }
            catch { return AppendResult.Failed; }
            List<JsonElement> items;
            try
            {
                if (string.IsNullOrWhiteSpace(json)) items = [];
                else
                {
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.ValueKind != JsonValueKind.Array) return AppendResult.Failed;
                    items = doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
                }
            }
            catch { return AppendResult.Failed; }
            if (items.Count >= MaxItems) return AppendResult.Full;

            var item = new
            {
                id = Guid.NewGuid().ToString(),
                text,
                images = images.Select(i => new { path = i.Path, fullPath = i.FullPath }).ToArray(),
                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            };
            items.Add(JsonSerializer.SerializeToElement(item));
            return WriteAtomic(workingDirectory, rel, JsonSerializer.SerializeToUtf8Bytes(items))
                ? AppendResult.Added
                : AppendResult.Failed;
        }
    }

    /// <summary>One stashed message, as much of it as sending needs.</summary>
    public sealed record Item(string Id, string Text, IReadOnlyList<string> ImagePaths);

    /// <summary>
    /// The session's stashed messages, oldest first; entries it cannot make sense of are skipped. Null
    /// when the pool is there but could not be read — distinct from empty, because "empty" is what
    /// switches auto-send off, and a file caught mid-write by another process is not an empty pool.
    /// </summary>
    public static IReadOnlyList<Item>? Read(string workingDirectory, string sessionId)
    {
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, RelPathFor(sessionId));
        if (full is null) return null;
        string json;
        try
        {
            if (!File.Exists(full)) return [];
            json = File.ReadAllText(full);
        }
        catch { return null; }
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            var items = new List<Item>();
            foreach (var e in doc.RootElement.EnumerateArray())
            {
                if (e.ValueKind != JsonValueKind.Object) continue;
                if (!e.TryGetProperty("id", out var id) || id.ValueKind != JsonValueKind.String) continue;
                var text = e.TryGetProperty("text", out var t) && t.ValueKind == JsonValueKind.String
                    ? t.GetString() ?? "" : "";
                var images = new List<string>();
                if (e.TryGetProperty("images", out var imgs) && imgs.ValueKind == JsonValueKind.Array)
                    foreach (var img in imgs.EnumerateArray())
                        if (img.ValueKind == JsonValueKind.Object
                            && img.TryGetProperty("fullPath", out var fp) && fp.ValueKind == JsonValueKind.String
                            && !string.IsNullOrWhiteSpace(fp.GetString()))
                            images.Add(fp.GetString()!);
                items.Add(new Item(id.GetString()!, text, images));
            }
            return items;
        }
        catch { return null; }
    }

    /// <summary>
    /// Drop the given messages from the pool, leaving every other entry exactly as it was written.
    /// Re-reads the file rather than trusting an earlier <see cref="Read"/>, so a stash that landed in
    /// between survives. Returns false if the pool could not be rewritten.
    /// </summary>
    public static bool Remove(string workingDirectory, string sessionId, IReadOnlyCollection<string> ids)
    {
        lock (_gate) return RemoveLocked(workingDirectory, RelPathFor(sessionId), ids);
    }

    private static bool RemoveLocked(string workingDirectory, string rel, IReadOnlyCollection<string> ids)
    {
        var json = SessionFileBrowser.ReadTextSafe(workingDirectory, rel);
        if (string.IsNullOrWhiteSpace(json)) return true;
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return false;
            var kept = doc.RootElement.EnumerateArray()
                .Where(e => !(e.ValueKind == JsonValueKind.Object
                              && e.TryGetProperty("id", out var id) && id.ValueKind == JsonValueKind.String
                              && ids.Contains(id.GetString()!)))
                .ToList();
            if (kept.Count == doc.RootElement.GetArrayLength()) return true;
            return WriteAtomic(workingDirectory, rel, JsonSerializer.SerializeToUtf8Bytes(kept));
        }
        catch { return false; }
    }
}
