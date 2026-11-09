import { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpCircle, GitCommitHorizontal, Loader2, RefreshCw } from "lucide-react";
import type { BuildStamp, UpdateStatus } from "@/types";
import { useApi } from "@/lib/node";
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
 * The "Update available" affordance in the sidebar footer (or a header, with the sidebar hidden),
 * plus the full-screen overlay that covers the restart. A build staged by `scripts\stage-update.ps1`
 * reaches the UI on the /hub/events snapshot; clicking through stops this build, installs the staged
 * one and brings the running sessions back. See {@link UpdatingOverlay} for what happens after the click.
 *
 * A peer's, on its heading in the sidebar, is the same button inside that node's NodeProvider: each node
 * updates itself, from its own staged build and with its own "what's new" (plans/multi-node.md §8). There
 * is no overlay for one — this page isn't going anywhere; the heading goes offline and comes back.
 */
export function UpdateButton({
  status,
  onApplying,
  nodeName,
}: {
  status: UpdateStatus | null;
  /** The apply request went through: the server is going down and the overlay should take over. */
  onApplying?: (targetBuildId: string) => void;
  /** A peer's name: the button is that machine's, drawn small on its heading. */
  nodeName?: string;
}) {
  const api = useApi();
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
      setBusy(false);
      onApplying?.(status.staged!.buildId);
    } catch (e) {
      // The server is still ours — it refused before handing off (nothing staged any more, a dev run
      // with no install folder). Say why and leave the dialog up.
      setError(e instanceof Error ? e.message : "could not start the update");
      setBusy(false);
    }
  };

  return (
    <>
      {nodeName && status.state === "Applying" ? (
        // Installing over there: nothing to click until the heading goes offline and comes back.
        <Loader2
          className="size-3.5 shrink-0 animate-spin text-sky-600 dark:text-sky-500"
          aria-label={`${nodeName}: updating`}
        />
      ) : nodeName ? (
        // On a heading: the same colour, at the heading's size — amber when the last try failed.
        <button
          type="button"
          className={cn(
            "shrink-0",
            status.state === "Failed"
              ? "text-amber-600 hover:text-amber-500 dark:text-amber-500"
              : "text-sky-600 hover:text-sky-500 dark:text-sky-500"
          )}
          title={
            status.state === "Failed"
              ? `${nodeName}: the last update failed${status.error ? ` (${status.error})` : ""} — try again`
              : `${nodeName}: update available — ${describe(status.staged)}`
          }
          aria-label={`Update ${nodeName}`}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(true);
          }}
        >
          {status.state === "Failed" ? <AlertTriangle className="size-3.5" /> : <ArrowUpCircle className="size-3.5" />}
        </button>
      ) : (
        // Filled, in a colour no other button wears, so a waiting build gets noticed.
        <Button
          size="sm"
          className="h-7 shrink-0 gap-1.5 bg-sky-600 px-2.5 text-white hover:bg-sky-600/90 dark:bg-sky-500 dark:hover:bg-sky-500/90"
          title={`Update available — ${describe(status.staged)}`}
          onClick={() => setOpen(true)}
        >
          <ArrowUpCircle className="size-4" />
          Update
        </Button>
      )}

      <Dialog open={open} onOpenChange={(o) => !busy && setOpen(o)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{nodeName ? `Update ${nodeName}` : "Update Hangar"}</DialogTitle>
            <DialogDescription>
              {nodeName ? "That machine's app" : "The app"} restarts to install this build. It takes a few
              seconds, and the sessions running right now are resumed automatically once it's back.
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
  const api = useApi();
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
            ? "This is taking longer than usual. Check the update log at %LocalAppData%\\Hangar\\logs\\update.log."
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
      <span className="truncate font-mono text-xs">
        {stamp.version && `v${stamp.version} · `}
        {stamp.buildId}
      </span>
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
  const name = [stamp.version && `v${stamp.version}`, stamp.commit].filter(Boolean).join(" ");
  const build = name ? `${name}, built ${when}` : `built ${when}`;
  // The summary first: it is the part that says whether this is worth restarting for right now.
  return stamp.notes?.summary ? `${stamp.notes.summary} (${build})` : build;
}
