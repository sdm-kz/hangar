using System.Text.Json;

namespace Hangar.Server.Update;

/// <summary>
/// What changed in a build, for the update dialog to show before anyone commits to installing it.
///
/// Written into the payload's build.json by scripts\stage-update.ps1, because staging is the first
/// moment the question can be answered: it is the only step that knows both ends of the range -- the
/// build going in and the one already installed. Optional throughout. A build staged by hand carries
/// no notes and the dialog simply has nothing to say about it, which is what it did before this
/// existed.
/// </summary>
/// <param name="Summary">One line for the button's tooltip, when there is one worth writing.</param>
/// <param name="Changes">The changes themselves, one line each, newest first.</param>
/// <param name="Since">Commit the range was measured from — the installed build's, normally.</param>
public sealed record ReleaseNotes(string? Summary, IReadOnlyList<string>? Changes, string? Since)
{
    // What a dialog can show without becoming a log viewer, and what a hand-edited (or runaway)
    // build.json is allowed to cost us. Anything past these is dropped rather than rendered.
    private const int MaxChanges = 50;
    private const int MaxLineLength = 300;

    /// <summary>The same notes, cut to what the dialog can reasonably show. Null when empty.</summary>
    public ReleaseNotes? Trimmed()
    {
        var changes = Changes?
            .Where(c => !string.IsNullOrWhiteSpace(c))
            .Select(c => c.Trim() is { Length: > MaxLineLength } long_ ? long_[..MaxLineLength] + "…" : c.Trim())
            .Take(MaxChanges)
            .ToArray();
        var summary = string.IsNullOrWhiteSpace(Summary) ? null : Summary.Trim();
        if (summary is { Length: > MaxLineLength }) summary = summary[..MaxLineLength] + "…";
        // Notes that say nothing are no notes: the UI tests for their presence, not their contents.
        if (summary is null && (changes is null || changes.Length == 0)) return null;
        return new ReleaseNotes(summary, changes, string.IsNullOrWhiteSpace(Since) ? null : Since.Trim());
    }
}

/// <summary>
/// Identity of one build, written by scripts\build.ps1 as build.json next to the exe. Two builds are
/// the same iff their <see cref="BuildId"/> matches; which is newer is <see cref="IsNewerThan"/>. The
/// rest is for the UI to show ("built 5 minutes ago, commit a1b2c3d").
/// </summary>
/// <param name="BuildId">Stable name for this build: UTC build timestamp + short commit.</param>
/// <param name="Commit">Short commit hash the build came from; null outside a git checkout.</param>
/// <param name="Branch">Branch the build came from; null outside a git checkout.</param>
/// <param name="BuiltAtUtc">When the build ran.</param>
/// <param name="Notes">What changed since the build being replaced, when whoever staged it said.</param>
/// <param name="Version">The release version ("1.2.3"), for a build made from a release tag; null otherwise.</param>
public sealed record BuildStamp(
    string BuildId,
    string? Commit,
    string? Branch,
    DateTime? BuiltAtUtc,
    ReleaseNotes? Notes = null,
    string? Version = null)
{
    private static readonly JsonSerializerOptions JsonOpts = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Whether this build is one to offer in place of <paramref name="running"/>: a different build,
    /// made later. Only ever forward — a build staged before the one installed (left in the staging
    /// folder when deploy.ps1 put a newer one in) is not an update, and installing it would quietly
    /// roll the app back. A rollback is a deploy of the older commit. When either build's time is
    /// unknown, a different build is still offered, as before the times were compared.
    /// </summary>
    public bool IsNewerThan(BuildStamp? running)
    {
        if (running is null) return true;
        if (BuildId == running.BuildId) return false;
        if (BuiltAtUtc is { } mine && running.BuiltAtUtc is { } theirs) return mine > theirs;
        return true;
    }

    /// <summary>The build.json inside <paramref name="folder"/>, or null when it's missing or unreadable.</summary>
    public static BuildStamp? Read(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder)) return null;
        try
        {
            var path = Path.Combine(folder, "build.json");
            if (!File.Exists(path)) return null;
            var stamp = JsonSerializer.Deserialize<BuildStamp>(File.ReadAllText(path), JsonOpts);
            // A stamp with no id can't be compared, so it's no more useful than a missing one.
            if (string.IsNullOrWhiteSpace(stamp?.BuildId)) return null;
            return stamp with { Notes = stamp.Notes?.Trimmed() };
        }
        catch
        {
            // Mid-write, half-copied, or hand-edited into nonsense: treat as "no stamp here" and let
            // the next read pick it up. A staged build is polled, so this self-corrects.
            return null;
        }
    }
}
