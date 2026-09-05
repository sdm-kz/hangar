using ClaudeWeb.Server.Sessions;

namespace ClaudeWeb.Server.Tray;

/// <summary>One session in the tray menu, and how deep it hangs off its folder (0 = not a fork).</summary>
internal sealed record TreeSession(SessionInfo Session, int ForkDepth);

/// <summary>One folder's sessions, under the heading its last path segment gives it.</summary>
internal sealed record TreeFolder(string Dir, string Label, IReadOnlyList<TreeSession> Sessions)
{
    public int Count => Sessions.Count;
}

/// <summary>
/// One project heading and the folder groups under it. <see cref="Project"/> is null for the
/// trailing "no project" section — the folders nothing links.
/// </summary>
internal sealed record TreeSection(Project? Project, IReadOnlyList<TreeFolder> Folders)
{
    public int Count => Folders.Sum(f => f.Count);

    /// <summary>
    /// Whether the project heading has already said everything this section's folder heading would:
    /// the project links exactly one folder, and that folder is the only one here with anything in
    /// it. The folder heading is then dropped and its sessions hang straight off the project — the
    /// same rule the sidebar applies (web/src/lib/projects.ts, mergesFolderHeader). A subfolder does
    /// not count: its name is something the project heading never says.
    /// </summary>
    public bool FolderHeadingMerged =>
        Project is { Folders.Count: 1 }
        && Folders.Count == 1
        && ProjectStore.DirKey(Folders[0].Dir) == ProjectStore.DirKey(Project.Folders[0]);
}

/// <summary>
/// One line of the tray's running list: the text to show, already indented, and — for a session row —
/// the session it opens. A null <see cref="Session"/> is a heading, which names a group rather than
/// pointing at anything.
/// </summary>
internal sealed record TreeRow(string Text, SessionInfo? Session);

/// <summary>
/// One block of the tray's running list: a project, whose <see cref="Rows"/> hang in a submenu under
/// <see cref="Heading"/>. A null heading means there is no project to open — the rows go straight into
/// the menu.
/// </summary>
internal sealed record TreeGroup(string? Heading, int Count, IReadOnlyList<TreeRow> Rows);

/// <summary>
/// Arranges sessions the way the sidebar's grouped ("tree") view does, so the tray menu and the web
/// UI describe the same world: folder groups under the project that links them, forks nested under
/// the session they were forked from.
///
/// <para>Two things the sidebar has that the tray deliberately doesn't: the hand-arranged per-folder
/// order and the collapsed-group state. Both are per-browser view preferences kept in localStorage,
/// which a tray menu has no access to and no business inventing — so a folder here is ordered pins
/// first, then newest, and nothing is ever folded away.</para>
/// </summary>
internal static class SessionTree
{
    /// <summary>Bullet in front of a running session, matching the sidebar's activity dot.</summary>
    private const string Glyph = "●";

    /// <summary>
    /// Three spaces a level: enough for the nesting to read at a glance, little enough that a session
    /// three levels in (project, folder, fork) still has room for its name.
    /// </summary>
    private static string Indent(int depth) => new(' ', depth * 3);

    /// <summary>
    /// The running list as the tray draws it: one block per project, each opening as a submenu, and
    /// inside it the folder groups with their sessions indented underneath. A project is a submenu
    /// because the whole list inline is what pushed a busy machine's sessions off the screen; below
    /// that the nesting stays inline, so a session is one hover and one click away rather than three.
    ///
    /// <para>Returning rows rather than menu items keeps the layout — what is nested under what, and
    /// how far in — separable from WinForms, which is the half of this worth checking.</para>
    /// </summary>
    public static IReadOnlyList<TreeGroup> Menu(
        IReadOnlyCollection<SessionInfo> running,
        IReadOnlyList<Project> projects)
    {
        var sections = Build(running, projects);
        // With nothing running inside a project there is nothing to put a submenu around: a lone
        // "No project" holding the whole list would only hide it behind a hover. The folder groups
        // then go straight into the menu — the list the tray has always shown, grouped by folder.
        var headed = sections.Any(s => s.Project is not null);

        var groups = new List<TreeGroup>(sections.Count);
        foreach (var section in sections)
        {
            var rows = new List<TreeRow>();
            foreach (var folder in section.Folders)
            {
                var depth = 0;
                if (!section.FolderHeadingMerged)
                {
                    rows.Add(Heading(folder.Label, folder.Count, 0));
                    depth = 1;
                }
                foreach (var node in folder.Sessions)
                {
                    rows.Add(new TreeRow(
                        $"{Indent(depth + node.ForkDepth)}{Glyph}  {node.Session.Name}", node.Session));
                }
            }
            groups.Add(new TreeGroup(
                headed ? section.Project?.Name ?? "No project" : null, section.Count, rows));
        }
        return groups;
    }

    private static TreeRow Heading(string text, int count, int depth) =>
        new($"{Indent(depth)}{text}  ({count})", null);

    /// <summary>Last path segment of a working directory — the folder heading's text.</summary>
    public static string FolderLabel(string dir)
    {
        var parts = dir.Split(new[] { '/', '\\' }, StringSplitOptions.RemoveEmptyEntries);
        return parts.Length == 0 ? dir : parts[^1];
    }

    /// <summary>
    /// Group sessions into project sections. Projects come out in name order and only when something
    /// in them is on the list — an empty project is a heading over nothing, which is exactly what
    /// the sidebar's active-only filter drops too — followed by one section for whatever is unfiled.
    /// </summary>
    public static IReadOnlyList<TreeSection> Build(
        IReadOnlyCollection<SessionInfo> sessions,
        IReadOnlyList<Project> projects)
    {
        var folders = GroupByFolder(sessions);

        var byProject = new Dictionary<string, List<TreeFolder>>(StringComparer.Ordinal);
        var loose = new List<TreeFolder>();
        foreach (var folder in folders)
        {
            var p = ProjectStore.ForDirectory(projects, folder.Dir);
            if (p is null) loose.Add(folder);
            else if (byProject.TryGetValue(p.Id, out var list)) list.Add(folder);
            else byProject[p.Id] = [folder];
        }

        var sections = projects
            .Where(p => byProject.ContainsKey(p.Id))
            .OrderBy(p => p.Name, StringComparer.CurrentCultureIgnoreCase)
            .Select(p => new TreeSection(p, byProject[p.Id]))
            .ToList();
        if (loose.Count > 0) sections.Add(new TreeSection(null, loose));
        return sections;
    }

    /// <summary>
    /// One group per working directory, ordered by the heading each one shows — the same ordering,
    /// and the same first-seen spelling of the path, as the sidebar's own grouping.
    /// </summary>
    private static List<TreeFolder> GroupByFolder(IReadOnlyCollection<SessionInfo> sessions)
    {
        var order = new List<string>();
        var byDir = new Dictionary<string, (string Dir, List<SessionInfo> Items)>(StringComparer.Ordinal);
        foreach (var s in sessions)
        {
            var key = ProjectStore.DirKey(s.WorkingDirectory);
            if (!byDir.TryGetValue(key, out var g))
            {
                // Keep the first-seen spelling for the heading, so its casing stays readable.
                g = (s.WorkingDirectory, []);
                byDir[key] = g;
                order.Add(key);
            }
            g.Items.Add(s);
        }

        return order
            .Select(k => byDir[k])
            .Select(g => new TreeFolder(g.Dir, FolderLabel(g.Dir), Nest(g.Items)))
            .OrderBy(f => f.Label, StringComparer.CurrentCultureIgnoreCase)
            .ToList();
    }

    /// <summary>
    /// Order one folder's sessions and nest its forks: pinned first, then newest, with each fork
    /// following the session it came from. A fork whose parent isn't in this folder's list (closed,
    /// or running somewhere else) is drawn as an ordinary session — there is nothing to nest it under.
    /// </summary>
    private static List<TreeSession> Nest(List<SessionInfo> items)
    {
        var ordered = items
            .OrderByDescending(s => s.Pinned)
            .ThenByDescending(s => s.CreatedAt)
            .ToList();

        var present = ordered.Select(s => s.Id).ToHashSet(StringComparer.Ordinal);
        var children = ordered
            .Where(s => s.ParentSessionId is { } parent && parent != s.Id && present.Contains(parent))
            .GroupBy(s => s.ParentSessionId!, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.ToList(), StringComparer.Ordinal);

        var result = new List<TreeSession>(ordered.Count);
        var emitted = new HashSet<string>(StringComparer.Ordinal);

        void Emit(SessionInfo s, int depth)
        {
            // Depth is capped and every id emitted once: a fork chain is normally two or three deep,
            // and a cycle in the parent links (however it got there) must not take the tray down.
            if (!emitted.Add(s.Id)) return;
            result.Add(new TreeSession(s, depth));
            if (depth >= 4 || !children.TryGetValue(s.Id, out var kids)) return;
            foreach (var kid in kids) Emit(kid, depth + 1);
        }

        foreach (var s in ordered)
        {
            var isFork = s.ParentSessionId is { } parent && parent != s.Id && present.Contains(parent);
            if (!isFork) Emit(s, 0);
        }
        // Anything left is a fork whose parent chain never reached it (a cycle, or a depth cut-off).
        foreach (var s in ordered) Emit(s, 0);
        return result;
    }
}
