// The shell tabs of one thing — a session, or a folder in the Files tree — and the open/close/select
// behaviour around them.
//
// The tabs live on the SERVER (each is a process in a pty host), so this is a mirror of what it
// reports rather than browser state: open one on a laptop and the phone shows it too, and both find
// it still there after the app restarts. `shellsRev` on the events hub is the change signal — only
// the number is pushed, and any move in it means re-read.
//
// Shared by SessionView and ShellView because the interesting parts are not the rendering: an answer
// that predates a shell you just opened must not unmount its pane, a failed refetch must not close
// every socket, and a reconciliation must not be mistaken for a preference worth saving.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RemoteConnection, ShellInfo } from "@/types";
import { api } from "./api";

export interface ShellsHandle {
  shells: ShellInfo[];
  /** The shell filling the pane, or null when there are none. */
  activeId: string | null;
  /** True once the server has answered for the current owner — before that, "no shells" is unknown. */
  loaded: boolean;
  /**
   * The last read for this owner failed. `loaded` still goes true (the tabs on screen are kept, and
   * the next revision bump re-reads), so a caller that acts on "this owner has no shells" — opening
   * one, standing down — has to check this first, or a network blip reads as an empty folder.
   */
  failed: boolean;
  /** A shell is being launched; the "+" spins rather than taking a second click. */
  opening: boolean;
  /** Show an existing tab, as a user click: reported through `onActivate` so it can be remembered. */
  activate: (id: string) => void;
  /** Show a tab that was remembered elsewhere — not reported, because nobody chose it just now. */
  restore: (id: string) => void;
  /** Open another shell (a ShellOption id; "" lets the server pick its default), or with `ssh`, a
   *  connection to that host. */
  open: (shell: string, ssh?: RemoteConnection) => Promise<ShellInfo | null>;
  /** Close a tab and kill what is running in it. */
  close: (id: string) => Promise<void>;
}

/**
 * @param owner Which shells these are: a session's (with the folder it runs in, which is where a new
 *              one opens), a folder's, or the SSH connections opened outside any session. Changing
 *              it swaps the whole set.
 * @param shellsRev The server's shell-set revision (from the events hub); any move re-reads.
 * @param initialActive The tab to show first, when one was remembered.
 * @param onActivate Called when the USER picks a tab, so a caller can persist that choice.
 *                   Deliberately not called for the automatic fallback below.
 * @param onError Called when opening a shell fails, with the message to show.
 */
export function useShells({
  owner,
  shellsRev,
  initialActive,
  onActivate,
  onError,
}: {
  owner: { sessionId: string; workingDirectory: string } | { folder: string } | { ssh: true };
  shellsRev?: number;
  initialActive?: () => string | null;
  onActivate?: (id: string) => void;
  onError?: (message: string) => void;
}): ShellsHandle {
  const sessionId = "sessionId" in owner ? owner.sessionId : undefined;
  const folder = "folder" in owner ? owner.folder : undefined;
  // Where a new shell opens. For a folder that is the folder itself; for a session, the folder it
  // works in — the same place its Claude terminal is running. An SSH connection has none here: the
  // server starts ssh in the home folder.
  const cwd = "folder" in owner ? owner.folder : "workingDirectory" in owner ? owner.workingDirectory : "";
  // One string identifying the owner, so the effects below key on a value rather than an object
  // literal that is new on every render.
  const ownerKey = sessionId ? `s:${sessionId}` : folder !== undefined ? `f:${folder}` : "ssh";

  const [shells, setShells] = useState<ShellInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(() => initialActive?.() ?? null);
  // Shells opened here that the server's list hasn't reported back yet. `shellsRev` is server-wide,
  // so a list request can already be in flight — carrying its answer's gaps here is what stops a
  // just-opened tab from blinking out of existence.
  const pendingRef = useRef<ShellInfo[]>([]);
  // Read through a ref so the fetch effect doesn't re-run (and re-fetch) whenever the caller passes
  // a fresh closure.
  const initialActiveRef = useRef(initialActive);
  initialActiveRef.current = initialActive;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onActivateRef = useRef(onActivate);
  onActivateRef.current = onActivate;

  // Switching owner: drop the previous set at once rather than showing it under the new name until
  // the new list arrives, and take whatever tab was remembered for this one.
  //
  // Adjusted DURING render, not in an effect. An effect's reset is one render late, and everything
  // that reads this state — "has this owner loaded yet", "does it have no shells" — would spend that
  // render answering for the PREVIOUS owner. That is not theoretical: it made a folder switched to
  // from one that already had a shell come up blank, seeded as though it were already stocked.
  const [stateOwner, setStateOwner] = useState(ownerKey);
  if (stateOwner !== ownerKey) {
    setStateOwner(ownerKey);
    setShells([]);
    setLoaded(false);
    setFailed(false);
    pendingRef.current = [];
    setActiveId(initialActiveRef.current?.() ?? null);
  }

  useEffect(() => {
    let cancelled = false;
    api
      .listShells(sessionId ? { sessionId } : folder !== undefined ? { folder } : { ssh: true })
      .then((list) => {
        if (cancelled) return;
        pendingRef.current = pendingRef.current.filter((p) => !list.some((s) => s.id === p.id));
        setShells([...list, ...pendingRef.current]);
        setLoaded(true);
        setFailed(false);
      })
      .catch(() => {
        if (cancelled) return;
        // Keep whatever is on screen. A blip on this one request — a server restart, a phone
        // waking — must not close every shell socket and drop a running build out of view; the
        // next revision bump re-reads anyway.
        setLoaded(true);
        setFailed(true);
      });
    return () => {
      cancelled = true;
    };
    // The revision is a change signal, not data: any move in it (this browser's own open included)
    // means re-read the list, which is authoritative.
  }, [ownerKey, sessionId, folder, shellsRev]);

  // Keep the active shell pointing at one that exists. The tab it names can be gone for reasons this
  // browser never saw — closed from a phone, or a shell whose process died while the app was
  // stopped — and a pane attached to nothing would just sit there blank.
  useEffect(() => {
    if (!loaded) return;
    setActiveId((current) => {
      const live = current && shells.some((s) => s.id === current) ? current : null;
      // Local repair only, and deliberately not reported through onActivate: which shell you are
      // looking at is a choice, and only a click makes one. Persisting this would let a device that
      // merely opened the view overwrite the tab another device is watching.
      return live ?? (shells.length ? shells[shells.length - 1].id : null);
    });
  }, [shells, loaded]);

  const activate = useCallback((id: string) => {
    setActiveId(id);
    onActivateRef.current?.(id);
  }, []);

  const restore = useCallback((id: string) => setActiveId(id), []);

  const open = useCallback(
    async (shell: string, ssh?: RemoteConnection) => {
      setOpening(true);
      try {
        const created = await api.createShell({
          sessionId,
          workingDirectory: cwd,
          shell: shell || undefined,
          ssh,
        });
        pendingRef.current = [...pendingRef.current.filter((p) => p.id !== created.id), created];
        setShells((prev) => [...prev.filter((s) => s.id !== created.id), created]);
        setActiveId(created.id);
        onActivateRef.current?.(created.id);
        return created;
      } catch (e) {
        onErrorRef.current?.(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setOpening(false);
      }
    },
    [sessionId, folder, cwd]
  );

  // Closing ends a process, so it goes to the server first and the tab is dropped on the answer — a
  // close that failed must not leave a tab nobody can get back to.
  const close = useCallback(async (id: string) => {
    try {
      await api.closeShell(id);
    } catch {
      /* already gone server-side — drop the tab either way */
    }
    pendingRef.current = pendingRef.current.filter((p) => p.id !== id);
    setShells((prev) => prev.filter((s) => s.id !== id));
  }, []);

  return { shells, activeId, loaded, failed, opening, activate, restore, open, close };
}
