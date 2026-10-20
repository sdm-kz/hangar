import { useEffect, useRef, useState } from "react";
import type { Project, ProjectGroup, RemoteConnection, SessionTemplate } from "@/types";
import { COLOR_CHOICES, sessionColor } from "@/lib/sessionColors";
import { DEFAULT_PROJECT_ICON_NAME, GROUP_ICONS, groupIcon, projectIcon } from "@/lib/groupIcons";
import { GroupAppearance, IconPicker } from "./GroupDialog";
import { TemplateDialog } from "./TemplateDialog";
import { RemoteConnectionDialog } from "./RemoteConnect";
import { connectionTarget } from "@/lib/sessionRemotes";
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
  FolderOpen,
  FolderPlus,
  FolderTree,
  GripVertical,
  Library,
  Loader2,
  Pencil,
  Plus,
  Server,
  Settings2,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useApi } from "@/lib/node";

/** The settings popup's tabs, down its left edge. */
type ProjectTab = "general" | "folders" | "repos" | "groups" | "templates" | "connections";

/** Tailwind's `sm`: where the tabs become a column. */
const TABS_VERTICAL_QUERY = "(min-width: 640px)";

/**
 * A project's settings: its name, its accent colour and icon, and the folders and repos it links.
 * Laid out as tabs down the left — General, Folders, Repositories, Groups, Templates — with the chosen
 * one's panel on the right, so each list gets the dialog's whole height instead of a slice of one
 * long scroll.
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
  const api = useApi();
  const confirm = useConfirm();
  const [name, setName] = useState(project?.name ?? "");
  const [color, setColor] = useState<string | null>(project?.color ?? null);
  // Null is "the default" (Boxes), which is also what every project had before icons were a choice.
  const [icon, setIcon] = useState<string | null>(project?.icon ?? null);
  // Opened on Groups when it was opened for a group (the pencil on a group's sidebar header).
  const [tab, setTab] = useState<ProjectTab>(initialGroup ? "groups" : "general");
  // Whether the tabs are a column (sm and up) or run across the top — only what the tablist tells a
  // screen reader about its axis; the arrow keys take either.
  const [tabsVertical, setTabsVertical] = useState(() => window.matchMedia(TABS_VERTICAL_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(TABS_VERTICAL_QUERY);
    const on = () => setTabsVertical(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  // A new project's name field takes focus once, when the dialog opens — not every time General is
  // shown again, which would pull focus out of the tab list mid-way through arrowing along it.
  const nameFocusedRef = useRef(false);
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

  // SSH connections saved with the project: edited in a dialog stacked over this one.
  const [editingConnection, setEditingConnection] = useState<{ connection: RemoteConnection | null } | null>(null);
  const saveConnection = (c: RemoteConnection) =>
    project ? run(() => api.saveProjectConnection(project.id, c)) : Promise.resolve(false);
  const removeConnection = async (c: RemoteConnection) => {
    if (!project) return;
    const ok = await confirm({
      title: `Forget ${c.name || connectionTarget(c)}?`,
      description: "The saved parameters go; tabs already open with it stay open.",
      confirmLabel: "Forget",
    });
    if (ok) await run(() => api.deleteProjectConnection(project.id, c.id));
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

  // The tabs on offer. Only General and Folders in create mode: repos, groups and templates are all
  // made against the project's id, which doesn't exist until the button at the bottom is pressed.
  const tabs: { id: ProjectTab; label: string; Icon: LucideIcon; count?: number }[] = [
    { id: "general", label: "General", Icon: Settings2 },
    { id: "folders", label: "Folders", Icon: FolderOpen, count: folders.length },
    ...(project
      ? [
          { id: "repos" as const, label: "Repositories", Icon: Library, count: project.repos.length },
          { id: "groups" as const, label: "Groups", Icon: FolderTree, count: project.groups.length },
          { id: "templates" as const, label: "Templates", Icon: Sparkles, count: myTemplates.length },
          { id: "connections" as const, label: "Connections", Icon: Server, count: project.connections?.length ?? 0 },
        ]
      : []),
  ];

  // Up/Down (Left/Right on a phone, where the list runs across the top) move between tabs, as a
  // tablist does; Home/End jump to the ends.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === tab);
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    let next = i;
    if (step) next = (i + step + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    setTab(tabs[next].id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
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
      {/* One fixed height, whichever tab is showing: a dialog that resizes as you click down its
          tabs makes the tab list jump out from under the pointer. Capped to the viewport, so the
          heading and the Delete/Done row stay on screen however long a list gets -- the panel on the
          right is what scrolls. */}
      <DialogContent className="h-[min(38rem,calc(100dvh-2rem))] max-w-3xl grid-rows-[auto_minmax(0,1fr)_auto]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {/* The project as the sidebar will draw it: its icon, in its colour. */}
            <ProjectIcon
              className="size-4 shrink-0"
              style={accent ? { color: accent } : undefined}
              aria-hidden
            />
            <span className="truncate">
              {project ? project.name : "New project"}
            </span>
          </DialogTitle>
          <DialogDescription>
            {project
              ? "Project settings — changes save as you make them."
              : "Name it, link the folders it covers, and create it."}
          </DialogDescription>
        </DialogHeader>

        {/* Tabs down the left, the chosen one's panel on the right. On a phone there is no room
            for a column, so the tabs run across the top instead and scroll sideways -- with the
            scrollbar hidden, since a classic Windows bar under five words is most of the strip. */}
        <div className="flex min-h-0 flex-col gap-3 sm:flex-row sm:gap-4">
          <div
            role="tablist"
            aria-orientation={tabsVertical ? "vertical" : "horizontal"}
            aria-label="Project settings"
            onKeyDown={onTabKey}
            className="-m-1 flex shrink-0 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:m-0 sm:w-44 sm:flex-col sm:overflow-visible sm:border-r sm:p-0 sm:pr-3"
          >
            {tabs.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`project-tab-${t.id}`}
                  aria-selected={active}
                  aria-controls={`project-panel-${t.id}`}
                  tabIndex={active ? 0 : -1}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                    active
                      ? "bg-accent font-medium text-foreground"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                  )}
                >
                  <t.Icon className="size-4 shrink-0" />
                  <span className="truncate sm:flex-1">{t.label}</span>
                  {t.count !== undefined && t.count > 0 && (
                    <span className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                      {t.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* -mx-1 px-1 is not spacing: a scroller clips on both axes, and a control whose edge
              is flush with this box loses whatever it paints *outside* itself there -- which is
              its focus ring, cut clean off down the left while the rest of it draws. The padding
              buys the ring a gutter and the negative margin gives it back, so nothing moves. */}
          <div
            role="tabpanel"
            id={`project-panel-${tab}`}
            aria-labelledby={`project-tab-${tab}`}
            className="-mx-1 flex min-h-0 min-w-0 flex-1 flex-col gap-4 px-1"
          >
            {tab === "general" && (
              <div className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain p-1">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="project-name">Name</Label>
                  <Input
                    id="project-name"
                    value={name}
                    autoFocus={!project && !nameFocusedRef.current}
                    onFocus={() => {
                      nameFocusedRef.current = true;
                    }}
                    placeholder="Hangar"
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

                {/* With a panel of its own to sit in, the grid no longer hides behind a fold. */}
                <div className="flex flex-col gap-1.5">
                  <Label className="flex items-center gap-2">
                    Icon
                    <span className="font-normal text-muted-foreground">{iconLabel}</span>
                  </Label>
                  <IconPicker
                    icon={icon}
                    defaultName={DEFAULT_PROJECT_ICON_NAME}
                    tint={accent}
                    onIcon={pickIcon}
                    className="rounded-md border p-1.5"
                  />
                </div>
              </div>
            )}

            {tab === "folders" && (
              <>
                <p className="shrink-0 text-xs text-muted-foreground">
                  The folders this project covers. Linking a folder also takes in everything under it,
                  so new subfolders and the sessions started there join on their own.
                </p>
                {folders.length === 0 ? (
                  <p className="shrink-0 rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                    No folders yet. Add one below, or drag a folder group onto this project in the
                    sessions list.
                  </p>
                ) : (
                  <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
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
                {/* Under the list and outside its scroll, so linking the thirteenth folder does not
                    start with a hunt for the field. */}
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
              </>
            )}

            {/* A project is a piece of work rather than a checkout, and the work usually spans more
                repos than its folders point at — so a repo named once is in the PR picker of every
                session under the project, whether or not it is checked out anywhere. */}
            {tab === "repos" && project && (
              <>
                <p className="shrink-0 text-xs text-muted-foreground">
                  Repositories every session in this project can review pull requests from, checked
                  out or not.
                </p>
                {project.repos.length === 0 ? (
                  <p className="shrink-0 rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                    No repositories yet.
                  </p>
                ) : (
                  <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
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
                <div className="flex shrink-0 flex-col gap-1.5">
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
              </>
            )}

            {tab === "groups" && project && (
              <>
                <p className="shrink-0 text-xs text-muted-foreground">
                  Virtual folders inside this project. Drag a session onto one in the sidebar to file it
                  there — the sessions in a box don’t have to share a folder, which is the whole point.
                </p>
                {project.groups.length > 0 && (
                  <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                    {project.groups.map((g, i) => {
                      const Icon = groupIcon(g.icon);
                      const tint = sessionColor(g.color);
                      const open = openGroup === g.id;
                      return (
                        <li
                          key={g.id}
                          {...groupDnd.targetProps(i)}
                          className="relative shrink-0 rounded-md border"
                        >
                          {/* Where a dragged group would land: a line at the top of the row it lands
                              on, as in the sidebar — the order set here is the order the boxes are
                              drawn in there. On the row's own top edge rather than in the gap above
                              it, because this list scrolls: a line one pixel outside the first row
                              would be clipped away by the scroller, and "move it to the top" is the
                              drop that most needs to show where it is going. */}
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
                            {/* Committed on blur or Enter, like the project's own name: a rename is
                                one decision, not one per keystroke. */}
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
              </>
            )}

            {/* Session templates: the ways this project's sessions get started. */}
            {tab === "templates" && project && (
              <>
                <div className="flex shrink-0 items-start justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    A saved way to start a session in this project — a folder and a prompt with a hole
                    in it. Pick one on the New Session dialog’s Templates tab and paste in what that run
                    is about.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => setEditingTemplate({ template: null })}
                  >
                    <Plus className="mr-1 size-3.5" /> New template
                  </Button>
                </div>
                {myTemplates.length === 0 ? (
                  <p className="shrink-0 rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                    No templates yet.
                  </p>
                ) : (
                  <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                    {myTemplates.map((t) => (
                      <li key={t.id} className="shrink-0 rounded-md border">
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
              </>
            )}

            {/* SSH connections, offered by the "+" of a session's tab bar under Remote files. */}
            {tab === "connections" && project && (
              <>
                <div className="flex shrink-0 items-start justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    SSH hosts this project’s sessions open as remote files tabs — from the “+” at the end
                    of a session’s tab bar. Saved without passwords or passphrases.
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 shrink-0 px-2 text-xs"
                    onClick={() => setEditingConnection({ connection: null })}
                  >
                    <Plus className="mr-1 size-3.5" /> New connection
                  </Button>
                </div>
                {(project.connections?.length ?? 0) === 0 ? (
                  <p className="shrink-0 rounded-md border border-dashed px-3 py-3 text-center text-xs text-muted-foreground">
                    No connections yet.
                  </p>
                ) : (
                  <ul className="-mx-1 flex min-h-0 flex-col gap-1 overflow-y-auto overscroll-contain px-1">
                    {project.connections!.map((c) => (
                      <li key={c.id} className="flex shrink-0 items-center gap-1 rounded-md border pr-1">
                        <button
                          type="button"
                          onClick={() => setEditingConnection({ connection: c })}
                          className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent/50"
                        >
                          <Server className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{c.name || connectionTarget(c)}</span>
                            <span className="block truncate font-mono text-[10px] text-muted-foreground">
                              {connectionTarget(c)} · {c.auth === "key" ? "key file" : c.auth === "agent" ? "ssh agent" : "password"}
                              {c.startPath ? ` · ${c.startPath}` : ""}
                            </span>
                          </span>
                          <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void removeConnection(c)}
                          title="Forget this connection"
                          className="shrink-0 p-1 text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-4" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}

            {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}
          </div>
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

    {editingConnection && project && (
      <RemoteConnectionDialog
        connection={editingConnection.connection}
        onSave={saveConnection}
        onClose={() => setEditingConnection(null)}
      />
    )}

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
