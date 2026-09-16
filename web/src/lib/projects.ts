import type { Project, ProjectGroup, SessionInfo } from "@/types";
import { dirKey, move } from "./sessionOrder";

/**
 * Projects: named groupings of folders, one level above the sidebar's folder groups. A project links
 * absolute folder paths, and a link covers the folder *and everything under it* — so a session
 * started later in a subfolder (a worktree, a nested repo) joins the project without being told to.
 *
 * The membership rules live here rather than in the sidebar because two lists (sessions and recents)
 * ask the same questions of them, and the settings popup asks a third.
 */

/** Whether two paths name the same folder, through the same normalization as the grouping key. */
export function sameFolder(a: string, b: string): boolean {
  return dirKey(a) === dirKey(b);
}

/**
 * Whether `dir` is `link` or sits under it. Both are compared through dirKey, which folds the case
 * and separator differences Windows paths arrive with; the trailing "/" on the prefix test is what
 * stops `C:\git\app-old` from matching a link to `C:\git\app`.
 */
export function isUnder(dir: string, link: string): boolean {
  const d = dirKey(dir);
  const l = dirKey(link);
  return d === l || d.startsWith(l + "/");
}

/**
 * The project a folder belongs to, or null. When two projects link overlapping paths the deeper link
 * wins — a project linking `C:\git\app\web` is a more specific statement about that folder than one
 * linking `C:\git`, and honouring the specific one is what lets a sub-tree be split out.
 */
export function projectForDir(dir: string, projects: readonly Project[]): Project | null {
  let best: Project | null = null;
  let bestLen = -1;
  for (const p of projects)
    for (const f of p.folders) {
      if (!isUnder(dir, f)) continue;
      const len = dirKey(f).length;
      if (len > bestLen) {
        best = p;
        bestLen = len;
      }
    }
  return best;
}

/** One heading in the sidebar: a project (or the unassigned tail) and whatever falls under it. */
export interface ProjectSection<T> {
  /** null for the trailing "no project" section. */
  project: Project | null;
  /** Folder groups in the grouped lists; the sessions themselves in the flat one. */
  items: T[];
}

/**
 * File items under the project their folder belongs to. `dirOf` says where an item lives, so the
 * same split serves both shapes the sidebar draws: folder groups in the grouped lists, and bare
 * sessions in the flat one, where a project collects its sessions with no folder headings between.
 *
 * Every project gets a section even when nothing matches it — a project with no sessions yet still
 * has to be visible to drop a folder onto or open its settings from — followed by one section for
 * everything unassigned, which is omitted when there is nothing left over: an empty "No project"
 * heading is a row that says nothing. (A folder is taken back out through the folder's own menu.)
 * With no projects at all there are no sections and the caller draws the plain list.
 *
 * Projects are ordered by name, case-insensitively, like the folder groups themselves: creation order
 * is an accident of when you happened to set one up, and isn't worth remembering.
 */
export function sectionsByProject<T>(
  items: readonly T[],
  projects: readonly Project[],
  dirOf: (item: T) => string
): ProjectSection<T>[] {
  const byProject = new Map<string, T[]>(projects.map((p) => [p.id, []]));
  const loose: T[] = [];
  for (const item of items) {
    const p = projectForDir(dirOf(item), projects);
    if (p) byProject.get(p.id)!.push(item);
    else loose.push(item);
  }

  const sections: ProjectSection<T>[] = sortedByName(projects)
    .map((p) => ({ project: p, items: byProject.get(p.id)! }));
  if (loose.length) sections.push({ project: null, items: loose });
  return sections;
}

/**
 * Projects in the order anything listing them should use: by name, blind to case and accents, and in
 * the viewer's locale, so a list mixing Cyrillic and Latin names sorts the way that reader expects.
 *
 * Shared because a menu is scanned differently from a list — you open it with a name already in mind
 * and look for it, which only works if there is somewhere for it to be. The sidebar's sections have
 * always sorted; the pickers that move things between projects were showing them in whatever order
 * the store happened to hold.
 */
export function sortedByName<T extends { name: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * Whether a project heading has already said everything this section's folder header would: the
 * project links exactly one folder, and that folder is the only one in the section with anything in
 * it. Drawing both is then a box inside an identically named box — one chevron to fold the project,
 * another to fold its single folder — so the grouped lists drop the folder header and hang its
 * sessions straight off the project heading.
 *
 * A subfolder does not count: a project linked to `C:\git` whose only sessions live in
 * `C:\git\app` keeps its folder header, because "app" is a name the project heading never says.
 */
export function mergesFolderHeader(
  project: Project | null,
  dirs: readonly string[],
  // Whether the project is also drawing virtual folders. With boxes above it, the loose sessions
  // need a box of their own to be read as a set rather than as strays hanging off the project — so
  // the folder header earns its place back the moment there is something to tell it apart from.
  hasGroups = false
): boolean {
  return (
    !!project &&
    !hasGroups &&
    project.folders.length === 1 &&
    dirs.length === 1 &&
    sameFolder(dirs[0], project.folders[0])
  );
}

/**
 * The virtual folder a session is drawn in, or null when it is drawn under its own folder.
 *
 * A membership only applies inside the project that owns the group: the session's folder decides
 * which project it is in, and a group can only refine that, never overrule it. So a folder moved to
 * another project (or unlinked) leaves its sessions' memberships pointing at a group with no claim
 * on them, and those sessions go back to showing where the path says they belong. Nothing is erased
 * — putting the folder back puts the grouping back with it. This mirrors ProjectStore.GroupFor, which
 * answers the same question for the tray menu.
 */
export function groupForSession(
  session: SessionInfo,
  projects: readonly Project[]
): ProjectGroup | null {
  if (!session.groupId) return null;
  const owner = projectForDir(session.workingDirectory, projects);
  return owner?.groups.find((g) => g.id === session.groupId) ?? null;
}

/**
 * A project's group ids in the order a drop implies, ready to send to the server.
 *
 * `visibleIds` is the list the user was actually looking at, which is not always all of them: the
 * sidebar's active-only filter hides an empty box, and the indices a drag reports are positions in
 * what was on screen. So the move is applied to those, and each hidden group keeps the slot it
 * already held among them — the user aimed at what they could see, and a box they couldn't see has
 * no business jumping because of it. Pass every id when nothing is hidden, as the settings popup does.
 *
 * Shared because the sidebar and the settings popup both arrange the same boxes, and two answers to
 * "where does this one go?" would be two orders that disagree.
 */
export function groupIdsAfterMove(
  groups: readonly ProjectGroup[],
  visibleIds: readonly string[],
  from: number,
  to: number
): string[] {
  const shown = new Set(visibleIds);
  const moved = move([...visibleIds], from, to);
  let next = 0;
  return groups.map((g) => (shown.has(g.id) ? moved[next++] : g.id));
}
