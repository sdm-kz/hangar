import { useCallback, useEffect, useState } from "react";

/**
 * What the session hub says about one shell's commands (ShellActivity on the server): whether one is
 * running at its prompt, and when the last one started and ended, with its exit code. Times are Unix
 * ms, 0 for never; the exit code is null where the shell can't report one (cmd).
 */
export interface ShellActivity {
  sessionId: string;
  running: boolean;
  startedAt: number;
  endedAt: number;
  exitCode: number | null;
}

/** The mark a shell, or a session's shells together, wears: a command running, or one that ended. */
export type ShellMark = "busy" | "done" | "failed";

// A command that ends this quickly is one you watched: an `ls`, an empty Enter. It is not news, and
// marking it would put a tick on a tab every time somebody pressed Enter in it.
const MIN_FINISHED_MS = 1000;

/** The mark for one shell, given when its last finished command was seen (its endedAt). */
export function shellMark(a: ShellActivity | undefined, seenEndedAt: number | undefined): ShellMark | null {
  if (!a) return null;
  if (a.running) return "busy";
  if (!a.endedAt || a.endedAt <= (seenEndedAt ?? 0) || a.endedAt - a.startedAt < MIN_FINISHED_MS) return null;
  return a.exitCode !== null && a.exitCode !== 0 ? "failed" : "done";
}

/** What a shell's mark says, for a tooltip. */
export function shellMarkLabel(mark: ShellMark, a: ShellActivity): string {
  if (mark === "busy") return "A command is running";
  if (mark === "failed") return `The last command failed (exit ${a.exitCode}) — you haven’t looked yet`;
  return "The last command finished — you haven’t looked yet";
}

/**
 * Several shells' marks as one, for a session's row: a failure first (it wants doing something about),
 * then work still going, then work done.
 */
export function combineShellMarks(marks: Iterable<ShellMark | null>): ShellMark | null {
  let best: ShellMark | null = null;
  const rank = { failed: 3, busy: 2, done: 1 } as const;
  for (const m of marks) if (m && (!best || rank[m] > rank[best])) best = m;
  return best;
}

const SEEN_KEY = "claudeweb.shellsSeen";

function readSeen(): Record<string, number> {
  try {
    const v = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}");
    return v && typeof v === "object" ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/**
 * Which finished commands this browser has seen, per shell: the endedAt of the last one looked at.
 * Kept in localStorage and shared between the browser's tabs, like the sessions' "done" marks. Ids
 * of shells that are gone are pruned once the hub has said which are live: null until it has.
 */
export function useShellsSeen(activity: Record<string, ShellActivity> | null) {
  const [seen, setSeen] = useState<Record<string, number>>(readSeen);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => e.key === SEEN_KEY && setSeen(readSeen());
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const write = useCallback((next: Record<string, number>) => {
    try {
      localStorage.setItem(SEEN_KEY, JSON.stringify(next));
    } catch {
      /* a convenience only */
    }
    return next;
  }, []);

  const markSeen = useCallback(
    (id: string, endedAt: number) =>
      setSeen((s) => ((s[id] ?? 0) >= endedAt ? s : write({ ...s, [id]: endedAt }))),
    [write]
  );

  // Forget shells that have closed. Only ever drops ids the hub no longer lists, so a snapshot that is
  // still on its way can cost a mark at most, never bring one back that was dismissed.
  useEffect(() => {
    if (!activity) return;
    setSeen((s) => {
      const ids = Object.keys(s).filter((id) => id in activity);
      return ids.length === Object.keys(s).length ? s : write(Object.fromEntries(ids.map((id) => [id, s[id]])));
    });
  }, [activity, write]);

  return { seen, markSeen };
}
