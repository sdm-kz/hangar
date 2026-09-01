import type { Project } from "@/types";
import { dirKey } from "./sessionOrder";

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

  const sections: ProjectSection<T>[] = [...projects]
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .map((p) => ({ project: p, items: byProject.get(p.id)! }));
  if (loose.length) sections.push({ project: null, items: loose });
  return sections;
}
