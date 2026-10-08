import { useEffect, useState } from "react";
import type { Project, ProjectGroup, SessionTemplate } from "@/types";
import { api } from "@/lib/api";
import { COLOR_CHOICES, sessionColor } from "@/lib/sessionColors";
import { DEFAULT_PROJECT_ICON_NAME, GROUP_ICONS, groupIcon, projectIcon } from "@/lib/groupIcons";
import { GroupAppearance, IconPicker } from "./GroupDialog";
import { TemplateDialog } from "./TemplateDialog";
import { folderName } from "@/lib/recentFolders";
import { groupIdsAfterMove, sameFolder } from "@/lib/projects";
import { cleanRepoName, invalidateSessionRepos } from "@/lib/sessionRepos";
import { useDragReorder } from "@/lib/useDragReorder";
import { FolderPicker } from "./FolderPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { cn } from "@/lib/utils";
import {
  Ban,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  GripVertical,
  Library,
  Loader2,
  Pencil,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";

/**
 * A project's settings: its name, its accent colour and icon, and the folders and repos it links.
 *
 * Two modes. Editing an existing project writes each change straight through — the popup *is* the
 * project, so there is nothing to "apply" — except the name, which commits when the field is left or
 * Enter is pressed, so it isn't saved a keystroke at a time. Creating one holds everything locally
 * until the button, since there is no project to write to yet.
 */
export function ProjectDialog({
  project,
  projects,
  initialFolders,
  initialGroup,
  onSaved,
  onClose,
}: {
  /** The project to edit, or null to create a new one. */
  project: Project | null;
  /** Every project — the template editor's project dropdown offers them all, so a template can be
      moved out of this one from here. Defaults to just this project when the caller has no list. */
  projects?: Project[];
  /** Create mode: folders the new project starts with — the one it was created from. */
  initialFolders?: string[];
  /** Open with this group's colour/icon editor already unfolded — the pencil on its sidebar header. */
  initialGroup?: string;
  /** The full project list, as returned by every mutation. */
  onSaved: (projects: Project[]) => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState<string | null>(project?.color ?? null);
  // Null is "the default" (Boxes), which is also what every project had before icons were a choice.
  const [icon, setIcon] = useState<string | null>(project?.icon ?? null);
  // The icon grid is tall and usually left alone, so it stays folded behind the row showing the pick.
  const [iconsOpen, setIconsOpen] = useState(false);
  // Create mode only: the folders to link once the project exists.
  const [draftFolders, setDraftFolders] = useState<string[]>(initialFolders ?? []);
  const [picker, setPicker] = useState<string>("");
  // The repo being typed into the "link a repository" field, and why the last one was refused.
  const [newRepo, setNewRepo] = useState("");
  const [repoError, setRepoError] = useState<string | null>(null);
  // The virtual folder whose colour/icon editor is unfolded (one at a time — the grid is tall), and
  // the name being typed into the "new group" field.
  const [openGroup, setOpenGroup] = useState<string | null>(initialGroup ?? null);
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // This project's session templates. Read here rather than handed in: the popup is the only place
  // that shows them, and they are edited from the New Session dialog too, so a list cached higher up
  // would be a second copy to keep in step.
  const [templates, setTemplates] = useState<SessionTemplate[]>([]);
  // The template being edited, or { template: null } while one is being created.
  const [editingTemplate, setEditingTemplate] = useState<{ template: SessionTemplate | null } | null>(null);

  useEffect(() => {
    if (!project) return; // create mode: a template is written against a project id that doesn't exist yet
    api.getTemplates().then(setTemplates).catch(() => {});
  }, [project?.id]);

  const folders = project ? project.folders : draftFolders;
  const myTemplates = project ? templates.filter((t) => t.projectId === project.id) : [];
  const accent = sessionColor(color);
  const ProjectIcon = projectIcon(icon);
  // What the Icon row calls the pick: the default by that name, and an unknown stored name (a newer
  // client's, a hand-edited file's) as the default it draws as, rather than as a word nothing matches.
  const iconLabel =
    icon && icon !== DEFAULT_PROJECT_ICON_NAME && GROUP_ICONS.some((i) => i.name === icon) ? icon : "Default";

  // Every mutation answers with the whole list; a failure keeps the popup open and says why, since
  // the alternative — closing on an error — loses whatever the user had typed.
  const run = async (call: () => Promise<Project[]>) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await call());
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const commitName = () => {
    const next = name.trim();
    if (!project || !next || next === project.name) {
      if (project && !next) setName(project.name); // a blank name is a slip; put the old one back
      return;
    }
    void run(() => api.updateProject(project.id, { name: next }));
  };

  const pickColor = (next: string | null) => {
    setColor(next);
    // "" clears the accent server-side; null there would mean "leave it as it was".
    if (project) void run(() => api.updateProject(project.id, { color: next ?? "" }));
  };

  const pickIcon = (next: string | null) => {
    setIcon(next);
    // "" goes back to the default server-side; null there would mean "leave it as it was".
    if (project) void run(() => api.updateProject(project.id, { icon: next ?? "" }));
  };

  const addFolder = async () => {
    const path = picker.trim();
    if (!path) return;
    if (project) {
      if (await run(() => api.addProjectFolder(project.id, path))) setPicker("");
      return;
    }
    // Create mode: the server hasn't seen this project yet, so dedupe here.
    setDraftFolders((prev) => (prev.some((f) => sameFolder(f, path)) ? prev : [...prev, path]));
    setPicker("");
  };

  const removeFolder = (path: string) => {
    if (project) void run(() => api.removeProjectFolder(project.id, path));
    else setDraftFolders((prev) => prev.filter((f) => !sameFolder(f, path)));
  };

  // A project's repos are in the review list of every session under it, and the lists already
  // fetched have no way of knowing one changed — so they are dropped and asked for again.
  const addRepo = async () => {
    if (!project) return;
    const clean = cleanRepoName(newRepo);
    if (!clean) {
      setRepoError("Give it as owner/name, or paste the repository's GitHub URL.");
      return;
    }
    setRepoError(null);
    if (await run(() => api.addProjectRepo(project.id, clean))) {
      setNewRepo("");
      invalidateSessionRepos();
    }
  };

  const removeRepo = async (repo: string) => {
    if (!project) return;
    if (await run(() => api.removeProjectRepo(project.id, repo))) invalidateSessionRepos();
  };

  const addGroup = async () => {
    const next = newGroup.trim();
    if (!project || !next) return;
    if (await run(() => api.createProjectGroup(project.id, next))) setNewGroup("");
  };

  /**
   * Arrange the groups by dragging one past another, through the same helper the sidebar drops
   * through — nothing is hidden here, so every group is its own visible slot.
   */
  const reorderGroups = (from: number, to: number) => {
    if (!project) return;
    const ids = project.groups.map((g) => g.id);
    void run(() => api.reorderProjectGroups(project.id, groupIdsAfterMove(project.groups, ids, from, to)));
  };

  // The grip is the only thing that grabs: the row is mostly a text field, and a draggable row would
  // fight the mouse every time a name is selected in it.
  const groupDnd = useDragReorder(reorderGroups);

  const removeGroup = async (group: ProjectGroup) => {
    const ok = await confirm({
      title: `Delete “${group.name}”?`,
      description:
        "The group goes away; the sessions in it don’t — they go back to showing under the folder " +
        "they run in.",
      confirmLabel: "Delete group",
    });
    if (!ok) return;
    void run(() => api.deleteProjectGroup(group.id));
  };

  const create = async () => {
    if (!name.trim()) return;
    if (await run(() => api.createProject(name.trim(), color, draftFolders, icon))) onClose();
  };

  const remove = async () => {
    if (!project) return;
    const ok = await confirm({
      title: `Delete “${project.name}”?`,
      description:
        "The project and its folder links go away. Sessions and folders themselves are untouched — " +
        "their groups move back out to the bottom of the list.",
      confirmLabel: "Delete project",
    });
    if (!ok) return;
    if (await run(() => api.deleteProject(project.id))) onClose();
  };

  return (
    <>
    <Dialog
      open
      onOpenChange={(o) => {
        if (o) return;
        commitName(); // closing with an edited name still saves it
        onClose();
      }}
    >
      {/* The popup grows with the project: a dozen linked folders and a list of groups is taller
          than a laptop screen, and the dialog is centred, so without a cap it runs off both ends at
          once — the title above the top edge, the Delete/Done row below the bottom. Cap it to the
          viewport and give the middle its own scroll, so the heading stays put and the buttons stay
          reachable however long the lists get. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {/* The project as the sidebar will draw it: its icon, in its colour. */}
            <ProjectIcon
              className="size-4 shrink-0"
              style={accent ? { color: accent } : undefined}
              aria-hidden
            />
            {project ? "Project settings" : "New project"}
          </DialogTitle>
          <DialogDescription>
            A project groups the folders you work in. Linking a folder also takes in everything under
            it, so new subfolders and the sessions started there join on their own.
          </DialogDescription>
        </DialogHeader>

        {/* Only the two lists scroll. Scrolling the whole body meant the name, the colour and
            both "add" rows slid away with it, so linking a second folder to a project that already
            has twelve started with a hunt for the field. The lists take what height is left, in
            proportion to how much each one has to show. */}
        {/* -mx-1 px-1 is not spacing: a scroller clips on both axes, and a control whose edge
              is flush with this box loses whatever it paints *outside* itself there -- which is
              its focus ring, cut clean off down the left while the rest of it draws. The padding
              buys the ring a gutter and the negative margin gives it back, so nothing moves. */}
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              value={name}
              autoFocus={!project}
              placeholder="Homeport"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (project) commitName();
                  else void create();
                }
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Colour</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {COLOR_CHOICES.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  title={c.name}
                  aria-label={c.name}
                  aria-pressed={color === c.name}
                  onClick={() => pickColor(c.name)}
                  className={cn(
                    "size-6 rounded-full border-2 transition-transform hover:scale-110",
                    color === c.name ? "border-foreground" : "border-transparent"
                  )}
                  style={{ backgroundColor: c.css }}
                />
              ))}
              <button
                type="button"
                title="No colour"
                aria-label="No colour"
                aria-pressed={color === null}
                onClick={() => pickColor(null)}
                className={cn(
                  "flex size-6 items-center justify-center rounded-full border-2 text-muted-foreground transition-transform hover:scale-110",
                  color === null ? "border-foreground" : "border-border"
                )}
              >
                <Ban className="size-3.5" />
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Icon</Label>
            <button
              type="button"
              onClick={() => setIconsOpen((v) => !v)}
              aria-expanded={iconsOpen}
              className="flex w-fit items-center gap-2 rounded border px-2 py-1 text-sm hover:bg-accent"
            >
              <ProjectIcon className="size-4" style={accent ? { color: accent } : undefined} />
              <span className="text-muted-foreground">{iconLabel}</span>
              {iconsOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            </button>
            {iconsOpen && (
              <IconPicker
                icon={icon}
                defaultName={DEFAULT_PROJECT_ICON_NAME}
                tint={accent}
                onIcon={pickIcon}
                className="rounded border p-1.5"
              />
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Linked folders</Label>
            {folders.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                No folders yet. Add one below, or drag a folder group onto this project in the
                sessions list.
              </p>
            ) : (
              <ul className="-mx-1 flex max-h-56 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                {folders.map((f) => (
                  <li
                    key={f}
                    className="group flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{folderName(f)}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {f}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => removeFolder(f)}
                      title="Unlink this folder"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex shrink-0 items-start gap-2">
              <div className="min-w-0 flex-1">
                <FolderPicker value={picker} onChange={setPicker} />
              </div>
              <Button
                type="button"
                variant="outline"
                size="icon"
                title="Link this folder"
                disabled={!picker.trim() || busy}
                onClick={() => void addFolder()}
              >
                <Plus className="size-4" />
              </Button>
            </div>
          </div>

          {/* The repos this project's sessions can review. Only once the project exists, for the
              same reason the groups below are: a draft list would be a second way to add one.

              A project is a piece of work rather than a checkout, and the work usually spans more
              repos than the folders here point at — so a repo named once is in the PR picker of
              every session under the project, whether or not it is checked out anywhere. */}
          {project && (
            <div className="flex flex-col gap-1.5">
              <Label>Linked repositories</Label>
              {project.repos.length === 0 ? (
                <p className="rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                  No repositories yet. One linked here can be reviewed from every session in this
                  project, checked out or not.
                </p>
              ) : (
                <ul className="-mx-1 flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                  {project.repos.map((r) => (
                    <li
                      key={r}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                    >
                      <Library className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">{r}</span>
                      <button
                        type="button"
                        onClick={() => void removeRepo(r)}
                        title="Unlink this repository"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                      >
                        <X className="size-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="flex items-start gap-2">
                <Input
                  value={newRepo}
                  onChange={(e) => {
                    setNewRepo(e.target.value);
                    setRepoError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void addRepo();
                    }
                  }}
                  placeholder="owner/name, or a link to the repository on GitHub"
                  className="min-w-0 flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title="Link this repository"
                  disabled={!newRepo.trim() || busy}
                  onClick={() => void addRepo()}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
              {repoError && <p className="text-xs text-destructive">{repoError}</p>}
            </div>
          )}

          {/* Virtual folders. Only once the project exists: a group is created against its id, and a
              draft list here would be a second way to make one that behaves subtly differently. */}
          {project && (
            <div className="flex flex-col gap-1.5">
              <Label>Groups</Label>
              <p className="text-xs text-muted-foreground">
                Virtual folders inside this project. Drag a session onto one in the sidebar to file it
                there — the sessions in a box don’t have to share a folder, which is the whole point.
              </p>
              {project.groups.length > 0 && (
                <ul className="-mx-1 flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                  {project.groups.map((g, i) => {
                    const Icon = groupIcon(g.icon);
                    const tint = sessionColor(g.color);
                    const open = openGroup === g.id;
                    return (
                      <li
                        key={g.id}
                        {...groupDnd.targetProps(i)}
                        className="relative rounded-md border"
                      >
                        {/* Where a dragged group would land: a line at the top of the row it lands
                            on, as in the sidebar — the order set here is the order the boxes are
                            drawn in there. On the row's own top edge rather than in the gap above it,
                            because this list scrolls: a line one pixel outside the first row would be
                            clipped away by the scroller, and "move it to the top" is the drop that
                            most needs to show where it is going. */}
                        {groupDnd.isOver(i) && (
                          <span className="pointer-events-none absolute inset-x-1 top-0 h-0.5 rounded-full bg-primary" />
                        )}
                        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
                          <span
                            {...groupDnd.handleProps(i)}
                            title="Drag to reorder"
                            className="-ml-1 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing hover:text-foreground"
                          >
                            <GripVertical className="size-4" />
                          </span>
                          <button
                            type="button"
                            onClick={() => setOpenGroup(open ? null : g.id)}
                            title="Colour and icon"
                            aria-expanded={open}
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            style={tint ? { color: tint } : undefined}
                          >
                            <Icon className="size-4" />
                          </button>
                          {/* Committed on blur or Enter, like the project's own name above: a rename
                              is one decision, not one per keystroke. */}
                          <Input
                            defaultValue={g.name}
                            className="h-7 min-w-0 flex-1 border-transparent px-1 shadow-none hover:border-input focus-visible:border-input"
                            onBlur={(e) => {
                              const next = e.target.value.trim();
                              if (!next) e.target.value = g.name; // a blank name is a slip
                              else if (next !== g.name)
                                void run(() => api.updateProjectGroup(g.id, { name: next }));
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") e.currentTarget.blur();
                              if (e.key === "Escape") {
                                e.currentTarget.value = g.name;
                                e.currentTarget.blur();
                              }
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => void removeGroup(g)}
                            title="Delete this group"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                          >
                            <X className="size-4" />
                          </button>
                        </div>
                        {open && (
                          <div className="border-t px-2 py-2">
                            <GroupAppearance
                              color={g.color}
                              icon={g.icon}
                              onColor={(next) =>
                                void run(() => api.updateProjectGroup(g.id, { color: next ?? "" }))
                              }
                              onIcon={(next) =>
                                void run(() => api.updateProjectGroup(g.id, { icon: next ?? "" }))
                              }
                            />
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="flex shrink-0 items-center gap-2">
                <Input
                  value={newGroup}
                  placeholder="New group — “Release 2.4”, “Bugs”, “Spikes”"
                  onChange={(e) => setNewGroup(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    void addGroup();
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  title="Add this group"
                  disabled={!newGroup.trim() || busy}
                  onClick={() => void addGroup()}
                >
                  <Plus className="size-4" />
                </Button>
              </div>
            </div>
          )}

          {/* Session templates: the ways this project's sessions get started. Like the groups above,
              only once the project exists — a template names the project it belongs to. */}
          {project && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <Label>Templates</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => setEditingTemplate({ template: null })}
                >
                  <Plus className="mr-1 size-3.5" /> New template
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                A saved way to start a session in this project — a folder and a prompt with a hole in
                it. Pick one on the New Session dialog’s Templates tab and paste in what that run is
                about.
              </p>
              {myTemplates.length > 0 && (
                <ul className="-mx-1 flex max-h-40 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                  {myTemplates.map((t) => (
                    <li key={t.id} className="rounded-md border">
                      <button
                        type="button"
                        onClick={() => setEditingTemplate({ template: t })}
                        className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                      >
                        <Sparkles className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{t.name}</span>
                          <span className="block truncate text-[10px] text-muted-foreground">
                            {t.description ?? t.prompt}
                          </span>
                        </span>
                        <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="sm:justify-between">
          {project ? (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => void remove()}>
              <Trash2 className="mr-1.5 size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {project ? "Done" : "Cancel"}
            </Button>
            {!project && (
              <Button size="sm" disabled={!name.trim() || busy} onClick={() => void create()}>
                {busy ? (
                  <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                ) : (
                  <FolderPlus className="mr-1.5 size-3.5" />
                )}
                Create project
              </Button>
            )}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Stacked over this popup, the way the confirm dialog is. New templates land in this project. */}
    {editingTemplate && project && (
      <TemplateDialog
        template={editingTemplate.template}
        projects={projects ?? [project]}
        defaultProjectId={project.id}
        defaultFolder={project.folders[0] ?? ""}
        onSaved={setTemplates}
        onClose={() => setEditingTemplate(null)}
      />
    )}
    </>
  );
}
