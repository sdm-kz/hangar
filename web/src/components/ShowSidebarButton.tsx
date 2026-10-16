import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { PanelLeftOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { HeadingProgress } from "@/components/SessionSidebar";
import { ActivityMark, activityDetail, sessionActivity, type Activity } from "@/components/ActivityMark";
import { useDismissable } from "@/lib/useDismissable";
import type { ActivityIds } from "@/lib/sessionActivity";
import type { SessionInfo } from "@/types";

/**
 * How much of everything running has finished -- the Sessions tab's fraction -- and what it was
 * counted from, so the fraction can open onto the sessions behind it. Provided once by the app so
 * every view's "Show sidebar" button can carry it without each one threading a prop through.
 */
export interface SessionsProgress {
  done: number;
  active: number;
  sessions: SessionInfo[];
  activityIds: ActivityIds | null;
  activeId: string | null;
  onSelect: (id: string) => void;
}

export const SessionsProgressContext = createContext<SessionsProgress>({
  done: 0,
  active: 0,
  sessions: [],
  activityIds: null,
  activeId: null,
  onSelect: () => {},
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
 * The desktop button that brings a collapsed sidebar back. With the sidebar hidden, the Sessions
 * tab's "2/3" is hidden with it, and that is the one thing worth knowing without opening it -- so
 * the button carries the fraction itself. The fraction is its own button: it drops down the
 * sessions it counts, grouped by what they are doing, so checking on them costs neither the
 * sidebar's room nor the session you are in. Picking one from the list still goes there.
 */
export function ShowSidebarButton({ onClick, className }: { onClick: () => void; className?: string }) {
  const { done, active, sessions, activityIds, activeId, onSelect } = useContext(SessionsProgressContext);
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable<HTMLDivElement>(open, close);
  // Everything stopped with the list open: the fraction that toggles it is gone, so the list goes too.
  useEffect(() => {
    if (active <= 0) setOpen(false);
  }, [active]);

  const rows =
    open && activityIds
      ? sessions
          .filter((s) => s.state !== "Restorable") // as folderProgress: a closed session isn't running
          .map((s) => ({ s, activity: sessionActivity(s, activityIds) }))
          .filter((r): r is { s: SessionInfo; activity: Activity } => r.activity !== null)
      : [];

  return (
    <div ref={ref} className={cn("relative hidden shrink-0 items-center md:flex", className)}>
      <Button variant="ghost" size="icon" title="Show sidebar" onClick={onClick}>
        <PanelLeftOpen />
      </Button>
      {active > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Show running sessions"
          className={cn(
            "-ml-1 flex h-9 items-center rounded-md px-1.5 transition-colors hover:bg-accent",
            open && "bg-accent"
          )}
        >
          <HeadingProgress done={done} active={active} />
        </button>
      )}
      {open && active > 0 && activityIds && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 flex max-h-[min(32rem,calc(100dvh-8rem))] w-80 max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
        >
          {GROUPS.map(({ title, activities }) => {
            const group = rows.filter((r) => activities.includes(r.activity));
            if (group.length === 0) return null;
            return (
              <div key={title} className="pb-1">
                <div className="px-2 pb-1 pt-1.5 text-[11px] text-muted-foreground">
                  {title} <span className="tabular-nums">· {group.length}</span>
                </div>
                {group.map(({ s, activity }) => {
                  const detail = activityDetail(activity, s.id, activityIds);
                  return (
                    <button
                      key={s.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        onSelect(s.id);
                        close();
                      }}
                      title={s.workingDirectory}
                      className={cn(
                        "flex w-full items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent",
                        s.id === activeId && "bg-accent/50"
                      )}
                    >
                      <span className="flex h-5 w-2 shrink-0 items-center justify-center">
                        <ActivityMark activity={activity} label={detail ?? undefined} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate">{s.name}</span>
                          <span className="max-w-[40%] shrink-0 truncate font-mono text-[11px] text-muted-foreground">
                            {s.id === activeId ? "this session" : baseName(s.workingDirectory)}
                          </span>
                        </span>
                        {detail && (
                          <span className="line-clamp-2 text-xs text-muted-foreground">{detail}</span>
                        )}
                      </span>
                    </button>
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
