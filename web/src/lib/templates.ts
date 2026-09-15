import type { Project, SessionTemplate } from "@/types";
import { sameFolder, sortedByName } from "./projects";

/**
 * Session templates: named launch presets for the errands that come back. A template holds the
 * project, the folder, the prompt and the launch settings; what changes from one run to the next is
 * one detail — the log entry, the support request, the Jira key — which is typed into the New
 * Session dialog's "details" box and folded into the prompt here.
 *
 * The rules live in this file rather than in the dialog because the template editor previews the
 * same substitution the launcher performs, and two answers to "what will actually be sent?" would be
 * one answer too many.
 */

/**
 * The placeholder a template marks the typed detail with. Written `{input}`, and tolerant about it:
 * `{{input}}`, `{ input }` and `{INPUT}` all read as the same intent, since the field is typed by
 * hand into a plain textarea with nothing to autocomplete it.
 *
 * A fresh regex per call on purpose — a global one carries `lastIndex` between calls, so a shared
 * instance would have `test` and `replace` disagreeing about the same string.
 */
const inputToken = () => /\{\{?\s*input\s*\}?\}/gi;

/** Whether a prompt says where the typed detail goes, rather than leaving it to be appended. */
export function hasInputToken(prompt: string): boolean {
  return inputToken().test(prompt);
}

/**
 * The prompt a launch actually sends: the detail substituted for `{input}`, or appended as its own
 * paragraph when the template has no placeholder.
 *
 * Both halves are the obvious reading of a template. `/fix-issue {input}` wants the key
 * *inside* the command, where appending it would leave a slash command with no argument followed by
 * a stray line; "investigate this log entry" wants the pasted log under it, where a substitution has
 * nowhere to go. Either side may be empty — a template with no prompt is just a preset, and a
 * detail-less launch of one that has a prompt sends the prompt as written.
 */
export function buildPrompt(prompt: string, input: string): string {
  const template = (prompt ?? "").trim();
  const detail = (input ?? "").trim();
  // A function replacement, not the string: `String.replace` reads "$&", "$1" and friends out of a
  // replacement STRING, and the detail is pasted text — a log line or a shell command is exactly the
  // kind of thing that can contain one, and it would come out mangled.
  if (hasInputToken(template)) return template.replace(inputToken(), () => detail).trim();
  if (!detail) return template;
  return template ? `${template}\n\n${detail}` : detail;
}

/** One heading in the templates picker: a project (or the trailing "no project") and its templates. */
export interface TemplateSection {
  /** null for templates that belong to no project — or whose project has since been deleted. */
  project: Project | null;
  templates: SessionTemplate[];
}

/**
 * The templates grouped under their projects, in the projects' own order, with the ones belonging to
 * none (or to a project that no longer exists — `projectId` is a soft reference) collected at the
 * end. Empty projects are left out: the picker is a list of things to launch, not a directory of
 * projects, and a heading with nothing under it is a row that can't be clicked.
 */
export function templateSections(
  templates: readonly SessionTemplate[],
  projects: readonly Project[]
): TemplateSection[] {
  const sections: TemplateSection[] = [];
  const taken = new Set<string>();
  // By name, like every other list of projects — see sortedByName. The order projects arrive in is
  // whatever the store happened to hold, which is no order at all to look a name up in.
  for (const project of sortedByName(projects)) {
    const mine = templates.filter((t) => t.projectId === project.id);
    if (mine.length === 0) continue;
    mine.forEach((t) => taken.add(t.id));
    sections.push({ project, templates: mine });
  }
  const rest = templates.filter((t) => !taken.has(t.id));
  if (rest.length > 0) sections.push({ project: null, templates: rest });
  return sections;
}

/**
 * The folders a template's editor offers as one-click picks: its project's links, plus whatever the
 * template already points at if that sits outside them (a folder can leave a project later, and the
 * template should still say where it runs).
 */
export function templateFolderChoices(
  template: { workingDirectory: string },
  project: Project | null
): string[] {
  const folders = project ? [...project.folders] : [];
  const dir = template.workingDirectory.trim();
  if (dir && !folders.some((f) => sameFolder(f, dir))) folders.push(dir);
  return folders;
}
