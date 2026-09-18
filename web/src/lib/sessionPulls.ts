// The pull requests a session has open as tabs — the ones being reviewed beside the terminal doing
// the work.
//
// They live in the session's UI bag (lib/sessionUi.ts), keyed by conversation, so a PR opened on a
// laptop is there on the phone and survives a reload. Only the tab is kept — the number, and the
// title it had when it was opened — because the review itself is GitHub's to answer for, and is
// fetched rather than stored.
//
// This is the sibling of lib/sessionLinks.ts and works the same way, with one difference: a PR has
// an identity of its own — its number — so no id is minted, and opening #42 twice is going back to
// the tab that is already there.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionPull } from "@/types";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "./sessionUi";

// A session can have this many PRs open at once; opening another evicts the oldest tab. Local to
// this module because the cap is enforced here — unlike the links, whose dialog refuses past MAX_LINKS
// and so has to know the number.
const MAX_PULLS = 8;

/** What the tab says — "#42 Fix the thing", trimmed to fit by the strip that draws it. */
export function pullTabLabel(pull: SessionPull): string {
  return pull.title.trim() ? `#${pull.number} ${pull.title.trim()}` : `#${pull.number}`;
}

export interface SessionPulls {
  pulls: SessionPull[];
  /** The PR filling the pane, or null when none is open. */
  activeNumber: number | null;
  /** The PR `activeNumber` names, resolved. */
  active: SessionPull | null;
  /** Open a PR as a tab and give it the pane. Re-opening one already there just moves to it. */
  open: (pull: SessionPull) => void;
  /** Correct a tab's title once GitHub has been asked — the PR may have been renamed since. */
  retitle: (number: number, title: string) => void;
  close: (number: number) => void;
  /** Show a PR, as a user click — persisted, because choosing one is a choice worth keeping. */
  activate: (number: number) => void;
}

/** Read a session's open PRs out of the saved bag, dropping anything that isn't one. */
function restore(sessionId: string): { pulls: SessionPull[]; active: number | null } {
  const ui = loadSessionUi(sessionId);
  // The title is checked as well as the number: everything downstream trims it, and a bag written
  // by some other build is exactly the case this filter exists for.
  const pulls = (Array.isArray(ui.pulls) ? ui.pulls : []).filter(
    (p): p is SessionPull =>
      !!p && typeof p.number === "number" && p.number > 0 && typeof p.title === "string"
  );
  const active =
    typeof ui.pull === "number" && pulls.some((p) => p.number === ui.pull)
      ? ui.pull
      : pulls[0]?.number ?? null;
  return { pulls, active };
}

/** Own a session's open pull requests: the list, which one is showing, and persisting both. */
export function useSessionPulls(sessionId: string): SessionPulls {
  const [pulls, setPulls] = useState<SessionPull[]>(() => restore(sessionId).pulls);
  const [activeNumber, setActiveNumber] = useState<number | null>(() => restore(sessionId).active);

  // The state, mirrored where the callbacks can both read and write it within one click — opening a
  // PR and then showing it. See the same refs in lib/sessionLinks.ts for why a render is too late.
  const pullsRef = useRef(pulls);
  const activeRef = useRef(activeNumber);

  const apply = useCallback(
    (nextPulls: SessionPull[], nextActive: number | null) => {
      pullsRef.current = nextPulls;
      activeRef.current = nextActive;
      setPulls(nextPulls);
      setActiveNumber(nextActive);
      // 0, not undefined: the bag merges field by field and only a value can clear one. No PR is
      // number 0, so it reads as "none" on the way back in.
      saveSessionUi(sessionId, { pulls: nextPulls, pull: nextActive ?? 0 });
    },
    [sessionId]
  );

  const open = useCallback(
    (pull: SessionPull) => {
      const existing = pullsRef.current.find((p) => p.number === pull.number);
      // Already on the bar: go to it, but take the title the picker just showed — the PR may have
      // been renamed since the tab was opened.
      if (existing) {
        apply(
          pullsRef.current.map((p) => (p.number === pull.number ? { ...p, title: pull.title } : p)),
          pull.number
        );
        return;
      }
      // The cap is enforced here rather than in the picker: the oldest tab makes way, which is what
      // a row of reviews being worked through wants. The slice also trims a list that arrived
      // over-long from another device.
      apply([...pullsRef.current, pull].slice(-MAX_PULLS), pull.number);
    },
    [apply]
  );

  const retitle = useCallback(
    (number: number, title: string) => {
      const current = pullsRef.current.find((p) => p.number === number);
      if (!current || current.title === title) return; // nothing changed — don't write the bag
      apply(
        pullsRef.current.map((p) => (p.number === number ? { ...p, title } : p)),
        activeRef.current
      );
    },
    [apply]
  );

  // Closing a tab falls back to its neighbour, the way a file tab does.
  const close = useCallback(
    (number: number) => {
      const idx = pullsRef.current.findIndex((p) => p.number === number);
      if (idx === -1) return;
      const next = pullsRef.current.filter((p) => p.number !== number);
      const nextActive =
        activeRef.current === number
          ? next[Math.min(idx, next.length - 1)]?.number ?? null
          : activeRef.current;
      apply(next, nextActive);
    },
    [apply]
  );

  const activate = useCallback((number: number) => apply(pullsRef.current, number), [apply]);

  /**
   * Take a list that came from somewhere else — the saved bag on a session switch, or another
   * device's write — without saving it back.
   */
  const adopt = useCallback((next: { pulls: SessionPull[]; active: number | null }) => {
    pullsRef.current = next.pulls;
    setPulls(next.pulls);
    // A remote change only moves the tab being looked at if that tab has gone.
    const keep = activeRef.current && next.pulls.some((p) => p.number === activeRef.current);
    activeRef.current = keep ? activeRef.current : next.active;
    setActiveNumber(activeRef.current);
  }, []);

  // Switching session: take that session's PRs. Skips the first run (and StrictMode's doubled
  // mount) so the state the initializers restored is not thrown away and re-saved.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    adopt(restore(sessionId));
  }, [sessionId, adopt]);

  // Adopt a change from another browser: a PR opened on the phone should turn up here.
  useEffect(() => subscribeSessionUi(sessionId, () => adopt(restore(sessionId))), [sessionId, adopt]);

  const active = useMemo(
    () => pulls.find((p) => p.number === activeNumber) ?? null,
    [pulls, activeNumber]
  );

  return useMemo(
    () => ({ pulls, activeNumber, active, open, retitle, close, activate }),
    [pulls, activeNumber, active, open, retitle, close, activate]
  );
}
