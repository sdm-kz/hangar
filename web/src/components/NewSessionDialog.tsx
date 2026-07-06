import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { addRecentFolder, folderName, getRecentFolders, removeRecentFolder } from "@/lib/recentFolders";
import { addRecentSession, type RecentSession } from "@/lib/recentSessions";
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
  const [autoAccept, setAutoAccept] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);

  // Refresh the recent-folders list each time the dialog opens, and prefill from a preset if given.
  useEffect(() => {
    if (!open) return;
    setRecents(getRecentFolders());
    setError(null);
    if (preset) {
      setDir(preset.workingDirectory);
      setName(preset.name);
      setCommand(preset.command);
      setModel(preset.model);
      setRemoteControl(preset.remoteControl);
      setAutoAccept(preset.autoAccept);
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
        autoAccept,
      });
      addRecentFolder(dir.trim()); // remember folder for quick selection next time
      addRecentSession({
        workingDirectory: dir.trim(),
        name: name.trim(),
        command: command.trim(),
        model,
        remoteControl,
        autoAccept,
      });
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
                        onClick={() => {
                          removeRecentFolder(p);
                          setRecents(getRecentFolders());
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

          <label className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
            <Checkbox
              checked={autoAccept}
              onCheckedChange={(v) => setAutoAccept(v === true)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Zap className="size-3.5" /> Auto mode
              </div>
              <p className="text-xs text-muted-foreground">
                Start Claude with <code className="font-mono">--permission-mode acceptEdits</code> so it
                auto-accepts file edits without asking (the Shift+Tab “auto-accept edits” mode).
              </p>
            </div>
          </label>

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
