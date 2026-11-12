using System.Reflection;
using System.Text;

namespace Hangar.Server.Sessions;

/// <summary>
/// Installs Hangar's slash commands (<c>/hgr-notify</c>, <c>/hgr-open-file</c>, …, from the repo's
/// <c>claude-commands</c> folder, embedded in the exe) into <c>~/.claude/commands</c>, so a session Hangar
/// launches can call the self-service API without anyone copying files about. Runs at every start, so an
/// update brings the commands that match its API.
///
/// Hangar owns a file only while it carries <see cref="Marker"/>, which every file it writes ends with:
/// those are rewritten when they differ from what this build ships, and deleted once this build no
/// longer ships them (a command renamed or retired). A file without the marker — a command of the same
/// name the user wrote, or one of these they took over by deleting the line — is left alone.
/// </summary>
public static class ClaudeCommandStore
{
    private static string CommandsDir =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".claude", "commands");

    private const string ResourcePrefix = "Hangar.Server.claude-commands.";

    // How a file says Hangar wrote it. Claude reads it along with the command; it says nothing that
    // changes what the command does.
    internal const string Marker = "<!-- hangar-managed:";
    private const string MarkerLine =
        Marker + " Hangar installs this file and rewrites it on every start. Delete this line to keep your own version. -->";

    /// <param name="commandsDir">The folder to install into; <c>~/.claude/commands</c> unless given.</param>
    public static void EnsureInstalled(ILogger log, string? commandsDir = null)
    {
        try
        {
            var dir = commandsDir ?? CommandsDir;
            var shipped = Shipped();
            if (shipped.Count == 0) return;
            Directory.CreateDirectory(dir);

            var written = new List<string>();
            var kept = new List<string>();
            foreach (var (file, content) in shipped)
            {
                var path = Path.Combine(dir, file);
                if (File.Exists(path))
                {
                    var current = File.ReadAllText(path);
                    if (!current.Contains(Marker)) { kept.Add(file); continue; }
                    if (current == content) continue;
                }
                var tmp = path + ".hangar.tmp";
                File.WriteAllText(tmp, content, new UTF8Encoding(false));
                File.Move(tmp, path, overwrite: true);
                written.Add(file);
            }

            var removed = new List<string>();
            foreach (var path in Directory.EnumerateFiles(dir, "hgr-*.md"))
            {
                var file = Path.GetFileName(path);
                if (shipped.ContainsKey(file) || !File.ReadAllText(path).Contains(Marker)) continue;
                File.Delete(path);
                removed.Add(file);
            }

            if (written.Count > 0)
                log.LogInformation("Installed Hangar commands in {Dir}: {Files}", dir, string.Join(", ", written));
            if (removed.Count > 0)
                log.LogInformation("Removed Hangar commands this version no longer ships: {Files}", string.Join(", ", removed));
            if (kept.Count > 0)
                log.LogInformation(
                    "Left alone in {Dir}, having no hangar-managed line (your own versions): {Files}. Delete " +
                    "one to have Hangar install its own.", dir, string.Join(", ", kept));
        }
        catch (Exception ex)
        {
            log.LogWarning(ex, "Could not install Hangar's commands in ~/.claude/commands");
        }
    }

    /// <summary>
    /// Each command this build ships and what is on disk for it, for Settings to list: <c>installed</c>
    /// (Hangar's, current), <c>own</c> (a file of the same name without the marker), <c>stale</c>
    /// (Hangar's, from another build — a dev instance, or a start that couldn't write) or <c>missing</c>.
    /// </summary>
    public static IReadOnlyList<ClaudeCommandStatus> Status(string? commandsDir = null)
    {
        var dir = commandsDir ?? CommandsDir;
        var list = new List<ClaudeCommandStatus>();
        foreach (var (file, content) in Shipped().OrderBy(kv => kv.Key, StringComparer.Ordinal))
        {
            var path = Path.Combine(dir, file);
            string state;
            try
            {
                var current = File.Exists(path) ? File.ReadAllText(path) : null;
                state = current is null ? "missing" : !current.Contains(Marker) ? "own" : current == content ? "installed" : "stale";
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { state = "missing"; }
            var meta = SlashCommands.ParseHead(content);
            list.Add(new ClaudeCommandStatus(Path.GetFileNameWithoutExtension(file), meta.Description, meta.Hint, state));
        }
        return list;
    }

    /// <summary>File name → the content Hangar writes for it: LF line endings, the marker as the last line.</summary>
    private static Dictionary<string, string> Shipped()
    {
        var asm = Assembly.GetExecutingAssembly();
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var name in asm.GetManifestResourceNames())
        {
            if (!name.StartsWith(ResourcePrefix, StringComparison.Ordinal)) continue;
            using var stream = asm.GetManifestResourceStream(name)!;
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var text = reader.ReadToEnd().Replace("\r\n", "\n").TrimEnd('\n');
            result[name[ResourcePrefix.Length..]] = text + "\n\n" + MarkerLine + "\n";
        }
        return result;
    }
}

/// <summary>One of Hangar's commands, as <see cref="ClaudeCommandStore.Status"/> finds it.</summary>
public sealed record ClaudeCommandStatus(string Name, string? Description, string? Hint, string State);
