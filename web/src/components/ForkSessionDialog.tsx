import { useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
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
import { Label } from "@/components/ui/label";
import { GitFork, Loader2 } from "lucide-react";

// A "(fork)" / "(fork 3)" suffix this scheme added earlier. Stripped before suggesting a name, so
// forking a fork numbers off the original — "a (fork 2)", not "a (fork) (fork)".
const FORK_SUFFIX = /\s*\(fork(?:\s+\d+)?\)\s*$/i;

/**
 * Name to prefill for a fork of `parent`: "<parent> (fork)", counting up while that name is already
 * taken so a second fork of the same lineage doesn't land on a duplicate. Mirrors the server's own
 * fallback for a blank name — it just gets there first, so the user sees it before launching.
 */
function suggestName(parent: SessionInfo, sessions: SessionInfo[]): string {
  const taken = new Set(sessions.map((s) => s.name.toLowerCase()));
  // Fall back to the full name if it's nothing *but* a suffix, so we never suggest a bare "(fork)".
  const base = parent.name.replace(FORK_SUFFIX, "").trim() || parent.name;
  let candidate = `${base} (fork)`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${base} (fork ${n})`;
  return candidate;
}

/**
 * Fork a session: launch a new one in the same folder that branches the parent's conversation
 * (`claude --resume <convo> --fork-session`), leaving the original running and untouched. The only
 * choice is what to call it — everything else (folder, model, permissions, remote control) is
 * inherited, since a fork is the same work continued down a different path.
 */
export function ForkSessionDialog({
  parent,
  sessions,
  onForked,
  onClose,
}: {
  /** The session being forked; the dialog is mounted only while one is chosen. */
  parent: SessionInfo;
  /** Every known session, so the suggested name can avoid one that's already in use. */
  sessions: SessionInfo[];
  onForked: (s: SessionInfo) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(() => suggestName(parent, sessions));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-suggest when the dialog is pointed at a different session (fork one, then fork another).
  useEffect(() => {
    setName(suggestName(parent, sessions));
    setError(null);
    // Only on a change of parent: re-running on every `sessions` push would fight the user's typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent.id]);

  async function fork() {
    setBusy(true);
    setError(null);
    try {
      onForked(await api.forkSession(parent.id, name.trim()));
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to fork session");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitFork className="size-4" /> Fork session
          </DialogTitle>
          <DialogDescription>
            Starts a second session that picks up{" "}
            <span className="font-medium text-foreground">{parent.name}</span>&rsquo;s conversation and
            carries on separately. The original keeps running, unchanged.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            fork();
          }}
          className="flex min-w-0 flex-col gap-4"
        >
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Forked from</Label>
            <div className="flex min-w-0 flex-col gap-0.5 rounded-md border bg-muted/40 px-3 py-2">
              <span className="truncate text-sm font-medium">{parent.name}</span>
              <span
                className="truncate font-mono text-[11px] text-muted-foreground"
                title={parent.workingDirectory}
              >
                {parent.workingDirectory}
              </span>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="fork-name">Fork name</Label>
            <Input
              id="fork-name"
              value={name}
              autoFocus
              onChange={(e) => setName(e.target.value)}
              placeholder={suggestName(parent, sessions)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <GitFork className="size-4" />}
              Fork
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
