import { useEffect, useRef, useState } from "react";
import type { SessionInfo } from "@/types";

/**
 * The id sets a session's activity mark is read from. Bundled into one bag rather than passed as
 * four parallel `Set<string>` arguments: every call site wants all of them, and a positional list
 * that long is one transposed pair away from a folder header disagreeing with the rows under it.
 */
export interface ActivityIds {
  /** Claude is generating in these sessions. */
  busy: Set<string>;
  /** Claude is blocked on you — a permission prompt, a selection dialog. */
  waiting: Set<string>;
  /** Claude is compacting the conversation: still working, just not on your task. */
  compacting: Set<string>;
  /** Claude has finished a turn here and you haven't looked since. See useDoneSessions. */
  done: Set<string>;
}

/**
 * How long a finished session keeps its tick once you are actually looking at it. Long enough to
 * register as "this is the one that just finished" after a click from the sidebar, short enough
 * that it is gone by the time you have read the first screen of output.
 */
const SEEN_MS = 4000;

const KEY = "claudeweb.sessionsDone";

function parseDone(raw: string | null): Set<string> {
  try {
    const ids = raw ? (JSON.parse(raw) as unknown) : null;
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function loadDone(): Set<string> {
  try {
    return parseDone(localStorage.getItem(KEY));
  } catch {
    return new Set(); // storage disabled — the marks live for this page only
  }
}

function saveDone(done: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...done]));
  } catch {
    /* storage disabled — the marks are best-effort */
  }
}

function sameSet(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function without(done: Set<string>, id: string) {
  if (!done.has(id)) return done;
  const next = new Set(done);
  next.delete(id);
  return next;
}

/**
 * Which sessions have finished something you haven't seen yet.
 *
 * The green pulse says "Claude is working here" and then simply stops, which is the one moment the
 * sidebar has nothing to say — a session that finished ten seconds ago looks exactly like one that
 * has been idle all afternoon. This is the state in between: it starts when a session leaves the
 * working set, and it ends when you have had its terminal on screen long enough to have read why.
 *
 * Client-side on purpose. "Seen" is a fact about this browser, not about the session — the phone
 * having glanced at a finished turn is no reason for the laptop to drop the mark. It is persisted
 * per browser so a refresh (or a PWA being killed in the background) doesn't quietly lose the ones
 * you hadn't got to yet.
 */
export function useDoneSessions({
  sessions,
  busyIds,
  waitingIds,
  compactingIds,
  shownSessionId,
  streamUp,
}: {
  sessions: SessionInfo[];
  busyIds: Set<string>;
  waitingIds: Set<string>;
  compactingIds: Set<string>;
  /**
   * The session whose terminal is actually on screen — null while a file or a folder's shells have
   * the main area, which they take without changing the selected session. Having a session selected
   * is not the same as having looked at it, and only the second one clears a mark.
   */
  shownSessionId: string | null;
  /**
   * Whether the live session stream is connected. Only the stream carries `waiting`, so it is also
   * what says whether a session leaving the working set can be read as "finished" — see below.
   */
  streamUp: boolean;
}): Set<string> {
  const [done, setDone] = useState<Set<string>>(loadDone);
  // The working set as of the previous frame. A turn has finished when an id drops out of it, which
  // is a transition — it cannot be read off any single snapshot.
  const prevWorking = useRef<Set<string> | null>(null);

  useEffect(() => {
    // Compacting is work: a session mid-compact hasn't finished anything, and treating it as idle
    // would tick it the moment the compaction started.
    const working = new Set([...busyIds, ...compactingIds]);
    const prev = prevWorking.current;
    prevWorking.current = working;

    setDone((cur) => {
      const next = new Set(cur);
      // On the first pass `prev` is null: seed it and mark nothing, so opening the app doesn't tick
      // every session that happened to be working when the page loaded.
      //
      // `streamUp` is the other half of the guard, and it is not a nicety. While the socket is down
      // the app falls back to a poll that refreshes `busy` alone, leaving `waiting` frozen at
      // whatever the last frame said. Leaving the working set only means "finished" if we can still
      // tell it apart from "blocked on you", so with a stale `waiting` we keep watching and say
      // nothing — better a missing tick for the length of a reconnect than a green one on a session
      // that is really sitting on a permission prompt.
      if (prev && streamUp) {
        for (const id of prev) {
          // Stopping because Claude is now blocked on you is not finishing — the amber waiting dot
          // is the thing to show there, and it outranks this one anyway.
          if (!working.has(id) && !waitingIds.has(id)) next.add(id);
        }
      }
      for (const id of next) {
        // A new turn (or a prompt to answer) supersedes the last one's result.
        if (working.has(id) || waitingIds.has(id)) next.delete(id);
        // Prune sessions that have exited or been closed since — but only against a list we
        // actually have. Before the first fetch lands `sessions` is empty, and pruning against it
        // would throw away everything restored from storage.
        else if (sessions.length > 0 && !sessions.some((s) => s.id === id && s.state === "Running"))
          next.delete(id);
      }
      return sameSet(next, cur) ? cur : next;
    });
  }, [sessions, busyIds, waitingIds, compactingIds, streamUp]);

  useEffect(() => {
    saveDone(done);
  }, [done]);

  // Another tab (the app deep-links `?session=`, and a row offers to open in one) writing the set:
  // adopt it wholesale. Both tabs watch the same hub, so they never disagree about what has
  // finished; where they differ is what has been *seen*, and a turn read in one window has been
  // read. Without this the two clobber each other — the tab that cleared a mark writes the shorter
  // set, the other writes its stale copy back over it, and the tick returns from the dead on the
  // next reload. Adopting converges: `sameSet` stops the echo from bouncing back.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== KEY) return;
      setDone((cur) => {
        const next = parseDone(e.newValue);
        return sameSet(next, cur) ? cur : next;
      });
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Having the session on screen is how you see the result, so that is what clears the mark — after
  // a beat, not on arrival, so the row you just came from still shows why you clicked it. A
  // backgrounded tab doesn't count as looking: the timer only runs while the page is visible, and
  // leaving restarts it rather than pausing it, because what earns a clear is a few uninterrupted
  // seconds in front of the thing, not four seconds collected a blink at a time.
  const shownDone = shownSessionId !== null && done.has(shownSessionId);
  useEffect(() => {
    if (!shownSessionId || !shownDone) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer || document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        timer = undefined;
        setDone((d) => without(d, shownSessionId));
      }, SEEN_MS);
    };
    const onVisibility = () => {
      if (document.visibilityState === "visible") arm();
      else {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    arm();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [shownSessionId, shownDone]);

  return done;
}
