import { useRef, useState } from "react";
import clsx from "clsx";
import { Plus, X } from "lucide-react";
import { moveItem, type Page } from "./pages";

type Drag = { id: string; pointer: number; from: number; to: number; x0: number; moved: boolean };

/**
 * The captures in this editor, in the order they will be sent: click one to draw on it, drag one to
 * reorder, × to drop it. Shown once there is more than one.
 */
export function PageStrip(props: {
  pages: Page[];
  active: string | null;
  onSelect(id: string): void;
  onRemove(id: string): void;
  onMove(from: number, to: number): void;
  onAdd(): void;
  canAdd: boolean;
  mod: string;
}) {
  const { pages, active } = props;
  const [drag, setDrag] = useState<Drag | null>(null);
  const tiles = useRef(new Map<string, HTMLDivElement>());
  // While dragging, the strip shows the order a drop would leave.
  const shown = drag ? moveItem(pages, drag.from, drag.to) : pages;

  // Where the dragged tile goes: past every other tile whose middle is left of the pointer.
  const slotAt = (x: number, id: string) =>
    pages.filter((p) => {
      if (p.id === id) return false;
      const box = tiles.current.get(p.id)?.getBoundingClientRect();
      return !!box && box.left + box.width / 2 < x;
    }).length;

  return (
    <div className="flex h-[68px] shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-panel px-3" role="tablist" aria-label="Captures">
      {shown.map((p) => {
        const index = pages.indexOf(p);
        return (
          <div
            key={p.id}
            ref={(el) => {
              if (el) tiles.current.set(p.id, el);
              else tiles.current.delete(p.id);
            }}
            role="tab"
            aria-selected={p.id === active}
            title={`Capture ${index + 1} · ${p.init.width} × ${p.init.height} · drag to reorder`}
            className={clsx(
              "group relative flex h-[52px] shrink-0 cursor-pointer items-center justify-center rounded-md bg-canvas p-0.5 select-none",
              p.id === active ? "ring-2 ring-accent" : "ring-1 ring-border hover:ring-foreground/40",
              drag?.id === p.id && drag.moved && "opacity-60",
            )}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              setDrag({ id: p.id, pointer: e.pointerId, from: index, to: index, x0: e.clientX, moved: false });
            }}
            onPointerMove={(e) => {
              if (!drag || drag.pointer !== e.pointerId) return;
              const moved = drag.moved || Math.abs(e.clientX - drag.x0) > 4;
              if (moved) setDrag({ ...drag, moved, to: slotAt(e.clientX, drag.id) });
            }}
            onPointerUp={(e) => {
              if (!drag || drag.pointer !== e.pointerId) return;
              setDrag(null);
              if (drag.moved) props.onMove(drag.from, drag.to);
              else props.onSelect(drag.id);
            }}
            onPointerCancel={() => setDrag(null)}
          >
            <img src={p.thumb} alt="" draggable={false} className="h-12 max-w-24 object-contain" />
            <span className="absolute bottom-0.5 left-0.5 rounded bg-black/70 px-1 text-[10px] leading-[14px] font-medium text-white tabular-nums">
              {index + 1}
            </span>
            {pages.length > 1 && (
              <button
                title="Remove this capture"
                aria-label={`Remove capture ${index + 1}`}
                // Not a press on the tile: that would start a drag.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => props.onRemove(p.id)}
                className="absolute -top-1.5 -right-1.5 hidden h-[18px] w-[18px] items-center justify-center rounded-full bg-foreground text-background shadow group-hover:flex"
              >
                <X size={11} strokeWidth={3} />
              </button>
            )}
          </div>
        );
      })}
      <button
        title={`Add a capture (${props.mod}⇧N)`}
        aria-label="Add a capture"
        disabled={!props.canAdd}
        onClick={props.onAdd}
        className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:border-foreground/40 hover:text-foreground disabled:opacity-40"
      >
        <Plus size={18} />
      </button>
    </div>
  );
}
