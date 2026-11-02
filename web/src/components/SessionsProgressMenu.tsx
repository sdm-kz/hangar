import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckCheck } from "lucide-react";
import { cn } from "@/lib/utils";
import { HeadingProgress } from "@/components/SessionSidebar";
import { ActivityMark, activityDetail, sessionActivity, type Activity } from "@/components/ActivityMark";
import { useDismissable } from "@/lib/useDismissable";
import { countsInTotals, type ActivityIds } from "@/lib/sessionActivity";
import type { SessionInfo } from "@/types";

/**
 * How much of everything running has finished -- the Sessions tab's fraction -- and what it was
 * counted from, so the fraction can open onto the sessions behind it. Provided once by the app so
 * the Sessions tab and every view's "Show sidebar" button can carry it without threading props.
 *
 * Over every machine listed: a peer's sessions are in `sessions` under their sessionKey as `id`, with
 * the sets in `activityIds` keyed the same way, and `onSelect` / `onMarkSeen` take those keys.
 */
export interface SessionsProgress {
  done: number;
  active: number;
  sessions: SessionInfo[];
  /** The peers' names, by node id, for a peer's session to say where it is. */
  nodeNames?: Record<string, string>;
  activityIds: ActivityIds | null;
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Clears finished ticks without opening anything -- the sidebar's "Mark seen". */
  onMarkSeen: (ids: Iterable<string>) => void;
}

export const SessionsProgressContext = createContext<SessionsProgress>({
  done: 0,
  active: 0,
  sessions: [],
  activityIds: null,
  activeId: null,
  onSelect: () => {},
  onMarkSeen: () => {},
});

/**
 * The dropdown's sections, most urgent first: what is asking for you, what is still going, and what
 * has landed since you last looked. Every activity the fraction counts falls in exactly one.
 */
const GROUPS: { title: string; activities: Activity[] }[] = [
  { title: "Waiting on you", activities: ["waiting", "attention", "failed"] },
  { title: "Working", activities: ["busy", "compacting", "recovering"] },
  { title: "Finished", activities: ["done"] },
];

function baseName(p: string): string {
  const parts = p.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * The running-sessions fraction as a button that drops down the sessions it counts, grouped by what
 * they are doing -- so checking on them costs neither the sidebar's room nor the session you are in.
 * Picking one from the list still goes there, and a finished one can be marked seen from the list
 * without going there at all. Worn by the Sessions tab and, with the sidebar collapsed, by the
 * "Show sidebar" button beside it.
 *
 * Not positioned itself: the list hangs off the nearest positioned ancestor, so the caller decides
 * what it lines up under -- the button, or the whole tab row where the tab sits mid-sidebar.
 */
export function SessionsProgressMenu({ triggerClassName }: { triggerClassName?: string }) {
  const { done, active, sessions, nodeNames, activityIds, activeId, onSelect, onMarkSeen } =
    useContext(SessionsProgressContext);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable<HTMLDivElement>(open, close);
  // Everything stopped with the list open: the fraction that toggles it is gone, so the list goes too.
  useEffect(() => {
    if (active <= 0) setOpen(false);
  }, [active]);

  // The list hangs from the left of whatever it is anchored to, and on a phone that is a menu button
  // already a way in: slid back by however much would run off the right edge, never past the left.
  const popupRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);
  // Measured once per opening, before paint, while the shift is still the 0 that closing left it at.
  useLayoutEffect(() => {
    if (!open) return setShift(0);
    const r = popupRef.current?.getBoundingClientRect();
    if (!r) return;
    const margin = 8;
    setShift(Math.max(margin - r.left, Math.min(0, window.innerWidth - margin - r.right)));
  }, [open]);

  const rows =
    open && activityIds
      ? sessions
          .filter(countsInTotals) // as folderProgress: a closed session isn't running, a paused one isn't counted
          .map((s) => ({ s, activity: sessionActivity(s, activityIds) }))
          .filter((r): r is { s: SessionInfo; activity: Activity } => r.activity !== null)
      : [];

  return (
    // Clicks stay in here: on the Sessions tab, a click that reached the tab would switch to it.
    <div ref={ref} className="flex items-center" onClick={(e) => e.stopPropagation()}>
      {active > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Show running sessions"
          className={cn(
            "flex items-center rounded-md transition-colors hover:bg-accent",
            triggerClassName,
            open && "bg-accent"
          )}
        >
          <HeadingProgress done={done} active={active} />
        </button>
      )}
      {open && active > 0 && activityIds && (
        <div
          ref={popupRef}
          role="menu"
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className="absolute left-0 top-full z-50 mt-1 flex max-h-[min(32rem,calc(100dvh-8rem))] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-md popover-edge bg-popover p-1 text-left font-normal text-popover-foreground shadow-md"
        >
          {GROUPS.map(({ title, activities }) => {
            const group = rows.filter((r) => activities.includes(r.activity));
            if (group.length === 0) return null;
            return (
              <div key={title} className="pb-1">
                <div className="flex items-center gap-2 px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
                  <span className="flex-1">
                    {title} <span className="tabular-nums">· {group.length}</span>
                  </span>
                  {title === "Finished" && group.length > 1 && (
                    <button
                      type="button"
                      onClick={() => onMarkSeen(group.map((r) => r.s.id))}
                      title={`Mark ${group.length} finished sessions as seen`}
                      className="flex items-center gap-1 rounded px-1 text-emerald-600 hover:bg-accent hover:text-emerald-500 dark:text-emerald-500"
                    >
                      <CheckCheck className="size-3.5" />
                      Mark all seen
                    </button>
                  )}
                </div>
                {group.map(({ s, activity }) => {
                  const detail = activityDetail(activity, s.id, activityIds);
                  return (
                    <div
                      key={s.id}
                      className={cn("group flex items-start rounded hover:bg-accent", s.id === activeId && "bg-accent/50")}
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onSelect(s.id);
                          close();
                        }}
                        title={s.workingDirectory}
                        className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-sm"
                      >
                        <span className="flex h-5 w-2 shrink-0 items-center justify-center">
                          <ActivityMark activity={activity} label={detail ?? undefined} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate">{s.name}</span>
                            <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                              {s.id === activeId
                                ? "this session"
                                : s.nodeId
                                  ? `${nodeNames?.[s.nodeId] ?? "another machine"} · ${baseName(s.workingDirectory)}`
                                  : baseName(s.workingDirectory)}
                            </span>
                          </span>
                          {detail && (
                            <span className="line-clamp-2 text-xs text-muted-foreground">{detail}</span>
                          )}
                        </span>
                      </button>
                      {activity === "done" && (
                        // Hover-revealed like the sidebar row's, so a list of ticks isn't a column of buttons.
                        <button
                          type="button"
                          onClick={() => onMarkSeen([s.id])}
                          title="Mark as seen"
                          aria-label={`Mark ${s.name} as seen`}
                          className="invisible mr-1 mt-1 flex size-6 shrink-0 items-center justify-center rounded text-emerald-600 hover:bg-background/60 hover:text-emerald-500 group-hover:visible focus-visible:visible dark:text-emerald-500 [@media(hover:none)]:visible"
                        >
                          <CheckCheck className="size-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
