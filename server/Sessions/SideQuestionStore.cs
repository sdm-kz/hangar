using System.Text.Json;
using Hangar.Server.FileSystem;

namespace Hangar.Server.Sessions;

/// <summary>
/// The side questions (<c>/btw</c>) asked in a conversation and Claude's answers to them, in
/// <c>.hangar/btw/&lt;conversation&gt;.json</c> under the session's working directory, oldest first.
///
/// <para>Claude answers a <c>/btw</c> in an overlay on its screen and writes neither the question nor
/// the answer to the transcript, so the chat, which is drawn from the transcript, would never show it.
/// The chat reads the overlay off the terminal and keeps the exchange here, to show it in the
/// conversation on every device and after a reload. Keyed by Claude's conversation id, as
/// <see cref="ChatMarkStore"/> is and for its reason: a reopen resumes the same conversation.</para>
/// </summary>
public static class SideQuestionStore
{
    private static readonly object _gate = new();

    // Enough for any conversation's side questions; past it the oldest go.
    private const int MaxItems = 500;
    public const int MaxQuestionChars = 4 * 1024;
    public const int MaxAnswerChars = 256 * 1024;
    private const int MaxAfterChars = 200;

    private static string RelPathFor(string conversationId) => $"{SessionDataFolder.Name}/btw/{conversationId}.json";

    /// <summary>The conversation's side questions as stored, or null if there are none.</summary>
    public static string? ReadJson(string workingDirectory, string conversationId) =>
        SessionFileBrowser.ReadTextSafe(workingDirectory, RelPathFor(conversationId));

    /// <summary>
    /// Add one exchange: the question (null when it couldn't be read off the screen), the answer, and
    /// the chat item it was asked after (null: before anything). An exchange already kept, word for word,
    /// is not added again: every browser with the chat open sees the same overlay and reports it.
    /// Returns the list as now stored, or null if it couldn't be read or written.
    /// </summary>
    public static string? Append(string workingDirectory, string conversationId, string? question, string answer, string? after)
    {
        var rel = RelPathFor(conversationId);
        var full = SessionFileBrowser.ResolveSafe(workingDirectory, rel);
        if (full is null) return null;
        if (after is { Length: > MaxAfterChars }) after = null;
        lock (_gate)
        {
            // There but unreadable for a moment (another process has it open) is not empty: writing over it
            // would lose what is kept.
            string? json;
            try { json = File.Exists(full) ? File.ReadAllText(full) : null; }
            catch { return null; }
            List<JsonElement> items;
            try
            {
                if (string.IsNullOrWhiteSpace(json)) items = [];
                else
                {
                    using var doc = JsonDocument.Parse(json);
                    if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
                    items = doc.RootElement.EnumerateArray().Select(e => e.Clone()).ToList();
                }
            }
            catch { return null; }

            if (items.Any(e => Text(e, "question") == question && Text(e, "answer") == answer)) return json;

            items.Add(JsonSerializer.SerializeToElement(new
            {
                id = Guid.NewGuid().ToString(),
                question,
                answer,
                after,
                createdAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            }));
            if (items.Count > MaxItems) items.RemoveRange(0, items.Count - MaxItems);

            var bytes = JsonSerializer.SerializeToUtf8Bytes(items);
            var tmp = full + ".tmp";
            try
            {
                var dir = Path.GetDirectoryName(full)!;
                Directory.CreateDirectory(dir);
                SessionDataFolder.Claim(dir);
                File.WriteAllBytes(tmp, bytes);
                File.Move(tmp, full, overwrite: true);
            }
            catch
            {
                try { File.Delete(tmp); } catch { /* best-effort */ }
                return null;
            }
            return System.Text.Encoding.UTF8.GetString(bytes);
        }
    }

    private static string? Text(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String
            ? v.GetString()
            : null;
}
