import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Check, Ellipsis } from "lucide-react";
import { cn } from "@/lib/utils";
import { useDismissable } from "@/lib/useDismissable";
import { Button } from "@/components/ui/button";

/** One toolbar action: drawn as an icon button while there is room, and as a menu entry after. */
export interface ToolAction {
  id: string;
  label: string; // the menu entry's text, and the button's tooltip unless `title` says more
  title?: string; // a longer tooltip for the button (a count, a shortcut) than the menu entry needs
  // Optional for one option of a choice ("Preview" / "Source"), which shows a tick when on instead.
  icon?: ReactNode;
  onClick?: () => void;
  // A link instead of an action (download, open in a new tab). A function is read at click time, for
  // a URL that moves without re-rendering the toolbar -- the app's deep-link state rides along.
  href?: string | (() => string);
  download?: string;
  newTab?: boolean;
  disabled?: boolean;
  pressed?: boolean; // a toggle that is on (select mode, the address field, a filter, a chosen view)
}

/** What the arrow keys step through: every entry that can be used. */
const ENABLED_ENTRY = "button:not(:disabled), a:not([aria-disabled=true])";

/**
 * The toolbar's "more" button: the actions there was no room for, as a menu of icon-and-label rows.
 * A toggle that is on says so with a highlighted row, as its button would with its colour.
 */
export function ToolbarMore({
  actions,
  buttonRef,
  buttonClassName = "size-7",
  variant = "ghost",
}: {
  actions: ToolAction[];
  buttonRef?: React.Ref<HTMLButtonElement>;
  buttonClassName?: string; // sized to match the toolbar's other buttons
  variant?: "ghost" | "outline"; // ...and dressed like them
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
    if (open) menuRef.current?.querySelector<HTMLElement>(ENABLED_ENTRY)?.focus();
  }, [open]);

  // Up and down step through the enabled entries, wrapping; Home and End jump to the ends.
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED_ENTRY) ?? []);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
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
        variant={variant}
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
          {actions.map((a) => {
            // A toggle or a chosen option is a checkbox entry, and says whether it is on.
            const role = a.pressed === undefined ? "menuitem" : "menuitemcheckbox";
            const className = cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-50",
              a.pressed && "bg-accent/60",
              a.disabled && "pointer-events-none opacity-50"
            );
            const body = (
              <>
                <span className="flex w-4 shrink-0 justify-center text-muted-foreground">
                  {a.icon ?? (a.pressed ? <Check className="size-4" /> : null)}
                </span>
                <span className="min-w-0 truncate">{a.label}</span>
              </>
            );
            if (a.href !== undefined)
              return (
                <a
                  key={a.id}
                  role={role}
                  aria-checked={a.pressed}
                  aria-disabled={a.disabled || undefined}
                  href={typeof a.href === "function" ? a.href() : a.href}
                  download={a.download}
                  target={a.newTab ? "_blank" : undefined}
                  rel={a.newTab ? "noreferrer" : undefined}
                  onClick={(e) => {
                    if (typeof a.href === "function") e.currentTarget.href = a.href();
                    a.onClick?.();
                    // Closed on the next tick, not now: closing removes this link from the page, and
                    // a link no longer in the page may not be followed (Firefox drops the download).
                    setTimeout(() => setOpen(false), 0);
                  }}
                  className={className}
                >
                  {body}
                </a>
              );
            return (
              <button
                key={a.id}
                type="button"
                role={role}
                aria-checked={a.pressed}
                disabled={a.disabled}
                onClick={() => {
                  setOpen(false);
                  a.onClick?.();
                }}
                className={className}
              >
                {body}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
