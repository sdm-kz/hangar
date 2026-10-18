import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  closeGroup,
  groupOf,
  groupsOf,
  MAX_GROUPS,
  measure,
  neighbour,
  setSplitSizes,
  type Edge,
  type Gutter,
  type PaneGroup,
  type PaneLayout,
  type PaneRef,
  type Rect,
} from "@/lib/layout";
import { useDismissable } from "@/lib/useDismissable";
import { cn } from "@/lib/utils";
import { TabScroll } from "./TabScroll";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";

/** How a tab draws in a group's strip. */
export interface PaneTab {
  icon: ReactNode;
  label: ReactNode;
  title?: string;
  /** The Claude terminal and the Files explorer are always somewhere; everything else can go. */
  closable: boolean;
  onDoubleClick?: () => void;
}

/** Where a dragged tab is dropped on a group: one of its edges (a new split) or its middle (a move). */
export type DropZone = Edge | "center";

const DRAG_TYPE = "application/x-hangar-pane";
// Narrowest a group may be dragged to, along the axis of the split: a strip still worth clicking.
const MIN_GROUP_PX = 160;

/**
 * The session pane, split into groups of tabs (see lib/layout.ts).
 *
 * Every group is drawn flat, absolutely positioned from the layout's geometry, rather than nested
 * the way the tree is: a group then stays the same DOM element however the tree around it is
 * reshaped. What a tab shows is rendered once, through a portal, into a container of its own, and
 * that container is moved into whichever group holds the tab. Moving a tab between groups therefore
 * moves a DOM node and never remounts it — a terminal keeps its socket and its scrollback, a review
 * keeps where it was scrolled to. (A frame is the exception: the browser reloads an iframe that
 * moves, which is the price of a page being dragged somewhere else.)
 */
export function PaneGroups({
  layout,
  update,
  wide,
  tabInfo,
  renderContent,
  onActivate,
  onClose,
  onDrop,
  renderAdd,
  onContentFocus,
  onCloseAllFiles,
}: {
  layout: PaneLayout;
  update: (fn: (l: PaneLayout) => PaneLayout, persist?: boolean) => void;
  /** Room for groups side by side. Narrow, they fold into one strip and one group is drawn. */
  wide: boolean;
  tabInfo: (ref: PaneRef) => PaneTab | null;
  /** What a tab shows, or null to leave it unmounted for now. */
  renderContent: (ref: PaneRef) => ReactNode | null;
  /** A tab clicked: show it in its group and give the group focus. */
  onActivate: (ref: PaneRef) => void;
  onClose: (ref: PaneRef) => void;
  /** A tab dropped on a group, or split off from its own with a button or the menu. */
  onDrop: (ref: PaneRef, groupId: string, zone: DropZone, index?: number) => void;
  /** The "+" controls at the end of a group's strip. */
  renderAdd: (groupId: string) => ReactNode;
  /** Focus moved to a group by keyboard: put the keys into what it shows. */
  onContentFocus: (ref: PaneRef) => void;
  /** Close every open file tab (offered in a file tab's menu). */
  onCloseAllFiles: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const groups = groupsOf(layout.root);
  const { rects, gutters } = measure(layout);
  const many = groups.length > 1;
  const [dragging, setDragging] = useState<PaneRef | null>(null);
  const [resizing, setResizing] = useState(false);
  const [menu, setMenu] = useState<{ ref: PaneRef; x: number; y: number } | null>(null);

  // One container per tab, kept across renders. Created on first ask; dropped once the tab is gone.
  const hosts = useRef(new Map<PaneRef, HTMLDivElement>());
  const hostFor = useCallback((ref: PaneRef) => {
    let el = hosts.current.get(ref);
    if (!el) {
      el = document.createElement("div");
      el.className = "absolute inset-0 flex min-h-0 min-w-0 flex-col";
      el.dataset.pane = ref;
      hosts.current.set(ref, el);
    }
    return el;
  }, []);
  const placed = groups.flatMap((g) => g.tabs);
  useEffect(() => {
    for (const [ref, el] of hosts.current)
      if (!placed.includes(ref)) {
        el.remove();
        hosts.current.delete(ref);
      }
  });

  // Which group is on screen, and where. Narrow, or with a group zoomed, that is one group filling
  // the pane; the others stay mounted and are hidden, so nothing in them drops its connection.
  const shownId = !wide ? layout.active : layout.max ?? null;
  const full: Rect = { x: 0, y: 0, w: 1, h: 1 };
  const rectOf = (g: PaneGroup): Rect | null => (shownId ? (g.id === shownId ? full : null) : rects.get(g.id) ?? null);

  const focusGroup = useCallback(
    (id: string) => update((l) => (l.active === id ? l : { ...l, active: id, max: l.max && l.max !== id ? null : l.max })),
    [update]
  );

  // ---- Keyboard ---------------------------------------------------------------------------------
  // Alt-based, because the terminal owns Ctrl (Ctrl+W, Ctrl+\ and the rest are keys programs read)
  // and the browser owns Ctrl+Tab. Captured before xterm sees them, and only these exact chords.
  const latest = useRef({ layout, wide, onDrop, onContentFocus });
  latest.current = { layout, wide, onDrop, onContentFocus };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { layout: l, wide: w, onDrop: drop, onContentFocus: focus } = latest.current;
      if (!w || !e.altKey || e.ctrlKey || e.metaKey) return;
      // Text being typed keeps its keys — Alt/Option chords type characters on some keyboards, and
      // Alt+Shift+arrow selects words. The terminals' own input box is the one field exempted: a
      // terminal is where focus usually is, and these chords are what it would lose them to.
      const t = e.target as HTMLElement | null;
      const typing =
        !!t &&
        (t.isContentEditable ||
          (t.tagName === "INPUT") ||
          (t.tagName === "TEXTAREA" && !t.classList.contains("xterm-helper-textarea")) ||
          t.tagName === "SELECT");
      if (typing || document.querySelector('[role="dialog"]')) return;
      const gs = groupsOf(l.root);
      const cur = gs.find((g) => g.id === l.active);
      let handled = false;
      if (!e.shiftKey && (e.code === "Backslash" || e.code === "Minus")) {
        if (cur?.active) {
          drop(cur.active, cur.id, e.code === "Backslash" ? "right" : "bottom");
          handled = true;
        }
      } else if (!e.shiftKey && /^Digit[1-4]$/.test(e.code)) {
        // Only with groups to move between: alone, Alt+digit is a key the shell has uses for.
        const g = gs.length > 1 ? gs[Number(e.code.slice(5)) - 1] : undefined;
        if (g) {
          focusGroup(g.id);
          if (g.active) focus(g.active);
          handled = true;
        }
      } else if (!e.shiftKey && e.code === "KeyZ") {
        if (gs.length > 1) {
          update((x) => ({ ...x, max: x.max ? null : x.active }));
          handled = true;
        }
      } else if (e.shiftKey && e.code.startsWith("Arrow") && cur?.active) {
        // Alt+Shift+arrow: send the tab to the group that way, the way it would go by drag.
        const edge = ({ ArrowLeft: "left", ArrowRight: "right", ArrowUp: "top", ArrowDown: "bottom" } as const)[
          e.code as "ArrowLeft"
        ];
        const next = neighbour(l, cur.id, edge);
        if (next) drop(cur.active, next, "center");
        else if (cur.tabs.length > 1) drop(cur.active, cur.id, edge);
        handled = !!next || cur.tabs.length > 1;
      }
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focusGroup, update]);

  // ---- Resizing ---------------------------------------------------------------------------------
  const startResize = useCallback(
    (e: React.PointerEvent, g: Gutter) => {
      e.preventDefault();
      // Captured, so a release outside the window still ends the drag here.
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* a pointer no longer active — the listeners below still see it through */
      }
      const box = containerRef.current?.getBoundingClientRect();
      if (!box) return;
      const row = g.dir === "row";
      // The split's own box in pixels: the drag moves the one boundary within it.
      const origin = row ? box.left + g.box.x * box.width : box.top + g.box.y * box.height;
      const span = row ? g.box.w * box.width : g.box.h * box.height;
      const before = g.sizes.slice(0, g.index).reduce((a, b) => a + b, 0);
      const pair = g.sizes[g.index] + g.sizes[g.index + 1];
      const min = Math.min(pair / 2, MIN_GROUP_PX / Math.max(1, span));
      const at = (ev: PointerEvent) => {
        const f = ((row ? ev.clientX : ev.clientY) - origin) / span - before;
        const a = Math.min(pair - min, Math.max(min, f));
        const sizes = [...g.sizes];
        sizes[g.index] = a;
        sizes[g.index + 1] = pair - a;
        return sizes;
      };
      let last = g.sizes;
      const onMove = (ev: PointerEvent) => {
        // The button came up somewhere nothing reported it: the drag is over.
        if (ev.buttons === 0) return onUp();
        last = at(ev);
        update((l) => setSplitSizes(l, g.splitId, last), false);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setResizing(false);
        update((l) => setSplitSizes(l, g.splitId, last));
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      document.body.style.cursor = row ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
      // Frames swallow pointer events; a cover over the pane keeps the drag ours while it lasts.
      setResizing(true);
    },
    [update]
  );

  const equalize = useCallback(
    (g: Gutter) => {
      const sizes = [...g.sizes];
      const pair = sizes[g.index] + sizes[g.index + 1];
      sizes[g.index] = sizes[g.index + 1] = pair / 2;
      update((l) => setSplitSizes(l, g.splitId, sizes));
    },
    [update]
  );

  // ---- Dragging tabs ----------------------------------------------------------------------------
  const onTabDragStart = useCallback((e: React.DragEvent, ref: PaneRef) => {
    e.dataTransfer.setData(DRAG_TYPE, ref);
    e.dataTransfer.effectAllowed = "move";
    // Set just after: changing the DOM under the drag source in dragstart itself cancels the drag in
    // Chromium. A timeout rather than a frame, which a window the browser thinks is hidden never gets.
    window.setTimeout(() => setDragging(ref), 0);
  }, []);
  const onTabDragEnd = useCallback(() => setDragging(null), []);
  useEffect(() => {
    if (!dragging) return;
    // A drop outside any target never fires dragend on a source that has since moved; the next
    // pointer move after the button is up is as good a signal.
    const clear = () => setDragging(null);
    window.addEventListener("drop", clear);
    window.addEventListener("pointermove", clear, { once: true });
    return () => {
      window.removeEventListener("drop", clear);
      window.removeEventListener("pointermove", clear);
    };
  }, [dragging]);

  const menuTab = menu ? groupOf(layout, menu.ref) : undefined;

  return (
    <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
      {groups.map((g, i) => {
        const r = rectOf(g);
        return (
          <GroupView
            key={g.id}
            group={g}
            index={i}
            rect={r}
            wide={wide}
            focused={g.id === layout.active}
            many={many && !!wide && !shownId}
            maximized={layout.max === g.id}
            canSplit={groups.length < MAX_GROUPS}
            // Narrow, one strip stands for every group: the tabs of all of them, in reading order.
            stripTabs={wide ? g.tabs : groups.flatMap((x) => x.tabs)}
            stripActive={wide ? g.active : groups.find((x) => x.id === layout.active)?.active ?? null}
            tabInfo={tabInfo}
            hostFor={hostFor}
            dragging={dragging}
            onFocus={() => focusGroup(g.id)}
            onActivate={onActivate}
            onClose={onClose}
            onMenu={(ref, x, y) => setMenu({ ref, x, y })}
            onDragStart={onTabDragStart}
            onDragEnd={onTabDragEnd}
            onDrop={(ref, zone, index) => {
              setDragging(null);
              onDrop(ref, g.id, zone, index);
            }}
            onSplit={(edge) => (g.active ? onDrop(g.active, g.id, edge) : undefined)}
            onToggleMax={() => update((l) => ({ ...l, active: g.id, max: l.max === g.id ? null : g.id }))}
            onCloseGroup={() => update((l) => closeGroup(l, g.id))}
            add={renderAdd(g.id)}
          />
        );
      })}

      {/* The boundaries between groups, drawn over their edges so they take no room of their own. */}
      {wide &&
        !shownId &&
        gutters.map((g) => (
          <div
            key={`${g.splitId}:${g.index}`}
            onPointerDown={(e) => startResize(e, g)}
            onDoubleClick={() => equalize(g)}
            title="Drag to resize · double-click to share evenly"
            className={cn(
              "absolute z-20 transition-colors hover:bg-primary/25 active:bg-primary/35",
              g.dir === "row" ? "w-1.5 -translate-x-1/2 cursor-col-resize" : "h-1.5 -translate-y-1/2 cursor-row-resize"
            )}
            style={{
              left: `${g.at.x * 100}%`,
              top: `${g.at.y * 100}%`,
              width: g.dir === "row" ? undefined : `${g.at.w * 100}%`,
              height: g.dir === "row" ? `${g.at.h * 100}%` : undefined,
            }}
          />
        ))}
      {resizing && <div className="absolute inset-0 z-30" />}

      {/* Each tab's content, rendered into its own container wherever that container now sits. */}
      {placed.map((ref) => {
        const content = renderContent(ref);
        return content === null ? null : createPortal(content, hostFor(ref), ref);
      })}

      {menu && menuTab && (
        <TabMenu
          x={menu.x}
          y={menu.y}
          closable={!!tabInfo(menu.ref)?.closable}
          canSplit={groups.length < MAX_GROUPS && menuTab.tabs.length > 1}
          others={groups.filter((g) => g.id !== menuTab.id).map((g) => ({ id: g.id, n: groups.indexOf(g) + 1 }))}
          maximized={layout.max === menuTab.id}
          canMax={groups.length > 1 && wide}
          onSplit={(edge) => onDrop(menu.ref, menuTab.id, edge)}
          onMove={(id) => onDrop(menu.ref, id, "center")}
          onToggleMax={() =>
            update((l) => ({ ...l, active: menuTab.id, max: l.max === menuTab.id ? null : menuTab.id }))
          }
          onClose={() => onClose(menu.ref)}
          onCloseAllFiles={menu.ref.startsWith("file:") ? onCloseAllFiles : undefined}
          onDismiss={() => setMenu(null)}
        />
      )}
    </div>
  );
}

function GroupView({
  group,
  index,
  rect,
  wide,
  focused,
  many,
  maximized,
  canSplit,
  stripTabs,
  stripActive,
  tabInfo,
  hostFor,
  dragging,
  onFocus,
  onActivate,
  onClose,
  onMenu,
  onDragStart,
  onDragEnd,
  onDrop,
  onSplit,
  onToggleMax,
  onCloseGroup,
  add,
}: {
  group: PaneGroup;
  index: number;
  /** Where it sits; null when it is not on screen (narrow, or another group zoomed). */
  rect: Rect | null;
  wide: boolean;
  focused: boolean;
  /** More than one group on screen — worth marking which has focus. */
  many: boolean;
  maximized: boolean;
  canSplit: boolean;
  stripTabs: PaneRef[];
  stripActive: PaneRef | null;
  tabInfo: (ref: PaneRef) => PaneTab | null;
  hostFor: (ref: PaneRef) => HTMLDivElement;
  dragging: PaneRef | null;
  onFocus: () => void;
  onActivate: (ref: PaneRef) => void;
  onClose: (ref: PaneRef) => void;
  onMenu: (ref: PaneRef, x: number, y: number) => void;
  onDragStart: (e: React.DragEvent, ref: PaneRef) => void;
  onDragEnd: () => void;
  onDrop: (ref: PaneRef, zone: DropZone, index?: number) => void;
  onSplit: (edge: Edge) => void;
  onToggleMax: () => void;
  onCloseGroup: () => void;
  add: ReactNode;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const [zone, setZone] = useState<DropZone | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);

  // Keep this group's tab containers inside it, the active one showing. Every render, because a tab
  // can arrive from another group at any time; appendChild on a node already here is a no-op check.
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    for (const ref of group.tabs) {
      const host = hostFor(ref);
      if (host.parentNode !== slot) slot.appendChild(host);
      const show = ref === group.active;
      if ((host.style.display === "none") === show) host.style.display = show ? "" : "none";
    }
  });

  useEffect(() => {
    if (!dragging) {
      setZone(null);
      setDropAt(null);
    }
  }, [dragging]);

  const zoneAt = (e: React.DragEvent): DropZone => {
    const b = e.currentTarget.getBoundingClientRect();
    const fx = (e.clientX - b.left) / b.width;
    const fy = (e.clientY - b.top) / b.height;
    if (!canSplit) return "center";
    const d = Math.min(fx, 1 - fx, fy, 1 - fy);
    if (d > 0.25) return "center";
    if (d === fx) return "left";
    if (d === 1 - fx) return "right";
    return d === fy ? "top" : "bottom";
  };

  const droppedRef = (e: React.DragEvent) => e.dataTransfer.getData(DRAG_TYPE) || dragging;

  return (
    <div
      className={cn(
        "absolute flex min-h-0 min-w-0 flex-col",
        !rect && "hidden",
        rect && rect.x > 0 && "border-l",
        rect && rect.y > 0 && "border-t"
      )}
      style={
        rect
          ? { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }
          : undefined
      }
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
    >
      {/* The strip. With several groups on screen the focused one says so along its top edge. */}
      <div
        className={cn(
          // h-10, the height of the sidebar's own tab bar beside it, so the two lines under them meet.
          "relative flex h-10 shrink-0 items-stretch border-b",
          many && (focused ? "bg-background" : "bg-muted/40")
        )}
        onDragOver={(e) => {
          if (!dragging) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
          // Past the last tab: the end of the strip.
          if (e.target === e.currentTarget) setDropAt(stripTabs.length);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropAt(null);
        }}
        onDrop={(e) => {
          const ref = droppedRef(e);
          if (!ref) return;
          e.preventDefault();
          onDrop(ref, "center", dropAt ?? undefined);
          setDropAt(null);
        }}
      >
        {many && focused && <span aria-hidden className="absolute inset-x-0 top-0 h-0.5 bg-primary" />}
        <TabScroll revealOn={`${stripActive ?? ""}|${stripTabs.length}`}>
          {stripTabs.map((ref, i) => {
            const info = tabInfo(ref);
            if (!info) return null;
            const active = ref === stripActive;
            return (
              <div
                key={ref}
                role="tab"
                aria-selected={active}
                data-current={active}
                title={info.title}
                draggable={wide}
                onDragStart={(e) => onDragStart(e, ref)}
                onDragEnd={onDragEnd}
                onDragOver={(e) => {
                  if (!dragging) return;
                  e.preventDefault();
                  const b = e.currentTarget.getBoundingClientRect();
                  setDropAt(e.clientX < b.left + b.width / 2 ? i : i + 1);
                }}
                onClick={() => onActivate(ref)}
                onDoubleClick={info.onDoubleClick}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(ref, e.clientX, e.clientY);
                }}
                onMouseDown={(e) => {
                  if (e.button === 1 && info.closable) {
                    e.preventDefault();
                    onClose(ref);
                  }
                }}
                className={cn(
                  "group/tab relative flex h-full shrink-0 cursor-pointer select-none items-center gap-1.5 border-b-2 pl-3 text-sm font-medium transition-colors",
                  info.closable ? "pr-2" : "pr-3",
                  active
                    ? focused || !many
                      ? "border-primary text-foreground"
                      : "border-muted-foreground/40 text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                  dragging === ref && "opacity-50"
                )}
              >
                {dropAt === i && <span aria-hidden className="absolute inset-y-1 left-0 w-0.5 bg-primary" />}
                {dropAt === i + 1 && i === stripTabs.length - 1 && (
                  <span aria-hidden className="absolute inset-y-1 right-0 w-0.5 bg-primary" />
                )}
                {info.icon}
                {info.label}
                {info.closable && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(ref);
                    }}
                    title="Close tab"
                    className={cn(
                      "rounded p-0.5 hover:bg-accent hover:text-foreground",
                      active ? "opacity-100" : "opacity-0 group-hover/tab:opacity-100"
                    )}
                  >
                    <X className="size-3.5" />
                  </button>
                )}
              </div>
            );
          })}
        </TabScroll>
        <div className="flex shrink-0 items-stretch">
          {add}
          {wide && (
            <>
              <div className="my-2 w-px shrink-0 bg-border" />
              <StripButton
                title={canSplit ? "Split right (Alt+\\)" : `At most ${MAX_GROUPS} groups`}
                disabled={!canSplit || !group.active}
                onClick={() => onSplit("right")}
              >
                <Columns2 className="size-4" />
              </StripButton>
              <StripButton
                title={canSplit ? "Split down (Alt+-)" : `At most ${MAX_GROUPS} groups`}
                disabled={!canSplit || !group.active}
                onClick={() => onSplit("bottom")}
              >
                <Rows2 className="size-4" />
              </StripButton>
              {(many || maximized) && (
                <StripButton title={maximized ? "Restore the other groups (Alt+Z)" : "Maximize this group (Alt+Z)"} onClick={onToggleMax}>
                  {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
                </StripButton>
              )}
              {(many || maximized) && (
                <StripButton title="Close this group — its tabs move to the group beside it" onClick={onCloseGroup}>
                  <X className="size-4" />
                </StripButton>
              )}
            </>
          )}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* The tab containers are put in here by hand (see the layout effect above), so React must
            not own any children of this element. */}
        <div ref={slotRef} className="absolute inset-0" />
        {group.tabs.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
            <p>Group {index + 1} is empty</p>
            <p className="text-xs">Drag a tab here, or open one with the + above.</p>
          </div>
        )}
        {/* While a tab is being dragged, a cover over the content takes the drag events a terminal
            or a frame would otherwise swallow, and shows where the tab would land. */}
        {dragging && (
          <div
            className="absolute inset-0 z-20"
            onDragOver={(e) => {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const z = zoneAt(e);
              if (z !== zone) setZone(z);
            }}
            onDragLeave={() => setZone(null)}
            onDrop={(e) => {
              const ref = droppedRef(e);
              if (!ref) return;
              e.preventDefault();
              const z = zoneAt(e);
              setZone(null);
              onDrop(ref, z);
            }}
          >
            {zone && (
              <div
                className="pointer-events-none absolute rounded-sm border-2 border-primary/60 bg-primary/15 transition-all"
                style={
                  zone === "center"
                    ? { inset: 4 }
                    : zone === "left"
                      ? { left: 4, top: 4, bottom: 4, width: "calc(50% - 4px)" }
                      : zone === "right"
                        ? { right: 4, top: 4, bottom: 4, width: "calc(50% - 4px)" }
                        : zone === "top"
                          ? { left: 4, right: 4, top: 4, height: "calc(50% - 4px)" }
                          : { left: 4, right: 4, bottom: 4, height: "calc(50% - 4px)" }
                }
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StripButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex shrink-0 items-center px-1.5 text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground"
    >
      {children}
    </button>
  );
}

/** A tab's right-click menu: where else it can go, and closing it. */
function TabMenu({
  x,
  y,
  closable,
  canSplit,
  others,
  maximized,
  canMax,
  onSplit,
  onMove,
  onToggleMax,
  onClose,
  onCloseAllFiles,
  onDismiss,
}: {
  x: number;
  y: number;
  closable: boolean;
  canSplit: boolean;
  others: { id: string; n: number }[];
  maximized: boolean;
  canMax: boolean;
  onSplit: (edge: Edge) => void;
  onMove: (groupId: string) => void;
  onToggleMax: () => void;
  onClose: () => void;
  onCloseAllFiles?: () => void;
  onDismiss: () => void;
}) {
  const ref = useDismissable<HTMLDivElement>(true, onDismiss);
  // Kept on screen: a menu opened near the right or bottom edge flips back inside it.
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    setPos({
      left: Math.max(4, Math.min(x, window.innerWidth - b.width - 4)),
      top: Math.max(4, Math.min(y, window.innerHeight - b.height - 4)),
    });
  }, [x, y, ref]);
  const item = (label: string, fn: () => void, disabled = false) => (
    <button
      key={label}
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        fn();
        onDismiss();
      }}
      className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {label}
    </button>
  );
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 w-52 rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
      style={pos}
    >
      {item("Split right", () => onSplit("right"), !canSplit)}
      {item("Split down", () => onSplit("bottom"), !canSplit)}
      {others.map((o) => item(`Move to group ${o.n}`, () => onMove(o.id)))}
      {canMax && item(maximized ? "Restore groups" : "Maximize group", onToggleMax)}
      {closable && (
        <>
          <div className="my-1 h-px bg-border" />
          {item("Close", onClose)}
          {onCloseAllFiles && item("Close all files", onCloseAllFiles)}
        </>
      )}
    </div>
  );
}
