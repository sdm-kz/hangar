import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { folderName } from "@/lib/recentFolders";
import { type RecentSession } from "@/lib/recentSessions";
import type { SessionInfo } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { FolderPicker } from "./FolderPicker";
import { History, Loader2, Radio, X, Zap } from "lucide-react";

const MODELS = [
  { value: "", label: "Default" },
  { value: "opus", label: "Opus" },
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
];

// How much the session runs unattended. Auto is the default: it auto-approves routine work but
// still stops for genuinely destructive actions. Descriptions surface under the dropdown.
const PERMISSION_MODES = [
  {
    value: "auto",
    label: "Auto",
    hint: "Auto-approves routine actions (edits, most commands) but still asks before genuinely destructive ones like force-push or production deploys.",
  },
  {
    value: "default",
    label: "Ask each time",
    hint: "Claude asks permission for each action — approve them interactively from the Claude Code app.",
  },
  {
    value: "acceptEdits",
    label: "Accept edits",
    hint: "Auto-accepts file edits without asking, but still prompts for bash commands and other actions.",
  },
  {
    value: "bypassPermissions",
    label: "Bypass all (dangerous)",
    hint: "Runs fully unattended — bypasses ALL permission prompts (edits, bash, everything). Claude can run any command without asking.",
  },
];

export function NewSessionDialog({
  open,
  onOpenChange,
  onCreated,
  preset,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (s: SessionInfo) => void;
  /** When opened from the Recent tab, prefill the form with this preset. */
  preset?: RecentSession | null;
}) {
  const [dir, setDir] = useState("");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [model, setModel] = useState("");
  const [remoteControl, setRemoteControl] = useState(true);
  const [permissionMode, setPermissionMode] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);

  // Refresh the recent-folders list each time the dialog opens, and prefill from a preset if given.
  useEffect(() => {
    if (!open) return;
    api.getRecents().then((r) => setRecents(r.folders)).catch(() => {});
    setError(null);
    if (preset) {
      setDir(preset.workingDirectory);
      setName(preset.name);
      setCommand(preset.command);
      setModel(preset.model);
      setRemoteControl(preset.remoteControl);
      setPermissionMode(preset.permissionMode || "auto");
    }
  }, [open, preset]);

  async function create() {
    if (!dir.trim()) {
      setError("Choose a working folder");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await api.createSession({
        workingDirectory: dir.trim(),
        name: name.trim() || null,
        remoteControl,
        model: model || null,
        initialPrompt: command.trim() || null,
        permissionMode,
      });
      // Remember the folder + full launch preset server-side for quick reuse next time. Both are
      // fire-and-forget: a failure here shouldn't block the (already created) session.
      await api.addRecentFolder(dir.trim()).catch(() => {});
      await api
        .addRecentSession({
          workingDirectory: dir.trim(),
          name: name.trim(),
          command: command.trim(),
          model,
          remoteControl,
          permissionMode,
        })
        .catch(() => {});
      onCreated(s);
      // Reset the transient fields for next time.
      setName("");
      setCommand("");
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to create session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>Start a Claude Code session in a working folder.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Working folder</Label>
            <FolderPicker value={dir} onChange={setDir} />

            {recents.length > 0 && (
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <History className="size-3" /> Recent
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {recents.map((p) => (
                    <span
                      key={p}
                      className="group flex max-w-full items-center gap-1 rounded-md border pl-2 pr-1 py-1 text-xs hover:bg-accent"
                    >
                      <button
                        type="button"
                        onClick={() => setDir(p)}
                        title={p}
                        className="truncate"
                      >
                        {folderName(p)}
                      </button>
                      <button
                        type="button"
                        title="Remove from recent"
                        onClick={async () => {
                          const r = await api.removeRecentFolder(p).catch(() => null);
                          if (r) setRecents(r.folders);
                        }}
                        className="shrink-0 text-muted-foreground opacity-60 hover:text-destructive hover:opacity-100"
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="name">Name (optional)</Label>
              <Input
                id="name"
                value={name}
                placeholder="Folder name"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="model">Model</Label>
              <select
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="command">Start command (optional)</Label>
            <Textarea
              id="command"
              value={command}
              placeholder="Initial prompt sent to Claude on startup, e.g. “run the tests and fix any failures”"
              onChange={(e) => setCommand(e.target.value)}
              className="min-h-20"
            />
          </div>

          <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
            <Checkbox
              checked={remoteControl}
              onCheckedChange={(v) => setRemoteControl(v === true)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Radio className="size-3.5" /> Remote control
              </div>
              <p className="text-xs text-muted-foreground">
                Start Claude with <code className="font-mono">--remote-control</code> so this session appears in
                the Claude Code app (claude.ai/code &amp; mobile) and you control it from there.
              </p>
            </div>
          </label>

          <div className="space-y-2 rounded-lg border p-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <Zap className="size-3.5" /> Permission mode
            </div>
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {PERMISSION_MODES.map((m) => (
                <option key={m.value} value={m.value} className="bg-popover text-popover-foreground">
                  {m.label}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {PERMISSION_MODES.find((m) => m.value === permissionMode)?.hint}
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={create} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
