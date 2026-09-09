import { useState } from "react";
import type { Project, ProjectGroup } from "@/types";
import { api } from "@/lib/api";
import { COLOR_CHOICES, sessionColor } from "@/lib/sessionColors";
import { groupIcon } from "@/lib/groupIcons";
import { GroupAppearance } from "./GroupDialog";
import { folderName } from "@/lib/recentFolders";
import { sameFolder } from "@/lib/projects";
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
import { Ban, FolderPlus, Loader2, Plus, Trash2, X } from "lucide-react";

/**
 * A project's settings: its name, its accent colour, and the folders it links.
 *
 * Two modes. Editing an existing project writes each change straight through — the popup *is* the
 * project, so there is nothing to "apply" — except the name, which commits when the field is left or
 * Enter is pressed, so it isn't saved a keystroke at a time. Creating one holds everything locally
 * until the button, since there is no project to write to yet.
 */
export function ProjectDialog({
  project,
  initialFolders,
  initialGroup,
  onSaved,
  onClose,
}: {
  /** The project to edit, or null to create a new one. */
  project: Project | null;
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
  // Create mode only: the folders to link once the project exists.
  const [draftFolders, setDraftFolders] = useState<string[]>(initialFolders ?? []);
  const [picker, setPicker] = useState<string>("");
  // The virtual folder whose colour/icon editor is unfolded (one at a time — the grid is tall), and
  // the name being typed into the "new group" field.
  const [openGroup, setOpenGroup] = useState<string | null>(initialGroup ?? null);
  const [newGroup, setNewGroup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const folders = project ? project.folders : draftFolders;
  const accent = sessionColor(color);

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

  const addGroup = async () => {
    const next = newGroup.trim();
    if (!project || !next) return;
    if (await run(() => api.createProjectGroup(project.id, next))) setNewGroup("");
  };

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
    if (await run(() => api.createProject(name.trim(), color, draftFolders))) onClose();
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
            {accent && (
              <span
                className="size-3 shrink-0 rounded-full"
                style={{ backgroundColor: accent }}
                aria-hidden
              />
            )}
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
                  {project.groups.map((g) => {
                    const Icon = groupIcon(g.icon);
                    const tint = sessionColor(g.color);
                    const open = openGroup === g.id;
                    return (
                      <li key={g.id} className="rounded-md border">
                        <div className="flex items-center gap-2 px-2 py-1.5 text-sm">
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
                                void run(() =>
                                  api.updateProjectGroup(g.id, { icon: g.icon === next ? "" : next })
                                )
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
  );
}
