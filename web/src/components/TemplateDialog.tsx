import { useState } from "react";
import type { Project, SessionTemplate } from "@/types";
import { hasInputToken, templateFolderChoices } from "@/lib/templates";
import { sortedByName } from "@/lib/projects";
import { FolderPicker, FolderChips } from "./FolderPicker";
import { ProjectGlyph } from "./ProjectGlyph";
import { DEFAULT_LAUNCH, LaunchFields, launchFromTemplate, type LaunchOptions } from "./LaunchOptions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useConfirm } from "@/components/ui/confirm";
import { ChevronDown, ChevronRight, Loader2, Save, Trash2 } from "lucide-react";
import { useApi } from "@/lib/node";

/**
 * The editor for a session template — the thing a Templates-tab launch is made from: a project, a
 * folder, a prompt with a hole in it, and the launch settings that go with them.
 *
 * Unlike the project settings popup, which writes each change straight through, this one holds a
 * draft until Save. A template is a little form with a prompt in the middle of it; saving a prompt a
 * keystroke at a time would push a half-typed one to every other browser, and there is a real
 * "cancel" to want here that a project's name and colour never had.
 */
export function TemplateDialog({
  template,
  projects,
  defaultProjectId,
  defaultFolder,
  onSaved,
  onClose,
}: {
  /** The template to edit, or null to create one. */
  template: SessionTemplate | null;
  projects: Project[];
  /** Create mode: the project it starts in — the one whose settings it was opened from. */
  defaultProjectId?: string | null;
  /** Create mode: the folder it starts with. */
  defaultFolder?: string;
  /** The full template list, as returned by every mutation. */
  onSaved: (templates: SessionTemplate[]) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const confirm = useConfirm();
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [projectId, setProjectId] = useState(template?.projectId ?? defaultProjectId ?? "");
  const [dir, setDir] = useState(template?.workingDirectory ?? defaultFolder ?? "");
  const [prompt, setPrompt] = useState(template?.prompt ?? "");
  const [inputHint, setInputHint] = useState(template?.inputHint ?? "");
  const [launch, setLaunch] = useState<LaunchOptions>(
    template ? launchFromTemplate(template) : DEFAULT_LAUNCH
  );
  // The launch settings fold away: most templates are name + folder + prompt, and the four settings
  // under here are the ones you set once and never look at again.
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const project = projects.find((p) => p.id === projectId) ?? null;
  const folders = templateFolderChoices({ workingDirectory: dir }, project);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const patch = {
        name: name.trim(),
        // "" clears these server-side; leaving them out would mean "keep what you had".
        projectId: projectId || "",
        workingDirectory: dir.trim(),
        prompt: prompt.trim(),
        description: description.trim(),
        inputHint: inputHint.trim(),
        model: launch.model,
        remoteControl: launch.remoteControl,
        permissionMode: launch.permissionMode,
        watchdogEnabled: launch.watchdog,
      };
      onSaved(
        template ? await api.updateTemplate(template.id, patch) : await api.createTemplate(patch)
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the template");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!template) return;
    const ok = await confirm({
      title: `Delete “${template.name}”?`,
      description:
        "The template goes away. Sessions already started from it are untouched — a template is only " +
        "how a session was started, not something it stays attached to.",
      confirmLabel: "Delete template",
    });
    if (!ok) return;
    setBusy(true);
    try {
      onSaved(await api.deleteTemplate(template.id));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete the template");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      {/* Same shape as the project settings popup: a fixed head and footer with the fields scrolling
          between them, so a long prompt can't push Save off the bottom of the screen. */}
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] max-w-lg">
        <DialogHeader>
          <DialogTitle>{template ? "Template settings" : "New template"}</DialogTitle>
          <DialogDescription>
            A template starts the same kind of session again and again — same folder, same prompt —
            with only the detail you paste in changing.
          </DialogDescription>
        </DialogHeader>

        {/* -mx-1 px-1 buys the focus rings a gutter inside the scroller and gives it back, so nothing
            moves; without it a ring flush with the left edge is clipped clean off. */}
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-1">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                value={name}
                autoFocus={!template}
                placeholder="MH Log Issue"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="template-project">Project</Label>
              <select
                id="template-project"
                value={projectId}
                onChange={(e) => {
                  const next = e.target.value;
                  setProjectId(next);
                  // Moving the template to a project it has no folder from: fill in the obvious one
                  // when that project links exactly one, the way the New Session dialog does.
                  const p = projects.find((x) => x.id === next);
                  if (p && !dir.trim() && p.folders.length === 1) setDir(p.folders[0]);
                }}
                className="flex h-9 w-full rounded-md field-edge bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="" className="bg-popover text-popover-foreground">
                  No project
                </option>
                {sortedByName(projects).map((p) => (
                  <option key={p.id} value={p.id} className="bg-popover text-popover-foreground">
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="template-description">Description (optional)</Label>
            <Input
              id="template-description"
              value={description}
              placeholder="What this template is for — shown under its name in the picker"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label>Working folder</Label>
            <FolderPicker value={dir} onChange={setDir} />
            {project && (
              <FolderChips
                folders={folders}
                value={dir}
                onPick={setDir}
                label={
                  <>
                    <ProjectGlyph project={project} className="size-3" />
                    {project.name}
                  </>
                }
                empty="No folders linked to this project yet — choose one above."
              />
            )}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="template-prompt">Prompt</Label>
              <button
                type="button"
                onClick={() => setPrompt((p) => (p.trim() ? `${p.trimEnd()} {input}` : "{input}"))}
                className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Insert {"{input}"}
              </button>
            </div>
            <Textarea
              id="template-prompt"
              value={prompt}
              placeholder="e.g. /fix-issue {input} — or “investigate this error from the logs”"
              onChange={(e) => setPrompt(e.target.value)}
              className="min-h-28 font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {hasInputToken(prompt) ? (
                <>
                  What you type when starting a session goes where{" "}
                  <code className="font-mono">{"{input}"}</code> is.
                </>
              ) : (
                <>
                  Put <code className="font-mono">{"{input}"}</code> where the detail you paste in
                  should go — a Jira key inside a slash command, say. Without it, the detail is added
                  as a paragraph at the end.
                </>
              )}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="template-hint">Details box hint (optional)</Label>
            <Input
              id="template-hint"
              value={inputHint}
              placeholder="e.g. “Paste the error from the logs” or “Issue key or link”"
              onChange={(e) => setInputHint(e.target.value)}
            />
          </div>

          <div className="rounded-lg border">
            <button
              type="button"
              onClick={() => setShowSettings((v) => !v)}
              aria-expanded={showSettings}
              className="flex w-full items-center gap-1.5 px-3 py-2 text-sm font-medium hover:bg-accent/50"
            >
              {showSettings ? (
                <ChevronDown className="size-3.5" />
              ) : (
                <ChevronRight className="size-3.5" />
              )}
              Launch settings
              <span className="ml-auto truncate text-xs font-normal text-muted-foreground">
                {launchSummary(launch)}
              </span>
            </button>
            {showSettings && (
              <div className="space-y-4 border-t p-3">
                <LaunchFields value={launch} onChange={(p) => setLaunch((v) => ({ ...v, ...p }))} idPrefix="template" />
              </div>
            )}
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter className="sm:justify-between">
          {template ? (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={busy}
              onClick={() => void remove()}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              Delete
            </Button>
          ) : (
            <span />
          )}
          <span className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="sm" disabled={!name.trim() || busy} onClick={() => void save()}>
              {busy ? (
                <Loader2 className="mr-1.5 size-3.5 animate-spin" />
              ) : (
                <Save className="mr-1.5 size-3.5" />
              )}
              {template ? "Save" : "Create template"}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The folded-away launch settings in one line, so what is hidden is still legible. */
function launchSummary(l: LaunchOptions): string {
  const parts = [l.model ? l.model : "default model", l.permissionMode];
  if (!l.remoteControl) parts.push("no remote control");
  if (l.watchdog) parts.push("watchdog");
  return parts.join(" · ");
}
