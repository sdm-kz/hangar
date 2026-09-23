import { useCallback, useState } from "react";
import { useDismissable } from "@/lib/useDismissable";
import type { LayoutPreset } from "@/lib/layout";
import { cn } from "@/lib/utils";
import { Columns2, LayoutGrid, LayoutPanelLeft, Rows2, Square } from "lucide-react";

const PRESETS: { id: LayoutPreset; label: string; icon: typeof Square }[] = [
  { id: "single", label: "Single group", icon: Square },
  { id: "columns", label: "Two columns", icon: Columns2 },
  { id: "rows", label: "Two rows", icon: Rows2 },
  { id: "main-side", label: "Main and two stacked", icon: LayoutPanelLeft },
  { id: "grid", label: "Grid of four", icon: LayoutGrid },
];

/**
 * The pane's layout presets, the way a terminal app offers its pane arrangements: pick a shape and
 * the groups already open are poured into it — nothing is closed, extra groups fold into the last.
 */
export function LayoutMenu({ groups, onPick }: { groups: number; onPick: (preset: LayoutPreset) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismissable<HTMLDivElement>(open, close);
  return (
    <div ref={ref} className="relative flex shrink-0 items-center">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Layout — split the pane into groups"
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          "flex size-[30px] items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground",
          open && "bg-accent text-foreground"
        )}
      >
        <LayoutGrid className="size-4" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full z-50 mt-2 w-72 rounded-md popover-edge bg-popover p-1 text-popover-foreground shadow-md"
        >
          {PRESETS.map((p) => (
            <button
              key={p.id}
              role="menuitem"
              onClick={() => {
                onPick(p.id);
                close();
              }}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
            >
              <p.icon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">{p.label}</span>
            </button>
          ))}
          <div className="mt-1 border-t px-2 pb-1 pt-2 text-[11px] leading-relaxed text-muted-foreground">
            {groups > 1 ? `${groups} groups open. ` : ""}Drag a tab onto a group's edge to split it, or
            use the tab's right-click menu. Alt+\ and Alt+- split, Alt+1–4 focus a group, Alt+Z
            maximizes, Alt+Shift+arrow moves a tab.
          </div>
        </div>
      )}
    </div>
  );
}
