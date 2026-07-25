import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { folderName } from "@/lib/recentFolders";
import { sameRecent, type RecentSession } from "@/lib/recentSessions";
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
import { Activity, History, Loader2, Radio, RotateCcw, X, Zap } from "lucide-react";

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
  const [watchdog, setWatchdog] = useState(false); // hang watchdog — off by default
  const [continueSession, setContinueSession] = useState(false); // resume the folder's last conversation

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recents, setRecents] = useState<string[]>([]);
  // The preset as the server currently has it. The one we're handed came from the session list's last
  // load, which may predate the server stamping a conversation id onto it (that happens once Claude's
  // first hook arrives, seconds after launch).
  const [stored, setStored] = useState<RecentSession | null>(null);

  // The exact conversation "continue" will resume, when the server has stamped one onto this preset.
  // Tied to the folder: point the form somewhere else and the id no longer applies, so we fall back to
  // plain --continue (the folder's most recent conversation).
  const presetId = stored?.claudeSessionId ?? preset?.claudeSessionId ?? null;
  const resumeId = presetId && preset?.workingDirectory === dir.trim() ? presetId : null;

  // Refresh the recent-folders list each time the dialog opens, and prefill from a preset if given.
  useEffect(() => {
    if (!open) return;
    api
      .getRecents()
      .then((r) => {
        setRecents(r.folders);
        setStored(preset ? r.sessions.find((s) => sameRecent(s, preset)) ?? null : null);
      })
      .catch(() => {});
    setError(null);
    setStored(null); // until the refresh above lands
    setWatchdog(false); // always default the watchdog off, even when prefilling from a preset
    // Relaunching a remembered preset almost always means picking the work back up, so default to
    // continuing its conversation; a plain "New session" starts fresh.
    setContinueSession(!!preset);
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
        watchdogEnabled: watchdog,
        continue: continueSession,
        resumeSessionId: continueSession ? resumeId : null,
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
      <DialogContent
        className="flex max-h-[90vh] flex-col"
        onOpenAutoFocus={(e) => {
          // Prefilled with a folder (clone / "new session here") — keep the folder picker collapsed
          // instead of auto-focusing its input, which would pop the browser open over the whole form.
          if (preset?.workingDirectory) e.preventDefault();
        }}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>New session</DialogTitle>
          <DialogDescription>Start a Claude Code session in a working folder.</DialogDescription>
        </DialogHeader>

        {/* Enter submits (native form submit); the folder picker and the command textarea handle
            Enter themselves, so they don't trigger it. The body scrolls on short screens. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            create();
          }}
          className="flex min-h-0 flex-1 flex-col gap-4"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
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
              checked={continueSession}
              onCheckedChange={(v) => setContinueSession(v === true)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <RotateCcw className="size-3.5" /> Continue previous conversation
              </div>
              <p className="text-xs text-muted-foreground">
                {resumeId ? (
                  <>
                    Resumes <em>this</em> session&apos;s own conversation (
                    <code className="font-mono">--resume</code>), not just the folder&apos;s most recent one.
                  </>
                ) : (
                  <>
                    Starts with <code className="font-mono">--continue</code> so Claude picks up the folder&apos;s
                    most recent conversation instead of a blank one.
                  </>
                )}{" "}
                The start command is skipped when continuing.
              </p>
            </div>
          </label>

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
              checked={watchdog}
              onCheckedChange={(v) => setWatchdog(v === true)}
              className="mt-0.5"
            />
            <div className="space-y-0.5">
              <div className="flex items-center gap-1.5 text-sm font-medium">
                <Activity className="size-3.5" /> Hang watchdog
              </div>
              <p className="text-xs text-muted-foreground">
                Auto-sends <code className="font-mono">continue</code> when the session hangs on an API or
                streaming error. Off by default; you can also toggle it later from the session header.
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

          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
