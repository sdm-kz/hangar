import { useState } from "react";
import type { Project } from "@/types";
import { api } from "@/lib/api";
import { COLOR_CHOICES, sessionColor } from "@/lib/sessionColors";
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
  onSaved,
  onClose,
}: {
  /** The project to edit, or null to create a new one. */
  project: Project | null;
  /** Create mode: folders the new project starts with — the one it was created from. */
  initialFolders?: string[];
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
      <DialogContent className="max-w-md">
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

        <div className="flex flex-col gap-4">
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
              <ul className="flex flex-col gap-1">
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
            <div className="flex items-start gap-2">
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
