using System.IO.Compression;
using System.Text;
using System.Text.RegularExpressions;

namespace Hangar.Server.Sessions;

/// <summary>A memory file of a folder, as Claude keeps it (<c>memory/*.md</c>) — what a copy to another machine offers.</summary>
public sealed record ClaudeMemoryFile(
    string Name,
    string? Description,
    /// <summary>The file, or null when it is too large to carry (<see cref="ClaudeProjectData.MaxMemoryFile"/>).</summary>
    string? Content,
    long Size,
    DateTime ModifiedUtc,
    /// <summary>Its line in <c>MEMORY.md</c>, the index Claude reads first; null when the index doesn't list it.</summary>
    string? IndexLine);

/// <summary>A folder's memory: <see cref="Files"/> is empty when Claude has none for it.</summary>
public sealed record ClaudeMemoryListing(string Folder, IReadOnlyList<ClaudeMemoryFile> Files);

/// <summary>What a merge of memory into a folder did, file by file.</summary>
public sealed record ClaudeMemoryImport(
    IReadOnlyList<string> Copied,
    /// <summary>Already there with the same text: nothing to do.</summary>
    IReadOnlyList<string> Same,
    /// <summary>There with other text, and not named to be replaced: left as it was.</summary>
    IReadOnlyList<string> Kept,
    /// <summary>Not offered by the source (gone since it was listed, or too large to carry).</summary>
    IReadOnlyList<string> Missing);

/// <summary>
/// Claude Code's own data for a folder, kept outside it: <c>~/.claude/projects/&lt;folder, encoded&gt;/</c> holds
/// the folder's conversations (<c>&lt;id&gt;.jsonl</c>, with a <c>&lt;id&gt;/</c> beside each for its subagents and
/// saved tool output) and its memory (<c>memory/</c>: <c>MEMORY.md</c>, the index, and one file per memory).
/// </summary>
/// <remarks>
/// <para>
/// What carrying a conversation or a folder's memory to another machine reads and writes
/// (plans/multi-node.md, phase 6). A transcript resumes as it is under the target's folder — the paths in it
/// are history, and Claude takes its working directory from where it is started — so a copy is a copy:
/// nothing in it is rewritten.
/// </para>
/// <para>
/// The folder's name is its path with every character but a letter or digit turned into <c>-</c>
/// (<c>C:\Git\app</c> → <c>C--Git-app</c>, <c>/Users/me/app</c> → <c>-Users-me-app</c>). Claude cuts a name longer
/// than <see cref="MaxEncoded"/> short and adds a hash of its own; such a folder is found by that prefix
/// when it is already there, and refused rather than guessed when it isn't.
/// </para>
/// </remarks>
public static class ClaudeProjectData
{
    public const int MaxEncoded = 200;
    public const long MaxMemoryFile = 256 * 1024;
    private const int MaxMemoryFiles = 200;
    private const string Index = "MEMORY.md";

    private static readonly Regex Unsafe = new("[^a-zA-Z0-9]", RegexOptions.Compiled);
    private static readonly Regex ConversationId = new("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", RegexOptions.Compiled);

    private static StringComparison PathCase =>
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>Claude's config folder: <c>CLAUDE_CONFIG_DIR</c> when set, else <c>~/.claude</c>.</summary>
    public static string ConfigDir() =>
        Environment.GetEnvironmentVariable("CLAUDE_CONFIG_DIR") is { Length: > 0 } dir
            ? dir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude");

    public static string ProjectsDir() => Path.Combine(ConfigDir(), "projects");

    public static string Encode(string folder) => Unsafe.Replace(folder.TrimEnd('/', '\\') is { Length: > 0 } f ? f : folder, "-");

    public static bool IsConversationId(string? id) => id is not null && ConversationId.IsMatch(id);

    /// <summary>
    /// Claude's folder for <paramref name="folder"/>: the one there is (Windows paths are matched without regard
    /// to case, as Claude saw whatever casing the process was started with), or, with <paramref name="create"/>,
    /// a new one. Null when there is none and none was asked for.
    /// </summary>
    public static string? FolderFor(string folder, bool create)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Path.IsPathRooted(folder))
            throw new InvalidOperationException("A folder is named by its full path.");
        var encoded = Encode(folder);
        var root = ProjectsDir();
        var name = encoded.Length <= MaxEncoded ? encoded : encoded[..MaxEncoded];
        if (Directory.Exists(root))
        {
            foreach (var dir in Directory.EnumerateDirectories(root))
            {
                var have = Path.GetFileName(dir);
                if (encoded.Length <= MaxEncoded ? string.Equals(have, encoded, PathCase)
                        : have.StartsWith(name + "-", PathCase))
                    return dir;
            }
        }
        if (!create) return null;
        if (encoded.Length > MaxEncoded)
            throw new InvalidOperationException("That folder's path is too long to place Claude's data for it here. Start Claude there once, then try again.");
        var made = Path.Combine(root, encoded);
        Directory.CreateDirectory(made);
        return made;
    }

    // ---- Memory ----------------------------------------------------------------------------------------

    public static ClaudeMemoryListing ReadMemory(string folder)
    {
        var files = new List<ClaudeMemoryFile>();
        var dir = FolderFor(folder, create: false) is { } project ? Path.Combine(project, "memory") : null;
        if (dir is null || !Directory.Exists(dir)) return new(folder, files);

        var index = File.Exists(Path.Combine(dir, Index)) ? File.ReadAllLines(Path.Combine(dir, Index)) : [];
        foreach (var path in Directory.EnumerateFiles(dir, "*.md").OrderBy(p => p, StringComparer.OrdinalIgnoreCase).Take(MaxMemoryFiles))
        {
            var name = Path.GetFileName(path);
            if (string.Equals(name, Index, StringComparison.OrdinalIgnoreCase)) continue;
            var info = new FileInfo(path);
            var content = info.Length <= MaxMemoryFile ? File.ReadAllText(path) : null;
            files.Add(new(name, content is null ? null : DescriptionOf(content), content, info.Length,
                info.LastWriteTimeUtc, IndexLineOf(index, name)));
        }
        return new(folder, files);
    }

    /// <summary>
    /// Merges <paramref name="names"/> of <paramref name="source"/> into <paramref name="folder"/>'s memory: a file
    /// that isn't there is written, one there with the same text is left, one there with other text is
    /// replaced only when named in <paramref name="replace"/>. Each file written that the index doesn't list
    /// gets the source's line for it (or a plain link) at the end of <c>MEMORY.md</c>.
    /// </summary>
    public static ClaudeMemoryImport MergeMemory(ClaudeMemoryListing source, string folder, IEnumerable<string> names, IEnumerable<string>? replace)
    {
        var wanted = names.Distinct(StringComparer.Ordinal).ToList();
        var replacing = new HashSet<string>(replace ?? [], StringComparer.Ordinal);
        var byName = source.Files.Where(f => f.Content is not null).ToDictionary(f => f.Name, StringComparer.Ordinal);
        List<string> copied = [], same = [], kept = [], missing = [];

        // Every name checked before anything is written: a refusal leaves the folder as it was.
        if (wanted.FirstOrDefault(n => !PlainMemoryName(n)) is { } bad)
            throw new InvalidOperationException($"\"{bad}\" isn't a memory file's name.");

        string? dir = null;
        foreach (var name in wanted)
        {
            if (!byName.TryGetValue(name, out var file)) { missing.Add(name); continue; }
            dir ??= Directory.CreateDirectory(Path.Combine(FolderFor(folder, create: true)!, "memory")).FullName;
            var path = Path.Combine(dir, name);
            if (File.Exists(path))
            {
                if (File.ReadAllText(path) == file.Content) { same.Add(name); continue; }
                if (!replacing.Contains(name)) { kept.Add(name); continue; }
            }
            File.WriteAllText(path, file.Content);
            copied.Add(name);
        }

        if (dir is not null && copied.Count > 0)
        {
            var indexPath = Path.Combine(dir, Index);
            var index = File.Exists(indexPath) ? File.ReadAllText(indexPath) : "";
            var lines = index.Split('\n');
            var add = new StringBuilder();
            foreach (var name in copied)
            {
                if (IndexLineOf(lines, name) is not null) continue;
                var line = byName[name].IndexLine ?? $"- [{Path.GetFileNameWithoutExtension(name)}]({name})";
                add.Append(line.TrimEnd('\r')).Append('\n');
            }
            if (add.Length > 0)
            {
                var sep = index.Length > 0 && !index.EndsWith('\n') ? "\n" : "";
                File.WriteAllText(indexPath, index + sep + add);
            }
        }
        return new(copied, same, kept, missing);
    }

    // One plain name of a memory file, never the index: a name from another machine is joined onto this one's
    // memory folder, and must not reach out of it.
    private static bool PlainMemoryName(string name) =>
        name.Length is > 3 and <= 200
        && name.EndsWith(".md", StringComparison.OrdinalIgnoreCase)
        && !string.Equals(name, Index, StringComparison.OrdinalIgnoreCase)
        && name is not "." and not ".."
        && name.IndexOfAny(['/', '\\', ':']) < 0
        && name.IndexOfAny(Path.GetInvalidFileNameChars()) < 0;

    private static string? IndexLineOf(IEnumerable<string> index, string name) =>
        index.FirstOrDefault(l => l.Contains($"]({name})", StringComparison.Ordinal))?.TrimEnd('\r');

    // The front matter's description, the line Claude decides relevance by.
    private static string? DescriptionOf(string content)
    {
        using var reader = new StringReader(content);
        if (reader.ReadLine()?.Trim() != "---") return null;
        for (var line = reader.ReadLine(); line is not null && line.Trim() != "---"; line = reader.ReadLine())
            if (line.StartsWith("description:", StringComparison.Ordinal))
                return line["description:".Length..].Trim().Trim('"', '\'') is { Length: > 0 } d ? d : null;
        return null;
    }

    // ---- Conversations ---------------------------------------------------------------------------------

    /// <summary>A conversation's transcript wherever on this machine it is: ids are unique, folders aren't needed.</summary>
    public static string? FindTranscript(string conversationId)
    {
        if (!IsConversationId(conversationId)) return null;
        var root = ProjectsDir();
        if (!Directory.Exists(root)) return null;
        return Directory.EnumerateDirectories(root)
            .Select(d => Path.Combine(d, conversationId + ".jsonl"))
            .Where(File.Exists)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();
    }

    /// <summary>
    /// A conversation packed to carry: its transcript and the folder beside it (subagents, saved tool output),
    /// as a zip in a temporary file that goes away when the returned stream is closed.
    /// </summary>
    public static FileStream Pack(string conversationId)
    {
        var transcript = FindTranscript(conversationId)
            ?? throw new FileNotFoundException("That conversation isn't on this machine.");
        var temp = Path.Combine(Path.GetTempPath(), $"hangar-conversation-{Guid.NewGuid():N}.zip");
        try
        {
            using var zip = ZipFile.Open(temp, ZipArchiveMode.Create);
            zip.CreateEntryFromFile(transcript, conversationId + ".jsonl", CompressionLevel.Fastest);
            var side = Path.Combine(Path.GetDirectoryName(transcript)!, conversationId);
            if (Directory.Exists(side))
                foreach (var file in Directory.EnumerateFiles(side, "*", SearchOption.AllDirectories))
                    zip.CreateEntryFromFile(file,
                        conversationId + "/" + Path.GetRelativePath(side, file).Replace('\\', '/'), CompressionLevel.Fastest);
        }
        catch
        {
            try { File.Delete(temp); } catch { /* the temp folder's to clean */ }
            throw;
        }
        return new FileStream(temp, FileMode.Open, FileAccess.Read, FileShare.Read, 81920, FileOptions.DeleteOnClose);
    }

    /// <summary>
    /// Unpacks a <see cref="Pack"/>ed conversation under <paramref name="folder"/>'s data on this machine, so a
    /// <c>claude --resume</c> started there finds it. A transcript already there that is as long or longer is
    /// kept: it is this conversation too, and has everything the one arriving has.
    /// </summary>
    /// <returns>Whether the transcript was written (false: the one there was kept).</returns>
    public static bool Unpack(string zipPath, string conversationId, string folder)
    {
        if (!IsConversationId(conversationId)) throw new InvalidOperationException("That isn't a conversation id.");
        var project = FolderFor(folder, create: true)!;
        var side = Path.GetFullPath(Path.Combine(project, conversationId)) + Path.DirectorySeparatorChar;
        using var zip = ZipFile.OpenRead(zipPath);
        var transcript = zip.GetEntry(conversationId + ".jsonl")
            ?? throw new InvalidOperationException("The other machine sent no transcript.");
        var target = Path.Combine(project, conversationId + ".jsonl");
        if (File.Exists(target) && new FileInfo(target).Length >= transcript.Length) return false;

        foreach (var entry in zip.Entries)
        {
            if (entry.FullName.EndsWith('/')) continue;
            // Only this conversation's own two things: its transcript, and what stays inside the folder beside it
            // (`<id>/../other.jsonl` would be another conversation's).
            var rel = entry.FullName.Replace('\\', '/');
            string path;
            if (rel == conversationId + ".jsonl") path = target;
            else if (rel.StartsWith(conversationId + "/", StringComparison.Ordinal))
            {
                path = Path.GetFullPath(Path.Combine(project, rel.Replace('/', Path.DirectorySeparatorChar)));
                if (!path.StartsWith(side, PathCase)) continue;
            }
            else continue;
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temp = path + ".hangar-new";
            entry.ExtractToFile(temp, overwrite: true);
            File.Move(temp, path, overwrite: true);
        }
        return true;
    }
}
