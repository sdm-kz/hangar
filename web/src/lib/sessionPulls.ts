// The pull requests a session has open as tabs — the ones being reviewed beside the terminal doing
// the work.
//
// They live in the session's UI bag (lib/sessionUi.ts), keyed by conversation, so a PR opened on a
// laptop is there on the phone and survives a reload. Only the tab is kept — the number, and the
// title it had when it was opened — because the review itself is GitHub's to answer for, and is
// fetched rather than stored.
//
// This is the sibling of lib/sessionLinks.ts and works the same way, with one difference: a PR has
// an identity of its own — its repo and its number — so no id is minted, and opening #42 twice is
// going back to the tab that is already there.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionPull } from "@/types";
import { loadSessionUi, saveSessionUi, subscribeSessionUi, type SessionUi } from "./sessionUi";

// A session can have this many PRs open at once; opening another evicts the oldest tab. Local to
// this module because the cap is enforced here — unlike the links, whose dialog refuses past MAX_LINKS
// and so has to know the number.
const MAX_PULLS = 8;

/**
 * What identifies a review: its repo and its number. A tab on the session's own repo is keyed by the
 * number alone, which is both the common case and what keeps a tab saved before repos could be
 * linked identical to the same tab opened now — otherwise the old #42 and the new one would be two
 * tabs on one review, each with its own folds and its own place in the file.
 *
 * The key is a string because it is one everywhere it is used: a pane ref, a field in the UI bag,
 * the key of a React list.
 */
export function pullKey(pull: SessionPull): string {
  return reviewKey(pull.repo, pull.number);
}

/** pullKey from the two halves, for the view — which is handed them apart, off a pane ref. */
export function reviewKey(repo: string | undefined, number: number): string {
  return repo ? `${repo}#${number}` : String(number);
}

/** The repo and number a key names, for the view that has to go and fetch the review. */
export function parsePullKey(key: string): { repo?: string; number: number } {
  const hash = key.lastIndexOf("#");
  if (hash < 0) return { number: Number(key) };
  return { repo: key.slice(0, hash), number: Number(key.slice(hash + 1)) };
}

/** What the tab says — "#42 Fix the thing", trimmed to fit by the strip that draws it. */
export function pullTabLabel(pull: SessionPull): string {
  const where = pull.repo ? `${pull.repo} ` : "";
  return pull.title.trim()
    ? `${where}#${pull.number} ${pull.title.trim()}`
    : `${where}#${pull.number}`;
}

export interface SessionPulls {
  pulls: SessionPull[];
  /** The key (see pullKey) of the PR filling the pane, or null when none is open. */
  activeKey: string | null;
  /** The PR `activeKey` names, resolved. */
  active: SessionPull | null;
  /** Open a PR as a tab and give it the pane. Re-opening one already there just moves to it. */
  open: (pull: SessionPull) => void;
  /** Correct a tab's title once GitHub has been asked — the PR may have been renamed since. */
  retitle: (key: string, title: string) => void;
  close: (key: string) => void;
  /** Show a PR, as a user click — persisted, because choosing one is a choice worth keeping. */
  activate: (key: string) => void;
}

/** Read a session's open PRs out of the saved bag, dropping anything that isn't one. */
function restore(sessionId: string): { pulls: SessionPull[]; active: string | null } {
  const ui = loadSessionUi(sessionId);
  // The title is checked as well as the number: everything downstream trims it, and a bag written
  // by some other build is exactly the case this filter exists for.
  const pulls = (Array.isArray(ui.pulls) ? ui.pulls : []).filter(
    (p): p is SessionPull =>
      !!p &&
      typeof p.number === "number" &&
      p.number > 0 &&
      typeof p.title === "string" &&
      (p.repo === undefined || typeof p.repo === "string")
  );
  // A bag written before repos could be linked holds a number here; String() reads either, and the
  // key of a tab with no repo is its number written out, so an old bag lands on the same tab.
  const saved = ui.pull === undefined || ui.pull === 0 ? "" : String(ui.pull);
  const active = pulls.some((p) => pullKey(p) === saved)
    ? saved
    : pulls[0]
      ? pullKey(pulls[0])
      : null;
  return { pulls, active };
}

/**
 * The reading state of the reviews that are still open, when some of what is stored no longer is.
 *
 * Every write to the tab list goes through this rather than only a close, because a close is not the
 * only way a tab goes away: opening a ninth review drops the oldest to keep under MAX_PULLS, and a
 * tab that leaves that way would otherwise leave its folds and its offset behind for good. What is
 * stored then grows with every review the session has ever opened — and the bag has a size limit,
 * past which the server drops the whole thing rather than trimming it, taking the open tabs and the
 * open files with it.
 *
 * Nothing is returned when nothing has gone stale: an unchanged field is a no-op at the server, but
 * sending it on every tab click would churn the bag's revision and have every other browser re-fetch
 * for nothing. This is the shape useFileTabs prunes its own scroll offsets with, for those reasons.
 */
function pruned(sessionId: string, open: SessionPull[]): SessionUi {
  const ui = loadSessionUi(sessionId);
  const keys = new Set(open.map(pullKey));
  const stale = <T,>(from: Record<string, T> | undefined) =>
    !!from && Object.keys(from).some((k) => !keys.has(k));
  if (!stale(ui.pullFolds) && !stale(ui.pullScroll)) return {};

  const keep = <T,>(from: Record<string, T> | undefined): Record<string, T> =>
    Object.fromEntries(Object.entries(from ?? {}).filter(([k]) => keys.has(k)));
  return { pullFolds: keep(ui.pullFolds), pullScroll: keep(ui.pullScroll) };
}

/** Own a session's open pull requests: the list, which one is showing, and persisting both. */
export function useSessionPulls(sessionId: string): SessionPulls {
  const [pulls, setPulls] = useState<SessionPull[]>(() => restore(sessionId).pulls);
  const [activeKey, setActiveKey] = useState<string | null>(() => restore(sessionId).active);

  // The state, mirrored where the callbacks can both read and write it within one click — opening a
  // PR and then showing it. See the same refs in lib/sessionLinks.ts for why a render is too late.
  const pullsRef = useRef(pulls);
  const activeRef = useRef(activeKey);

  const apply = useCallback(
    (nextPulls: SessionPull[], nextActive: string | null) => {
      pullsRef.current = nextPulls;
      activeRef.current = nextActive;
      setPulls(nextPulls);
      setActiveKey(nextActive);
      // "", not undefined: the bag merges field by field and only a value can clear one. No review
      // is keyed by the empty string, so it reads as "none" on the way back in.
      saveSessionUi(sessionId, {
        pulls: nextPulls,
        pull: nextActive ?? "",
        ...pruned(sessionId, nextPulls),
      });
    },
    [sessionId]
  );

  const open = useCallback(
    (pull: SessionPull) => {
      const key = pullKey(pull);
      const existing = pullsRef.current.some((p) => pullKey(p) === key);
      // Already on the bar: go to it, but take the title the picker just showed — the PR may have
      // been renamed since the tab was opened.
      if (existing) {
        apply(
          pullsRef.current.map((p) => (pullKey(p) === key ? { ...p, title: pull.title } : p)),
          key
        );
        return;
      }
      // The cap is enforced here rather than in the picker: the oldest tab makes way, which is what
      // a row of reviews being worked through wants. The slice also trims a list that arrived
      // over-long from another device.
      apply([...pullsRef.current, pull].slice(-MAX_PULLS), key);
    },
    [apply]
  );

  const retitle = useCallback(
    (key: string, title: string) => {
      const current = pullsRef.current.find((p) => pullKey(p) === key);
      if (!current || current.title === title) return; // nothing changed — don't write the bag
      apply(
        pullsRef.current.map((p) => (pullKey(p) === key ? { ...p, title } : p)),
        activeRef.current
      );
    },
    [apply]
  );

  // Closing a tab falls back to its neighbour, the way a file tab does. How far through that review
  // the reader had got goes with it, through the prune every write runs (see `pruned`).
  const close = useCallback(
    (key: string) => {
      const idx = pullsRef.current.findIndex((p) => pullKey(p) === key);
      if (idx === -1) return;
      const next = pullsRef.current.filter((p) => pullKey(p) !== key);
      const kept = next[Math.min(idx, next.length - 1)];
      const nextActive =
        activeRef.current === key ? (kept ? pullKey(kept) : null) : activeRef.current;
      apply(next, nextActive);
    },
    [apply]
  );

  const activate = useCallback((key: string) => apply(pullsRef.current, key), [apply]);

  /**
   * Take a list that came from somewhere else — the saved bag on a session switch, or another
   * device's write — without saving it back.
   */
  const adopt = useCallback((next: { pulls: SessionPull[]; active: string | null }) => {
    pullsRef.current = next.pulls;
    setPulls(next.pulls);
    // A remote change only moves the tab being looked at if that tab has gone.
    const keep = activeRef.current && next.pulls.some((p) => pullKey(p) === activeRef.current);
    activeRef.current = keep ? activeRef.current : next.active;
    setActiveKey(activeRef.current);
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
    () => pulls.find((p) => pullKey(p) === activeKey) ?? null,
    [pulls, activeKey]
  );

  return useMemo(
    () => ({ pulls, activeKey, active, open, retitle, close, activate }),
    [pulls, activeKey, active, open, retitle, close, activate]
  );
}
