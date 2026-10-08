import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Ellipsis } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDismissable } from "@/lib/useDismissable";
import { Button } from "@/components/ui/button";

/** One toolbar action: drawn as an icon button while there is room, and as a menu entry after. */
export interface ToolAction {
  id: string;
  label: string; // the menu entry's text, and the button's tooltip unless `title` says more
  title?: string; // a longer tooltip for the button (a count, a shortcut) than the menu entry needs
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean; // a toggle that is on (select mode, the address field, a filter)
}

/**
 * The toolbar's "more" button: the actions there was no room for, as a menu of icon-and-label rows.
 * A toggle that is on says so with a highlighted row, as its button would with its colour.
 */
export function ToolbarMore({
  actions,
  buttonRef,
  buttonClassName = "size-7",
}: {
  actions: ToolAction[];
  buttonRef?: React.Ref<HTMLButtonElement>;
  buttonClassName?: string; // sized to match the toolbar's other buttons
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismissable(open, useCallback(() => setOpen(false), []));
  const menuRef = useRef<HTMLDivElement>(null);
  // The menu hangs from the button's right edge; on a narrow sidebar that can put its left side off
  // the window. Measured as it opens, before paint, and nudged right by however much it would be.
  const [shift, setShift] = useState(0);
  useLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const left = menuRef.current?.getBoundingClientRect().left ?? 0;
    if (left < 8) setShift(8 - left);
  }, [open]);

  // Focus goes into the menu as it opens, so the arrow keys work from the first press.
  useEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open]);

  // Up and down step through the enabled entries, wrapping; Home and End jump to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    if (e.key === "ArrowDown") next = (i + 1) % items.length;
    else if (e.key === "ArrowUp") next = (i - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else return;
    e.preventDefault();
    items[next].focus();
  };

  return (
    <div ref={ref} className="relative shrink-0">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        className={cn(buttonClassName, open && "text-foreground")}
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Ellipsis className="size-4" />
      </Button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More actions"
          onKeyDown={onKeyDown}
          style={shift ? { transform: `translateX(${shift}px)` } : undefined}
          className="absolute right-0 top-full z-50 mt-1 w-60 max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-md popover-edge bg-popover py-1 text-popover-foreground shadow-md"
        >
          {actions.map((a) => (
            <button
              key={a.id}
              type="button"
              // A toggle (select mode, the address field) is a checkbox entry, and says whether it is on.
              role={a.pressed === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={a.pressed === undefined ? undefined : a.pressed}
              disabled={a.disabled}
              onClick={() => {
                setOpen(false);
                a.onClick();
              }}
              className={cn(
                "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
                a.pressed && "bg-accent/60"
              )}
            >
              <span className="shrink-0 text-muted-foreground">{a.icon}</span>
              <span className="min-w-0 truncate">{a.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
