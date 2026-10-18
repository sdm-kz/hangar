// Projects as they cross the wire, and the rules for which project a session falls under. Compiled into
// both the daemon and the tray, like shared\Pty: the tray menu asks the same questions of the same data
// as the daemon does, and a second answer to "which project is this folder in?" would be a second thing
// to keep in step.

namespace Hangar.Contract;

/// <summary>
/// A named grouping of folders. A project is the user's own unit of work — it can span several
/// unrelated folders (a frontend repo, its backend, a notes directory) or none at all while it is
/// being set up. The sidebar groups sessions by folder; a project sits one level above that and
/// collects those folder groups under one heading.
///
/// <para><see cref="Folders"/> holds absolute paths, and a link covers the folder <em>and everything
/// under it</em>: a session started later in a subfolder — a worktree, a nested repo — joins the
/// project on its own. That is the point of linking by path rather than by session id: ids are minted
/// afresh on every resume, folders are stable.</para>
/// </summary>
public sealed record Project(
    string Id,
    string Name,
    /// <summary>Palette colour name (the same names as a session's /color), or null for no accent.</summary>
    string? Color,
    IReadOnlyList<string> Folders)
{
    /// <summary>
    /// The project's virtual folders, in the order they are drawn — new ones are appended, and the
    /// user arranges them by dragging (see ProjectStore.ReorderGroups). Never null — a project with
    /// none is one that groups nothing by hand, which is most of them.
    /// </summary>
    public IReadOnlyList<ProjectGroup> Groups { get; init; } = Array.Empty<ProjectGroup>();

    /// <summary>
    /// GitHub repositories ("owner/name") this project's sessions can review pull requests from,
    /// beyond whatever their own folders point at. A project is a piece of work rather than a
    /// checkout, and the work usually spans more repos than any one session sits in.
    ///
    /// <para>An init-only property with a default, like Groups above: a projects.json written before
    /// this existed has no such field, and must go on loading.</para>
    /// </summary>
    public IReadOnlyList<string> Repos { get; init; } = Array.Empty<string>();

    /// <summary>
    /// Icon name from the client's own set (see web/src/lib/groupIcons.ts), or null for the default —
    /// the glyph every project wore before this existed. Init-only for the same reason as Repos: a
    /// projects.json written without it must go on loading, and reads as "the default".
    /// </summary>
    public string? Icon { get; init; }

    /// <summary>
    /// SSH connections saved with this project, offered first when a session in it opens a remote
    /// files tab. Never a secret: a password or a key's passphrase is typed at connect time and kept
    /// only in the server's memory for as long as the tab is open. Init-only like Repos, so a
    /// projects.json written before this existed goes on loading.
    /// </summary>
    public IReadOnlyList<RemoteConnection> Connections { get; init; } = Array.Empty<RemoteConnection>();
}

/// <summary>
/// The parameters of an SSH connection — everything needed to reach a host except the secret.
///
/// <para><see cref="Host"/> may be an alias from the server user's <c>~/.ssh/config</c>: it is
/// resolved at connect time, so a <c>HostName</c>, <c>User</c>, <c>Port</c> or <c>IdentityFile</c>
/// written there fills in whatever is left blank here.</para>
/// </summary>
public sealed record RemoteConnection(
    string Id,
    string Name,
    string Host,
    /// <summary>0 = the default (the config's Port, or 22).</summary>
    int Port,
    /// <summary>Null = the config's User, or the server account's name.</summary>
    string? User,
    /// <summary>"password", "key" (a private key file on the server machine) or "agent".</summary>
    string Auth,
    /// <summary>The private key file for "key" auth; null = the config's IdentityFile, or ~/.ssh/id_*.</summary>
    string? KeyPath,
    /// <summary>The folder the panel opens in; null = the remote account's home.</summary>
    string? StartPath);

/// <summary>
/// A <em>virtual folder</em>: a named box inside a project that holds sessions the user put there by
/// hand, rather than sessions a path put there. It exists because the folder a session runs in is
/// often the wrong unit — three sessions in one repo can be three unrelated errands, and two sessions
/// in different repos can be one — so a project's tree needs a grouping the filesystem doesn't supply.
///
/// <para><see cref="Sessions"/> holds membership keys, not session ids: a session id is minted afresh
/// on every resume, so an id-keyed membership would evaporate the first time the conversation was
/// reopened. The key is Claude's conversation id, with the same <c>session:</c> fallback the pins use
/// for a session too young to have reported one — see <c>ProjectStore.SessionKey</c>.</para>
///
/// <para>A session can only sit in a virtual folder of the project its own folder belongs to. Letting
/// it sit anywhere would mean a session showing up under a project that has no claim on it, and two
/// contradictory answers to "which project is this?" — so membership decorates the path rule rather
/// than overriding it. A membership whose project no longer links the folder simply stops applying;
/// it is kept, so relinking the folder brings the grouping back.</para>
/// </summary>
public sealed record ProjectGroup(
    string Id,
    string Name,
    /// <summary>Palette colour name, as on a project — or null to inherit the plain heading colour.</summary>
    string? Color,
    /// <summary>Icon name from the client's own set (see web/src/lib/groupIcons.ts); null = the default.</summary>
    string? Icon,
    IReadOnlyList<string> Sessions);

/// <summary>
/// The same membership rules the sidebar applies client-side (web/src/lib/projects.ts).
/// </summary>
public static class ProjectMembership
{
    /// <summary>
    /// A folder path folded to a comparison key: separators unified, trailing ones dropped, case
    /// folded on Windows. Two spellings of one folder have to compare equal, or a link stops covering
    /// the folder it names.
    /// </summary>
    public static string DirKey(string dir)
    {
        var key = dir.Replace('\\', '/').TrimEnd('/');
        return OperatingSystem.IsWindows() ? key.ToLowerInvariant() : key;
    }

    /// <summary>Whether <paramref name="dir"/> is the linked folder itself or sits under it.</summary>
    public static bool Covers(string link, string dir)
    {
        var l = DirKey(link);
        var d = DirKey(dir);
        // The separator on the prefix test is what stops a link to C:\git\app from swallowing
        // C:\git\app-old.
        return d == l || d.StartsWith(l + "/", StringComparison.Ordinal);
    }

    /// <summary>
    /// The project a folder belongs to, or null when nothing links it. Where two projects link
    /// overlapping paths the deeper link wins: linking C:\git\app\web says something more specific
    /// about that folder than linking C:\git, and honouring the specific one is what lets a sub-tree
    /// be split out into its own project.
    /// </summary>
    public static Project? ForDirectory(IReadOnlyList<Project> projects, string? dir)
    {
        if (string.IsNullOrWhiteSpace(dir)) return null;
        Project? best = null;
        var bestLen = -1;
        foreach (var p in projects)
            foreach (var f in p.Folders)
            {
                if (!Covers(f, dir)) continue;
                var len = DirKey(f).Length;
                if (len <= bestLen) continue;
                best = p;
                bestLen = len;
            }
        return best;
    }

    /// <summary>
    /// The virtual folder a session should be drawn in, given the project its folder falls under —
    /// or null when it isn't filed, or is filed in a group belonging to some other project.
    ///
    /// <para>That last case is the one worth spelling out: a membership only applies inside the
    /// project that owns the group. A folder moved to another project (or unlinked entirely) leaves
    /// its sessions' memberships pointing somewhere that has no claim on them, and the honest thing
    /// is to show those sessions where the path says they belong. The membership is not erased, so
    /// putting the folder back puts the grouping back with it.</para>
    /// </summary>
    public static ProjectGroup? GroupFor(IReadOnlyList<Project> projects, SessionInfo session)
    {
        if (session.GroupId is not { } id) return null;
        var owner = ForDirectory(projects, session.WorkingDirectory);
        return owner?.Groups.FirstOrDefault(g => g.Id == id);
    }
}
