using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Hangar.Server.Sessions;

/// <summary>
/// One part of a transcript entry, cut down to what a chat view draws. <see cref="Type"/> is <c>text</c>,
/// <c>thinking</c>, <c>tool_use</c>, <c>tool_result</c> or <c>image</c>; the rest is filled as that type has it.
/// </summary>
public sealed record ChatBlock(
    string Type,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Text = null,
    /// <summary>The tool call's id — on a <c>tool_use</c>, and on the <c>tool_result</c> that answers it.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Id = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Name = null,
    /// <summary>A <c>tool_use</c>'s input as JSON text, cut to <see cref="ChatTranscript.MaxToolText"/>.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Input = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool IsError = false,
    /// <summary>
    /// An <c>image</c>'s place among its line's images, which is how <see cref="ChatTranscript.ReadImage"/> finds
    /// it: the image itself is not passed on.
    /// </summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] int? N = null,
    /// <summary>The places (as <see cref="N"/>) of the images a <c>tool_result</c> came with — a Read of a picture.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] IReadOnlyList<int>? Images = null);

/// <summary>
/// One line of a Claude transcript that has a place in the conversation. <see cref="Kind"/> is <c>user</c>,
/// <c>assistant</c>, <c>system</c>, <c>other</c> — an entry with nothing to draw (an attachment, a hook
/// summary) that is still a link in the <see cref="Parent"/> chain the view walks to find the live branch —
/// or <c>queue</c>: a change to the messages waiting for Claude to finish its turn, <see cref="Subtype"/>
/// saying which (<c>enqueue</c>, <c>dequeue</c>, <c>remove</c>, <c>popAll</c>). A queue line is in no chain.
/// </summary>
public sealed record ChatEntry(
    string Uuid,
    string? Parent,
    string Kind,
    string? Time,
    /// <summary>The API message an assistant line belongs to: one reply is written as a line per block.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? MessageId = null,
    /// <summary>Claude's own bookkeeping (an image's path note, a skill's expansion), not something anyone typed.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Meta = false,
    /// <summary>The summary a compaction leaves as the first message of what follows it.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool CompactSummary = false,
    /// <summary>A system line's subtype (<c>compact_boundary</c>, <c>api_error</c>, …).</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Subtype = null,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] IReadOnlyList<ChatBlock>? Blocks = null,
    /// <summary>The model an assistant line came from (<c>claude-opus-5-5</c>).</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] string? Model = null,
    /// <summary>Tokens in the context when an assistant line was written: its request's whole input.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] long Context = 0,
    /// <summary>A message typed while Claude was working, which it read before the turn was over.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Queued = false,
    /// <summary>Where the line starts in the file, on a line with images: with its uuid, what fetches one of them.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? At = null);

/// <summary>
/// A read of a transcript from <see cref="Offset"/> on. <see cref="Reset"/> says the reader's earlier entries
/// are no longer the file's — a different conversation, or the file was rewritten — so they are dropped
/// rather than added to; <see cref="Truncated"/> that a long transcript was read from near its end.
/// </summary>
public sealed record ChatChunk(
    string? Conversation,
    long Offset,
    bool Reset,
    bool Truncated,
    IReadOnlyList<ChatEntry> Entries,
    /// <summary>The session's model and context use, from its status line, when it has reported them.</summary>
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] SessionStatus? Status = null);

/// <summary>
/// Reads Claude Code's transcript (<c>~/.claude/projects/&lt;folder&gt;/&lt;id&gt;.jsonl</c>) for the chat view of
/// a terminal session. The terminal stays the session: this only reads what Claude writes down as it goes,
/// a line per message part, appended as each one finishes.
/// </summary>
/// <remarks>
/// The format is Claude Code's own and undocumented, so everything here reads it loosely — a line it can't
/// make sense of is skipped rather than failing the read. Reads are incremental by byte offset, and only up
/// to the last full line: Claude may be halfway through writing the next one.
/// </remarks>
public static class ChatTranscript
{
    /// <summary>Longest tool input or output passed on. The chat shows a preview; the terminal has the rest.</summary>
    public const int MaxToolText = 4000;

    /// <summary>
    /// Longest AskUserQuestion or ExitPlanMode input passed on — whole in practice (four questions of four
    /// options, or a plan of a few pages).
    /// </summary>
    private const int MaxQuestionText = 64 * 1024;

    /// <summary>
    /// How much of a transcript a first read takes. A conversation that has run for days is tens of megabytes,
    /// nearly all of it tool output; the end of it is what someone opening the chat wants.
    /// </summary>
    private const long FirstReadLimit = 6 * 1024 * 1024;

    /// <summary>Most bytes one read takes after the first, so a burst can't make one answer huge.</summary>
    private const long ReadLimit = 4 * 1024 * 1024;

    /// <summary>
    /// Read <paramref name="path"/> (the transcript of <paramref name="conversation"/>) from <paramref name="offset"/>.
    /// The reader passes back what it last got, conversation and offset both; anything that no longer lines up
    /// starts it again from the top.
    /// </summary>
    public static ChatChunk Read(string path, string conversation, string? knownConversation, long offset)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var length = file.Length;
        var reset = knownConversation != conversation || offset < 0 || offset > length;
        if (reset) offset = 0;

        var truncated = false;
        if (offset == 0 && length > FirstReadLimit)
        {
            offset = length - FirstReadLimit;
            truncated = true;
        }

        var take = (int)Math.Min(length - offset, offset == 0 || truncated ? FirstReadLimit : ReadLimit);
        var buffer = new byte[take];
        file.Seek(offset, SeekOrigin.Begin);
        var read = 0;
        while (read < take)
        {
            var n = file.Read(buffer, read, take - read);
            if (n == 0) break;
            read += n;
        }

        if (read == 0) return new ChatChunk(conversation, offset, reset, truncated, []);

        // A read from the middle of the file starts mid-line: skip to the first whole one.
        var start = 0;
        if (truncated)
        {
            var nl = Array.IndexOf(buffer, (byte)'\n', 0, read);
            start = nl < 0 ? read : nl + 1;
        }
        // And it ends at the last newline: whatever follows is a line still being written.
        var end = Array.LastIndexOf(buffer, (byte)'\n', read - 1);
        if (end < start)
        {
            // No whole line in the window. At the end of the file that is a line still being written: wait
            // for it. Otherwise it is one line longer than the window (a pasted image is stored inline, and
            // can be megabytes) — skip it, or every read would stop at it again and the chat never move on.
            if (offset + read >= length) return new ChatChunk(conversation, offset + start, reset, truncated, []);
            var next = PastNextNewline(file, offset + read);
            return new ChatChunk(conversation, next < 0 ? offset + start : next, reset, truncated, []);
        }

        var entries = new List<ChatEntry>();
        var lineStart = start;
        for (var i = start; i <= end; i++)
        {
            if (buffer[i] != '\n') continue;
            if (i > lineStart && Parse(buffer.AsSpan(lineStart, i - lineStart), offset + lineStart) is { } entry)
                entries.Add(entry);
            lineStart = i + 1;
        }
        return new ChatChunk(conversation, offset + end + 1, reset, truncated, entries);
    }

    /// <summary>The position just after the first newline at or after <paramref name="from"/>, or -1 if the file ends first.</summary>
    private static long PastNextNewline(FileStream file, long from)
    {
        var chunk = new byte[64 * 1024];
        file.Seek(from, SeekOrigin.Begin);
        for (var at = from; ; )
        {
            var n = file.Read(chunk, 0, chunk.Length);
            if (n == 0) return -1;
            var nl = Array.IndexOf(chunk, (byte)'\n', 0, n);
            if (nl >= 0) return at + nl + 1;
            at += n;
        }
    }

    /// <param name="at">Where the line starts in the file: a queue line has no id of its own, so this is it.</param>
    private static ChatEntry? Parse(ReadOnlySpan<byte> line, long at)
    {
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line.ToArray()); }
        catch (JsonException) { return null; }
        using (doc)
        {
            var d = doc.RootElement;
            if (d.ValueKind != JsonValueKind.Object) return null;
            // A message typed while Claude works waits in a queue, and the queue's changes are written down
            // as they happen: what was added, and when it was taken (as the next prompt, or mid-turn) or
            // pulled back to be edited.
            if (Str(d, "type") == "queue-operation")
            {
                var content = Str(d, "content");
                return new ChatEntry($"queue:{at}", null, "queue", Str(d, "timestamp"), Subtype: Str(d, "operation"),
                    Blocks: content is null ? null : [new ChatBlock("text", Text: Cut(content, MaxToolText))]);
            }
            var uuid = Str(d, "uuid");
            if (uuid is null) return null;
            // Subagent runs are kept in files of their own now; one that turns up here is still not part of
            // the conversation on screen.
            if (Bool(d, "isSidechain")) return null;
            // A compaction starts a new chain (parentUuid null) and keeps the old one as its logical parent.
            var parent = Str(d, "parentUuid") ?? Str(d, "logicalParentUuid");
            var time = Str(d, "timestamp");
            var type = Str(d, "type");
            switch (type)
            {
                case "user":
                case "assistant":
                {
                    if (!d.TryGetProperty("message", out var msg) || msg.ValueKind != JsonValueKind.Object)
                        return new ChatEntry(uuid, parent, "other", time);
                    var images = 0;
                    var blocks = Blocks(msg, ref images);
                    var assistant = type == "assistant";
                    if (assistant) WithPlans(blocks, Str(d, "slug"));
                    return new ChatEntry(uuid, parent, type, time,
                        MessageId: assistant ? Str(msg, "id") : null,
                        Meta: Bool(d, "isMeta"),
                        CompactSummary: Bool(d, "isCompactSummary"),
                        Blocks: blocks,
                        Model: assistant ? Str(msg, "model") : null,
                        Context: assistant ? ContextTokens(msg) : 0,
                        At: images > 0 ? at : null);
                }
                case "system":
                {
                    var subtype = Str(d, "subtype");
                    var text = Str(d, "content");
                    return new ChatEntry(uuid, parent, "system", time, Subtype: subtype,
                        Blocks: text is null ? null : [new ChatBlock("text", Text: Cut(text, MaxToolText))]);
                }
                case "attachment"
                    when d.TryGetProperty("attachment", out var att) && Str(att, "type") == "queued_command"
                        && att.TryGetProperty("origin", out var origin) && Str(origin, "kind") == "human"
                        && att.TryGetProperty("prompt", out var prompt) && QueuedPrompt(prompt) is ({ Count: > 0 } said, var pics):
                    // A message sent while Claude was working that it read between two steps of the turn,
                    // rather than after it. Not a user line, so it would be lost with the attachments. Its
                    // prompt is a message's content: text, or text and the images pasted with it.
                    return new ChatEntry(uuid, parent, "user", Str(att, "timestamp") ?? time, Queued: true, Blocks: said,
                        At: pics > 0 ? at : null);
                default:
                    return new ChatEntry(uuid, parent, "other", time);
            }
        }
    }

    /// <summary>
    /// Fill in the plan of an ExitPlanMode call that came without one. Claude often calls it with no
    /// arguments: the plan is the file it wrote, <c>plans/&lt;slug&gt;.md</c> under its config folder, named after
    /// the session's slug, and the copy Claude Code adds to the call is written down only some of the time.
    /// The file holds the latest plan, so a call read again later shows that rather than the one it made.
    /// </summary>
    private static void WithPlans(List<ChatBlock> blocks, string? slug)
    {
        for (var i = 0; i < blocks.Count; i++)
        {
            var b = blocks[i];
            if (b is not { Type: "tool_use", Name: "ExitPlanMode" } || HasPlan(b.Input)) continue;
            if (PlanFile(slug) is not { } plan) return;
            blocks[i] = b with { Input = JsonSerializer.Serialize(new { plan }) };
        }
    }

    private static bool HasPlan(string? input)
    {
        if (input is null) return false;
        try
        {
            using var doc = JsonDocument.Parse(input);
            return Str(doc.RootElement, "plan") is { Length: > 0 };
        }
        catch (JsonException) { return true; } // cut short: there was something, and a file won't make it whole
    }

    // A slug is a few lowercase words joined by dashes; anything else is not looked for on disk.
    private static readonly Regex Slug = new("^[a-z0-9]+(-[a-z0-9]+)*$", RegexOptions.Compiled);

    private static string? PlanFile(string? slug)
    {
        if (slug is null || !Slug.IsMatch(slug)) return null;
        try
        {
            var file = new FileInfo(Path.Combine(ClaudeProjectData.ConfigDir(), "plans", slug + ".md"));
            return file.Exists && file.Length <= MaxQuestionText ? File.ReadAllText(file.FullName) : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private static List<ChatBlock> Blocks(JsonElement msg, ref int images) =>
        msg.TryGetProperty("content", out var content) ? ContentBlocks(content, ref images) : [];

    private static (List<ChatBlock>, int) QueuedPrompt(JsonElement prompt)
    {
        var images = 0;
        return (ContentBlocks(prompt, ref images), images);
    }

    /// <summary>
    /// A message's content — a string, or a list of parts — as blocks. <paramref name="images"/> counts the
    /// images met, in the order <see cref="ImageSources"/> walks them, so each image block can say which it is.
    /// </summary>
    private static List<ChatBlock> ContentBlocks(JsonElement content, ref int images)
    {
        var list = new List<ChatBlock>();
        if (content.ValueKind == JsonValueKind.String)
        {
            list.Add(new ChatBlock("text", Text: content.GetString()));
            return list;
        }
        if (content.ValueKind != JsonValueKind.Array) return list;
        foreach (var b in content.EnumerateArray())
        {
            switch (Str(b, "type"))
            {
                case "text":
                    if (Str(b, "text") is { Length: > 0 } text) list.Add(new ChatBlock("text", Text: text));
                    break;
                case "thinking":
                    // Thinking is often stored redacted — a signature and no text. Nothing to show then.
                    if (Str(b, "thinking") is { Length: > 0 } thought) list.Add(new ChatBlock("thinking", Text: thought));
                    break;
                case "tool_use":
                {
                    var name = Str(b, "name");
                    // A question's or a plan's input is the card the chat draws to answer it: cut, it couldn't be read.
                    var max = name is "AskUserQuestion" or "ExitPlanMode" ? MaxQuestionText : MaxToolText;
                    list.Add(new ChatBlock("tool_use", Id: Str(b, "id"), Name: name,
                        Input: b.TryGetProperty("input", out var input) ? Cut(input.GetRawText(), max) : null));
                    break;
                }
                case "tool_result":
                {
                    List<int>? pics = null;
                    if (b.TryGetProperty("content", out var parts) && parts.ValueKind == JsonValueKind.Array)
                        foreach (var part in parts.EnumerateArray())
                            if (Str(part, "type") == "image") (pics ??= []).Add(images++);
                    list.Add(new ChatBlock("tool_result", Id: Str(b, "tool_use_id"),
                        Text: Cut(ResultText(b), MaxToolText), IsError: Bool(b, "is_error"), Images: pics));
                    break;
                }
                case "image":
                    // Pasted images are stored inline as base64: far too much to ship with every read.
                    // The chat fetches each one on its own, by line and place (ReadImage).
                    list.Add(new ChatBlock("image", N: images++));
                    break;
            }
        }
        return list;
    }

    /// <summary>Longest line <see cref="ReadImage"/> reads: a message of a few pasted screenshots is a few megabytes.</summary>
    private const int MaxImageLine = 64 * 1024 * 1024;

    // The types an image is served as. Anything else — an SVG, which can carry a script — is not served.
    private static readonly HashSet<string> ImageTypes =
        new(StringComparer.OrdinalIgnoreCase) { "image/png", "image/jpeg", "image/gif", "image/webp" };

    // Reading an image parses its whole line, megabytes of JSON: a chat opening on a dozen of them reads
    // two at a time rather than all at once.
    private static readonly SemaphoreSlim ImageReads = new(2);

    private static readonly ImageCache ImageLines = new();

    /// <summary>
    /// The <paramref name="n"/>th image (as <see cref="ChatBlock.N"/> counts them) of the line at
    /// <paramref name="at"/> in <paramref name="path"/>, which must be the line of <paramref name="uuid"/> — a
    /// file rewritten since the chat read it has other lines there. Null when there is no such image, or it is
    /// not a type served here.
    /// </summary>
    public static async Task<(byte[] Data, string MediaType)?> ReadImage(string path, long at, string uuid, int n)
    {
        var key = $"{path}|{at}|{uuid}";
        if (ImageLines.TryGet(key, out var held)) return Pick(held, n);
        await ImageReads.WaitAsync();
        try
        {
            // Another request for the same line may have read it while this one waited.
            if (ImageLines.TryGet(key, out held)) return Pick(held, n);
            var line = ReadLine(path, at);
            if (line is null) return null;
            List<(byte[], string)?> all;
            try
            {
                using var doc = JsonDocument.Parse(line.GetBuffer().AsMemory(0, (int)line.Length));
                var d = doc.RootElement;
                if (d.ValueKind != JsonValueKind.Object || Str(d, "uuid") != uuid) return null;
                all = ImageSources(d).Select(Decode).ToList();
            }
            catch (JsonException) { return null; }
            ImageLines.Put(key, all);
            return Pick(all, n);
        }
        finally { ImageReads.Release(); }
    }

    private static (byte[], string)? Pick(List<(byte[], string)?> images, int n) =>
        n >= 0 && n < images.Count ? images[n] : null;

    /// <summary>The line starting at <paramref name="at"/>, or null if none does or it is longer than <see cref="MaxImageLine"/>.</summary>
    private static MemoryStream? ReadLine(string path, long at)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        if (at < 0 || at >= file.Length) return null;
        // The line must start there: the one before it ends just ahead of it.
        if (at > 0)
        {
            file.Seek(at - 1, SeekOrigin.Begin);
            if (file.ReadByte() != '\n') return null;
        }
        var buffer = new MemoryStream();
        var chunk = new byte[256 * 1024];
        while (true)
        {
            var n = file.Read(chunk, 0, chunk.Length);
            if (n == 0) return null; // no newline yet: a line still being written
            var nl = Array.IndexOf(chunk, (byte)'\n', 0, n);
            if (buffer.Length + (nl < 0 ? n : nl) > MaxImageLine) return null;
            buffer.Write(chunk, 0, nl < 0 ? n : nl);
            if (nl >= 0) return buffer;
        }
    }

    /// <summary>
    /// A line's image parts, in the order <see cref="ContentBlocks"/> numbers them: the message's content, or a
    /// queued message's prompt, taking a tool result's images where the result stands.
    /// </summary>
    private static IEnumerable<JsonElement> ImageSources(JsonElement d)
    {
        JsonElement content;
        if (d.TryGetProperty("message", out var msg) && msg.ValueKind == JsonValueKind.Object
            && msg.TryGetProperty("content", out var c)) content = c;
        else if (d.TryGetProperty("attachment", out var att) && att.ValueKind == JsonValueKind.Object
            && att.TryGetProperty("prompt", out var p)) content = p;
        else yield break;
        if (content.ValueKind != JsonValueKind.Array) yield break;
        foreach (var b in content.EnumerateArray())
        {
            var type = Str(b, "type");
            if (type == "image") yield return b;
            else if (type == "tool_result" && b.TryGetProperty("content", out var parts) && parts.ValueKind == JsonValueKind.Array)
                foreach (var part in parts.EnumerateArray())
                    if (Str(part, "type") == "image") yield return part;
        }
    }

    private static (byte[], string)? Decode(JsonElement image)
    {
        if (!image.TryGetProperty("source", out var src) || Str(src, "type") != "base64") return null;
        var media = Str(src, "media_type");
        if (media is null || !ImageTypes.Contains(media)) return null;
        return src.TryGetProperty("data", out var data) && data.ValueKind == JsonValueKind.String
            && data.TryGetBytesFromBase64(out var bytes) && bytes.Length > 0
            ? (bytes, media.ToLowerInvariant())
            : null;
    }

    /// <summary>
    /// The images of the lines read most recently, a line's all together (they are asked for together), up to
    /// a total size: what saves parsing a line again when its images are asked for one after another, or by a
    /// second browser. The browser keeps its own copy, so this need not be big.
    /// </summary>
    private sealed class ImageCache
    {
        private const long MaxBytes = 64 * 1024 * 1024;
        private readonly object _gate = new();
        private readonly LinkedList<(string Key, List<(byte[], string)?> Images, long Size)> _lru = new();
        private readonly Dictionary<string, LinkedListNode<(string Key, List<(byte[], string)?> Images, long Size)>> _byKey = new();
        private long _size;

        public bool TryGet(string key, out List<(byte[], string)?> images)
        {
            lock (_gate)
            {
                images = [];
                if (!_byKey.TryGetValue(key, out var node)) return false;
                _lru.Remove(node);
                _lru.AddFirst(node);
                images = node.Value.Images;
                return true;
            }
        }

        public void Put(string key, List<(byte[], string)?> images)
        {
            var size = images.Sum(i => (long)(i?.Item1.Length ?? 0));
            if (size > MaxBytes / 4) return; // one line would push out everything else
            lock (_gate)
            {
                if (_byKey.Remove(key, out var old))
                {
                    _lru.Remove(old);
                    _size -= old.Value.Size;
                }
                _byKey[key] = _lru.AddFirst((key, images, size));
                _size += size;
                while (_size > MaxBytes && _lru.Last is { } last)
                {
                    _lru.RemoveLast();
                    _byKey.Remove(last.Value.Key);
                    _size -= last.Value.Size;
                }
            }
        }
    }

    // Everything the request sent in: fresh input plus what was written to and read from the cache.
    private static long ContextTokens(JsonElement msg)
    {
        if (!msg.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return 0;
        long total = 0;
        foreach (var name in new[] { "input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens" })
            if (u.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n))
                total += n;
        return total;
    }

    // A tool result's content is a string, or a list of text and image parts.
    private static string? ResultText(JsonElement b)
    {
        if (!b.TryGetProperty("content", out var c)) return null;
        if (c.ValueKind == JsonValueKind.String) return c.GetString();
        if (c.ValueKind != JsonValueKind.Array) return null;
        var sb = new StringBuilder();
        foreach (var part in c.EnumerateArray())
        {
            var t = Str(part, "type");
            if (t == "text" && Str(part, "text") is { } text)
            {
                if (sb.Length > 0) sb.Append('\n');
                sb.Append(text);
            }
            else if (t == "image")
            {
                if (sb.Length > 0) sb.Append('\n');
                sb.Append("[image]");
            }
            if (sb.Length > MaxToolText) break;
        }
        return sb.ToString();
    }

    private static string? Cut(string? text, int max) =>
        text is null || text.Length <= max ? text : text[..max] + "\n…";

    private static string? Str(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;

    private static bool Bool(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
