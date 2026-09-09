import { useEffect, useRef } from "react";
import type { SessionLink } from "@/types";
import { linkTabLabel } from "@/lib/sessionLinks";
import { cn } from "@/lib/utils";
import { LinkIcon } from "./LinkIcon";
import { Globe, Plus, SquareArrowOutUpRight, X } from "lucide-react";

/**
 * The web pages pinned to a session, as tabs at the end of its tab bar, plus the "+" that pins
 * another. A linked page is a view of the session in the same way a file or a shell is — the issue
 * it is working from sits one click away from the terminal doing the work.
 *
 * A page that will not be framed (see LinkDialog) still gets a tab: the tab is then a bookmark that
 * belongs to this session, and clicking it opens the page in a browser tab. The arrow on such a tab
 * is what says which of the two it is before you click it.
 */
export function LinkTabStrip({
  links,
  activeId,
  showingLink,
  onActivate,
  onEdit,
  onAdd,
  onClose,
}: {
  links: SessionLink[];
  activeId: string | null;
  /** Whether a link is the surface currently showing, as opposed to open but behind another tab. */
  showingLink: boolean;
  onActivate: (id: string) => void;
  onEdit: (id: string) => void;
  onAdd: () => void;
  onClose: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Same horizontal-wheel handling the file and shell tabs have, so a crowded bar scrolls the way it
  // looks like it should. Native and non-passive, since React's onWheel can't preventDefault.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY === 0 || el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="flex h-full min-w-0 items-stretch">
      {links.length > 0 && <div className="my-2 w-px shrink-0 bg-border" />}
      <div ref={scrollRef} className="hover-scrollbar flex min-w-0 items-stretch overflow-x-auto">
        {links.map((l) => {
          const current = l.id === activeId;
          const active = current && showingLink;
          return (
            <div
              key={l.id}
              role="tab"
              aria-selected={active}
              data-current={current}
              title={`${linkTabLabel(l)} — ${l.url}${l.embed ? "" : " (opens in a browser tab)"}\nDouble-click to edit`}
              onClick={() => onActivate(l.id)}
              onDoubleClick={() => onEdit(l.id)}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(l.id);
                }
              }}
              className={cn(
                "group/link flex h-full shrink-0 cursor-pointer items-center gap-1.5 border-b-2 pl-3 pr-2 text-sm font-medium transition-colors",
                active
                  ? "border-primary text-foreground"
                  : current && l.embed
                    ? "border-border text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground"
              )}
            >
              <LinkIcon src={l.icon} className="size-4 shrink-0 rounded-[2px]" />
              <span className="max-w-[10rem] truncate">{linkTabLabel(l)}</span>
              {/* A page that can't be framed never fills the pane, so its tab says up front that
                  clicking it leaves the app. */}
              {!l.embed && <SquareArrowOutUpRight className="size-3 shrink-0 opacity-60" />}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(l.id);
                }}
                title="Remove this link"
                className={cn(
                  "rounded p-0.5 hover:bg-accent hover:text-foreground",
                  current ? "opacity-100" : "opacity-0 group-hover/link:opacity-100"
                )}
              >
                <X className="size-3.5" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={onAdd}
        title="Link a web page to this session"
        className="flex shrink-0 items-center gap-0.5 pl-2 pr-3 text-muted-foreground hover:text-foreground"
      >
        <Plus className="size-3.5" />
        <Globe className="size-4" />
      </button>
    </div>
  );
}
