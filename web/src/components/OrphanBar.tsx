import { useCallback, useEffect, useState } from "react";
import type { PtyOrphan } from "@/types";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Unplug } from "lucide-react";

/** How often to re-check. Orphans appear only on a detach or a lost session record, so rarely. */
const POLL_MS = 20_000;

/**
 * Surfaces pty hosts still running for sessions the app no longer tracks, and offers to stop them.
 *
 * Sessions outlive the app now, which is the point — but it means a detached session (or one whose
 * record was lost) keeps a `claude` process running with nothing in the UI pointing at it. Before,
 * the next restart would have taken it down; now nothing will, so it needs somewhere to be seen.
 * Renders nothing at all in the ordinary case where there are none.
 */
export function OrphanBar() {
  const [orphans, setOrphans] = useState<PtyOrphan[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [stopping, setStopping] = useState(false);

  const refresh = useCallback(() => {
    api
      .listOrphans()
      .then(setOrphans)
      .catch(() => setOrphans([])); // not signed in yet, or the server is restarting
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, POLL_MS);
    return () => clearInterval(t);
  }, [refresh]);

  if (orphans.length === 0) return null;

  const stopAll = async () => {
    setStopping(true);
    try {
      await api.stopOrphans();
      setConfirming(false);
      refresh();
    } finally {
      setStopping(false);
    }
  };

  return (
    <>
      <div className="flex items-center gap-2 border-t bg-amber-500/10 px-2 py-1.5 text-xs">
        <Unplug className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <span
          className="truncate text-muted-foreground"
          title={orphans.map((o) => `claude pid ${o.childPid} — ${o.workingDirectory}`).join("\n")}
        >
          {orphans.length} untracked session{orphans.length === 1 ? "" : "s"} still running
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-6 shrink-0 px-2 text-xs"
          onClick={() => setConfirming(true)}
        >
          Stop
        </Button>
      </div>

      {confirming && (
        <Dialog open onOpenChange={(o) => !o && setConfirming(false)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Stop untracked sessions</DialogTitle>
              <DialogDescription>
                These are still running but nothing in the app points at them — usually because they
                were detached. Stopping ends each <span className="font-mono">claude</span> process
                and cannot be undone.
              </DialogDescription>
            </DialogHeader>

            <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
              {orphans.map((o) => (
                <li key={o.sessionId} className="flex items-baseline gap-2">
                  <span className="truncate font-mono text-foreground" title={o.workingDirectory}>
                    {o.workingDirectory}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    pid {o.childPid} · {formatAge(o.ageHours)}
                  </span>
                </li>
              ))}
            </ul>

            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirming(false)} disabled={stopping}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={stopAll} disabled={stopping}>
                {stopping ? "Stopping…" : `Stop ${orphans.length}`}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

/** Coarse age — the point is "minutes vs days ago", not precision. */
function formatAge(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}
