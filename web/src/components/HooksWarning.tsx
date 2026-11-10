import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, X } from "lucide-react";
import type { ClaudeHooksStatus } from "@/types";
import { useApi } from "@/lib/node";
import { Button } from "@/components/ui/button";

// Read again this often, and on coming back to the tab: the instance that owns the hooks can stop (this
// one then takes them over by itself) or another can take them, and neither tells this page.
const RECHECK_MS = 60_000;
const DOCS = "https://github.com/sdm-kz/hangar/blob/main/docs/troubleshooting.md";

/**
 * A strip under the sidebar's header while Claude's hooks don't report to this Hangar. Without them a
 * session's status (working, waiting on you, a permission prompt) is guessed from the terminal, and the
 * chat can't follow a /clear. It used to be said only in the server log, which is not where anyone
 * looks when a chat stays empty. Nothing at all while the hooks are this instance's, or switched off.
 */
export function HooksWarning() {
  const api = useApi();
  const [status, setStatus] = useState<ClaudeHooksStatus | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Hidden for this tab only, and only for the owner it was hidden for: a different one is news.
  const [hiddenFor, setHiddenFor] = useState<number | null>(null);

  const load = useCallback(() => {
    api.getClaudeHooks().then((next) => {
      setStatus(next);
      // Settled one way or the other since: what was asked or reported about the last state is stale.
      if (next.state === "ours" || next.state === "off") {
        setConfirming(false);
        setError(null);
      }
    }, () => {});
  }, [api]);
  useEffect(() => {
    load();
    const timer = window.setInterval(load, RECHECK_MS);
    const onFocus = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [load]);

  if (!status || status.state === "ours" || status.state === "off") return null;
  if (status.state === "elsewhere" && hiddenFor === status.ownerPort) return null;

  const takeOver = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.takeOverClaudeHooks();
      setStatus(next);
      if (next.state !== "ours") setError("They could not be moved here; see the server log.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  const owner =
    status.state === "elsewhere"
      ? `${status.ownerIsHangar ? "another Hangar" : "another program"} on port ${status.ownerPort}`
      : null;

  return (
    <div role="status" className="shrink-0 border-b bg-amber-500/10 px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p>
            {owner ? (
              <>
                Claude's hooks report to <strong>{owner}</strong>, not to this one.
              </>
            ) : (
              <>Claude's hooks could not be registered in ~/.claude/settings.json.</>
            )}{" "}
            Session status here is a guess, and a chat loses track after <code>/clear</code>.{" "}
            <a href={DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              Why
            </a>
          </p>
          {owner && confirming && (
            <p className="text-muted-foreground">
              Sessions of the one on port {status.ownerPort} then stop reporting to it. Sessions already
              running keep the hooks they started with until they are restarted.
            </p>
          )}
          {error && <p className="text-destructive">{error}</p>}
          {owner && (
            <div className="flex gap-2">
              {confirming ? (
                <>
                  <Button size="sm" className="h-6 px-2 text-xs" disabled={busy} onClick={takeOver}>
                    {busy && <Loader2 className="size-3 animate-spin" />}
                    Take them over
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setConfirming(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => setConfirming(true)}>
                  Use this Hangar…
                </Button>
              )}
            </div>
          )}
        </div>
        {owner && (
          <button
            type="button"
            title="Hide until the hooks change"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setHiddenFor(status.ownerPort)}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
