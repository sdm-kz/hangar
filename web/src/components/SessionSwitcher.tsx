// Alt+` — the sessions' Alt+Tab. Hold Alt, tap ` to step through the sessions you looked at last, let go
// to open the one highlighted. A single tap goes back to the session you were just in. Alt+Q is its
// companion: straight to the next session that needs you, with no list in between.
//
// Not Alt+Tab or Ctrl+Tab themselves: the OS takes the first and the browser the second before the page
// ever sees them. The key above Tab is the nearest one left, and it is matched by `code`, so it is the
// same physical key on every layout — Ё on a Russian one, ^ on a German one.

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { LastSaid, SessionInfo } from "@/types";
import { ACTIVITY_MARK, ActivityMark, activityDetail, sessionActivity, type Activity } from "@/components/ActivityMark";
import type { ActivityIds } from "@/lib/sessionActivity";
import { sessionColor } from "@/lib/sessionColors";
import { apiForKey, splitSessionKey } from "@/lib/node";
import { cn } from "@/lib/utils";

/** The most the list shows. Past this you are looking for a session, not switching back — Ctrl+Shift+F. */
const SHOWN = 12;

/** The Alt key as the hint line names it: Option, drawn as on its keycap, on a Mac. */
const ALT = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌥" : "Alt";

/** What Alt+Q goes to, most pressing first: blocked on you, then broken, then finished and unread. */
const NEEDS_YOU: Activity[] = ["waiting", "failed", "done"];

/**
 * Each session's latest message, by session key, as last fetched — null for one with nothing said. Kept
 * between opens so a row shows what it said last time straight away, while the fresh copy is on its way.
 */
const lastSaid = new Map<string, LastSaid | null>();

/**
 * Fetch the latest message of each listed session, a request per machine, and call `done` as each lands. A
 * session with no conversation yet has nothing to fetch; a machine whose build predates the endpoint answers
 * with an error, and its rows just go without.
 */
function fetchLastSaid(list: SessionInfo[], done: () => void) {
  const byNode = new Map<string, string[]>();
  for (const s of list) {
    if (!s.claudeSessionId) {
      lastSaid.set(s.id, null);
      continue;
    }
    const node = splitSessionKey(s.id).node ?? "";
    byNode.set(node, [...(byNode.get(node) ?? []), s.id]);
  }
  for (const keys of byNode.values()) {
    apiForKey(keys[0])
      .getLastSaid(keys.map((k) => splitSessionKey(k).id))
      .then((said) => {
        for (const k of keys) lastSaid.set(k, said[splitSessionKey(k).id] ?? null);
        done();
      })
      // Nothing to show rather than a line held open for a preview that isn't coming.
      .catch(() => {
        for (const k of keys) if (!lastSaid.has(k)) lastSaid.set(k, null);
        done();
      });
  }
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/**
 * The switcher's list: the session on screen first, then the ones looked at since, newest first. A short
 * history — a fresh browser, a cleared one — is topped up with the running sessions it hasn't seen, the
 * ones with something going on ahead of the quiet ones.
 */
function switcherList(
  sessions: SessionInfo[],
  viewed: string[],
  activeKey: string | null,
  ids: ActivityIds
): SessionInfo[] {
  const byKey = new Map(sessions.map((s) => [s.id, s]));
  const out: SessionInfo[] = [];
  const taken = new Set<string>();
  const add = (s: SessionInfo | undefined) => {
    if (!s || taken.has(s.id) || out.length >= SHOWN) return;
    taken.add(s.id);
    out.push(s);
  };
  if (activeKey) add(byKey.get(activeKey));
  for (const k of viewed) add(byKey.get(k));
  const rest = sessions.filter((s) => !taken.has(s.id) && s.state !== "Restorable");
  for (const s of rest) if (sessionActivity(s, ids)) add(s);
  for (const s of rest) add(s);
  return out;
}

/**
 * Where Alt+Q goes: the most pressing session that needs you, other than the one on screen. Within a kind,
 * the one looked at longest ago comes first, so pressing it again walks on to the next instead of
 * bouncing between two.
 */
function nextNeedingYou(
  sessions: SessionInfo[],
  viewed: string[],
  activeKey: string | null,
  ids: ActivityIds
): SessionInfo | null {
  const age = new Map(viewed.map((k, i) => [k, i]));
  let best: { s: SessionInfo; rank: number; age: number } | null = null;
  for (const s of sessions) {
    if (s.id === activeKey || s.state === "Restorable" || s.activityPaused) continue;
    const a = sessionActivity(s, ids);
    const rank = a ? NEEDS_YOU.indexOf(a) : -1;
    if (rank < 0) continue;
    // Never looked at is the oldest of all.
    const ago = age.get(s.id) ?? Infinity;
    if (!best || rank < best.rank || (rank === best.rank && ago > best.age)) best = { s, rank, age: ago };
  }
  return best?.s ?? null;
}

export function SessionSwitcher({
  sessions,
  viewed,
  activeKey,
  activityIds,
  nodeNames,
  onSelect,
}: {
  /** Every machine's sessions, each under its session key. */
  sessions: SessionInfo[];
  /** Session keys looked at last, newest first (lib/recentlyViewed). */
  viewed: string[];
  activeKey: string | null;
  /** Keyed as `sessions` is. */
  activityIds: ActivityIds;
  nodeNames?: Record<string, string>;
  onSelect: (key: string) => void;
}) {
  // The list as it was when the switcher opened, and the row highlighted. Frozen, so a session going busy
  // mid-switch can't move the row under the highlight; the marks on it stay live. Kept in a ref as well as
  // in state: keys come faster than renders, and an Alt let go straight after Esc must find the switcher
  // already shut, not still open on the state of the last render.
  const [open, setOpen] = useState<{ list: SessionInfo[]; cursor: number } | null>(null);
  const openRef = useRef(open);
  const show = (next: { list: SessionInfo[]; cursor: number } | null) => {
    openRef.current = next;
    setOpen(next);
  };
  // A word for an Alt+Q that found nothing to go to, so the key doesn't look broken.
  const [notice, setNotice] = useState<string | null>(null);
  // Re-render as the latest messages come in (they live in `lastSaid`, outside React).
  const [, saidLanded] = useReducer((n: number) => n + 1, 0);
  const openList = open?.list;
  useEffect(() => {
    if (openList) fetchLastSaid(openList, saidLanded);
  }, [openList]);

  const latest = useRef({ sessions, viewed, activeKey, activityIds, onSelect });
  latest.current = { sessions, viewed, activeKey, activityIds, onSelect };

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 1600);
    return () => window.clearTimeout(t);
  }, [notice]);

  /** Shut the switcher on the highlighted row (or `index`), opening it unless it is the one on screen. */
  const commit = (index?: number) => {
    const o = openRef.current;
    show(null);
    const s = o?.list[index ?? o.cursor];
    if (s && s.id !== latest.current.activeKey) latest.current.onSelect(s.id);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    const swallow = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const o = openRef.current;
      if (o) {
        // Open: every key is the switcher's until Alt goes up, so none of them lands in the terminal.
        swallow(e);
        const step = (d: number) => show({ ...o, cursor: (o.cursor + d + o.list.length) % o.list.length });
        if (e.key === "Escape") show(null);
        else if (e.key === "Enter") commitRef.current();
        else if (e.code === "Backquote") step(e.shiftKey ? -1 : 1);
        else if (e.key === "ArrowDown") step(1);
        else if (e.key === "ArrowUp") step(-1);
        // Alt let go somewhere the keyup never reached (another window had focus for a moment).
        else if (!e.altKey) commitRef.current();
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code !== "Backquote" && !(e.code === "KeyQ" && !e.shiftKey)) return;
      // A dialog is a question waiting on an answer; switching away underneath it would strand it.
      if (document.querySelector('[role="dialog"]')) return;
      swallow(e);
      const { sessions: all, viewed: v, activeKey: cur, activityIds: ids, onSelect: select } = latest.current;
      if (e.code === "KeyQ") {
        const next = nextNeedingYou(all, v, cur, ids);
        if (next) select(next.id);
        else setNotice("Nothing needs you right now");
        return;
      }
      const list = switcherList(all, v, cur, ids);
      if (list.length < 2) {
        setNotice(list.length ? "No other session to switch to" : "No sessions yet");
        return;
      }
      setNotice(null);
      // Forward lands on the one before this, which is what a quick tap is for; Shift on the oldest.
      show({ list, cursor: e.shiftKey ? list.length - 1 : 1 });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!openRef.current) return;
      swallow(e);
      if (e.key === "Alt" || !e.altKey) commitRef.current();
    };
    // The window losing focus mid-switch (a real Alt+Tab, a click elsewhere) is a change of mind.
    const onBlur = () => show(null);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // Live rows for the frozen list: a session that went busy shows it, one that went away drops out.
  const rows = useMemo(() => {
    if (!open) return null;
    const byKey = new Map(sessions.map((s) => [s.id, s]));
    return open.list.map((s) => byKey.get(s.id) ?? s);
  }, [open, sessions]);
  const cursor = open?.cursor ?? 0;

  if (notice && !rows)
    return (
      <div className="pointer-events-none fixed inset-x-0 top-[18%] z-[60] flex justify-center px-4">
        <div className="rounded-md popover-edge bg-popover px-3 py-2 text-sm text-muted-foreground shadow-lg">
          {notice}
        </div>
      </div>
    );
  if (!rows) return null;

  return (
    // A dialog while it is up, which is also what the other Alt chords (the pane groups') stand down for.
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Switch session"
      className="fixed inset-0 z-[60] flex items-start justify-center bg-background/40 px-4 pt-[12vh]"
    >
      <div
        role="listbox"
        aria-label="Sessions"
        className="flex w-[36rem] max-w-full flex-col rounded-lg popover-edge bg-popover p-1 text-popover-foreground shadow-2xl"
      >
        {rows.map((s, i) => {
          const activity = sessionActivity(s, activityIds);
          const detail = activity ? activityDetail(activity, s.id, activityIds) : null;
          const color = sessionColor(s.color);
          const said = lastSaid.get(s.id);
          const where = s.nodeId
            ? `${nodeNames?.[s.nodeId] ?? "another machine"} · ${baseName(s.workingDirectory)}`
            : baseName(s.workingDirectory);
          return (
            <div
              key={s.id}
              role="option"
              aria-selected={i === cursor}
              // Move, not enter: the list opening under a pointer left resting there would otherwise take
              // the highlight off the row the key put it on.
              onMouseMove={() => open && i !== cursor && show({ ...open, cursor: i })}
              // Down, not click: the switcher closes on Alt's release, which can come before the click.
              onMouseDown={(e) => {
                e.preventDefault();
                commit(i);
              }}
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-sm",
                i === cursor && "bg-accent"
              )}
            >
              <span
                aria-hidden
                className="mt-1 h-3.5 w-1 shrink-0 rounded-full bg-muted-foreground/30"
                style={color ? { backgroundColor: color } : undefined}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className={cn("min-w-0 flex-1 truncate font-medium", s.state !== "Running" && "text-muted-foreground")}>
                    {s.name}
                  </span>
                  <span className="max-w-[45%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                    {s.id === activeKey ? "this session" : where}
                  </span>
                </span>
                {said ? (
                  <span className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
                    {said.who === "you" && <span className="font-medium text-foreground/70">You: </span>}
                    {said.text}
                  </span>
                ) : (
                  // Still coming: hold its line, so the rows don't jump when it lands.
                  said === undefined && s.claudeSessionId && <span className="mt-0.5 block h-4" />
                )}
                {(activity || s.state === "Restorable") && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                    {activity && (
                      <span className="flex w-2 shrink-0 justify-center">
                        <ActivityMark activity={activity} />
                      </span>
                    )}
                    <span className="truncate">
                      {activity ? (detail ?? ACTIVITY_MARK[activity].label) : "Closed"}
                    </span>
                  </span>
                )}
              </span>
            </div>
          );
        })}
        <div className="mt-1 flex justify-between gap-2 border-t px-2.5 pb-0.5 pt-1.5 text-[10px] text-muted-foreground">
          <span>` / ⇧` step · let go of {ALT} to open · esc cancel</span>
          <span>{ALT === "Alt" ? "Alt+Q" : "⌥Q"}: next that needs you</span>
        </div>
      </div>
    </div>
  );
}
