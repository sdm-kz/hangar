import { useEffect, useState } from "react";
import { ArrowUpCircle, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import type { BuildStamp, UpdateStatus } from "@/types";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The "Update available" affordance in the sidebar header, plus the full-screen overlay that covers
 * the restart. A build staged by `scripts\stage-update.ps1` reaches the UI on the /hub/events
 * snapshot; clicking through stops this build, installs the staged one and brings the running
 * sessions back. See {@link UpdatingOverlay} for what happens after the click.
 */
export function UpdateButton({
  status,
  onApplying,
}: {
  status: UpdateStatus | null;
  /** The apply request went through: the server is going down and the overlay should take over. */
  onApplying: (targetBuildId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Nothing to offer: no update staged, the updater is off, or this build already is the staged one.
  if (!status?.available || !status.staged) return null;

  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.applyUpdate();
      setOpen(false);
      onApplying(status.staged!.buildId);
    } catch (e) {
      // The server is still ours — it refused before handing off (nothing staged any more, a dev run
      // with no install folder). Say why and leave the dialog up.
      setError(e instanceof Error ? e.message : "could not start the update");
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-7 shrink-0 gap-1.5 px-2 text-primary hover:bg-primary/10 hover:text-primary"
        title={`Update available — ${describe(status.staged)}`}
        onClick={() => setOpen(true)}
      >
        <ArrowUpCircle className="size-4" />
        Update
      </Button>

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Update Claude Web</DialogTitle>
            <DialogDescription>
              The app restarts to install this build. It takes a few seconds, and the sessions running
              right now are resumed automatically once it's back.
            </DialogDescription>
          </DialogHeader>

          <WhatsNew stamp={status.staged} />

          <dl className="grid grid-cols-[auto,minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">New</dt>
            <dd className="min-w-0">
              <BuildLine stamp={status.staged} />
            </dd>
            <dt className="text-muted-foreground">Running</dt>
            <dd className="min-w-0 text-muted-foreground">
              {status.current ? <BuildLine stamp={status.current} /> : "unknown build"}
            </dd>
          </dl>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>
              Not now
            </Button>
            <Button disabled={busy} onClick={apply}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {busy ? "Restarting…" : "Update and restart"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Covers the app while the server is being replaced. The old build answered the apply request and
 * then stopped, so everything is down for a few seconds: poll until a server answers as
 * `targetBuildId`, then reload so the browser picks up the new build's assets too.
 *
 * Deliberately does NOT reload on the first successful response — a failed update restarts the OLD
 * build, which would otherwise look like a success and leave the user on the same version wondering.
 */
export function UpdatingOverlay({ targetBuildId }: { targetBuildId: string }) {
  // "slow" after a while: the update is taking longer than a restart should, so offer a way out
  // rather than spinning forever behind an overlay the user can't dismiss.
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    let stop = false;
    const started = Date.now();

    const poll = async () => {
      while (!stop) {
        try {
          const status = await api.getUpdate();
          if (status.current?.buildId === targetBuildId) {
            location.reload();
            return;
          }
        } catch {
          /* still down, or back up but not yet serving — keep waiting */
        }
        if (Date.now() - started > 90_000) setSlow(true);
        await new Promise((r) => setTimeout(r, 1500));
      }
    };
    void poll();

    return () => {
      stop = true;
    };
  }, [targetBuildId]);

  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-background/95 p-6 text-center">
      <Loader2 className="size-8 animate-spin text-primary" />
      <div>
        <p className="font-medium">Installing the update…</p>
        <p className="text-sm text-muted-foreground">
          {slow
            ? "This is taking longer than usual. Check the update log at %LocalAppData%\\ClaudeWeb\\logs\\update.log."
            : "The app is restarting. Your running sessions come back on their own."}
        </p>
      </div>
      {slow && (
        <Button variant="outline" size="sm" onClick={() => location.reload()}>
          <RefreshCw className="size-4" /> Reload now
        </Button>
      )}
    </div>
  );
}

function BuildLine({ stamp }: { stamp: BuildStamp }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate font-mono text-xs">{stamp.buildId}</span>
      <span className={cn("flex items-center gap-1 text-xs text-muted-foreground")}>
        {stamp.commit && (
          <>
            <GitCommitHorizontal className="size-3" />
            {stamp.commit}
            {stamp.branch && ` · ${stamp.branch}`}
          </>
        )}
      </span>
    </span>
  );
}

/**
 * What the staged build brings, when whoever staged it said (see scripts\stage-update.ps1). Nothing
 * at all when they did not: the dialog is then exactly what it was before this existed, which is the
 * right answer for a build staged by hand rather than a promise of notes that never arrive.
 */
function WhatsNew({ stamp }: { stamp: BuildStamp }) {
  const notes = stamp.notes;
  const changes = notes?.changes ?? [];
  if (!notes || (changes.length === 0 && !notes.summary)) return null;
  return (
    <section className="min-w-0">
      <h3 className="mb-1 text-sm font-medium">What's new</h3>
      {notes.summary && <p className="mb-2 text-sm text-muted-foreground">{notes.summary}</p>}
      {changes.length > 0 && (
        // Capped and scrolled rather than allowed to push the buttons off a short window: a build
        // that has been waiting a while can carry a long list, and the dialog still has to be one
        // you can act on without scrolling to find the way out.
        <ul className="max-h-48 space-y-1 overflow-y-auto pr-1 text-sm">
          {changes.map((change, i) => (
            <li key={i} className="flex gap-2">
              <span aria-hidden className="select-none text-muted-foreground">
                •
              </span>
              <span className="min-w-0 break-words">{change}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** One-line summary for the button's tooltip. */
function describe(stamp: BuildStamp): string {
  const when = stamp.builtAtUtc ? new Date(stamp.builtAtUtc).toLocaleString() : stamp.buildId;
  const build = stamp.commit ? `${stamp.commit}, built ${when}` : `built ${when}`;
  // The summary first: it is the part that says whether this is worth restarting for right now.
  return stamp.notes?.summary ? `${stamp.notes.summary} (${build})` : build;
}
