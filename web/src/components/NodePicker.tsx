import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import { sessionColor } from "@/lib/sessionColors";
import { cn } from "@/lib/utils";
import { OsIcon } from "./OsIcon";

/** A machine something can be started on, as a picker offers it. */
export interface LaunchNode {
  /** Null for this node. */
  id: string | null;
  name: string;
  color: string | null;
  /** The OS it runs, for its icon: "windows", "macos", "linux"; null when it isn't known. */
  os?: string | null;
  /** Why it can't be picked right now — it is away, or has no claude — or null when it can. */
  unavailable: string | null;
  /** Something wrong there worth seeing from here — an overdue schedule. */
  warning?: string | null;
}

/**
 * Which machine a session (or a schedule) is for (plans/multi-node.md §7): a dropdown of the machines, this
 * one first. Drawn only when there is more than one to choose from, so a single-machine install never sees it.
 *
 * A dropdown rather than a row of buttons: with four machines the row wrapped onto a second line and took
 * more of the dialog than the choice is worth. Not a native <select>, which can't draw a machine's OS mark
 * or its colour, nor say why one can't be picked beside its name.
 *
 * Keyboard: ↓/↑ (or Enter, Space) on the closed control opens it, ↓/↑ move the highlight, Enter picks,
 * Esc closes the list and only the list.
 */
export function NodePicker({
  nodes,
  value,
  onChange,
  label = "Machine",
  disabled = false,
}: {
  nodes: LaunchNode[];
  value: string | null;
  onChange: (id: string | null) => void;
  label?: string;
  /** While what was picked is in use (a launch on its way): nothing to switch to. */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  // The picked one stays pickable: it is what the control shows, whatever has become of it since.
  const blocked = (n: LaunchNode) => !!n.unavailable && n.id !== value;

  // Opening starts on the current machine, so Enter straight away keeps it.
  useEffect(() => {
    if (!open) return;
    const i = nodes.findIndex((n) => n.id === value);
    setActive(i < 0 ? 0 : i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Close on a click outside. Esc is caught on the window, ahead of the dialog's own listener on the
  // document, so it folds the list away rather than closing the dialog the list sits in.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc, true);
    };
  }, [open]);

  if (nodes.length < 2) return null;

  // Not found when the machine picked has since been forgotten: saying so beats showing this one, which
  // is not where a launch would go.
  const current = nodes.find((n) => n.id === value);
  const currentTint = sessionColor(current?.color ?? null);

  const pick = (n: LaunchNode) => {
    if (blocked(n)) return;
    setOpen(false);
    buttonRef.current?.focus();
    if (n.id !== value) onChange(n.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (disabled) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      // Over the ones that can't be picked: a highlight on one would only lead to an Enter that does nothing.
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => {
        for (let k = 1; k <= nodes.length; k++) {
          const j = (i + step * k + nodes.length * k) % nodes.length;
          if (!blocked(nodes[j])) return j;
        }
        return i;
      });
    } else if ((e.key === "Enter" || e.key === " ") && open) {
      // Enter would otherwise submit the form the picker sits in.
      e.preventDefault();
      const n = nodes[active];
      if (n) pick(n);
    } else if (e.key === "Tab" && open) {
      setOpen(false);
    }
  };

  const says = (n: LaunchNode) => [n.name, n.unavailable, n.warning].filter(Boolean).join(" — ");

  return (
    <div className="flex items-center gap-2">
      <span id={`${id}-label`} className="text-xs text-muted-foreground">
        {label}
      </span>
      <div ref={boxRef} className="relative min-w-0">
        <button
          ref={buttonRef}
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-controls={`${id}-list`}
          aria-expanded={open}
          aria-labelledby={`${id}-label`}
          aria-disabled={disabled || undefined}
          aria-activedescendant={open ? `${id}-${active}` : undefined}
          title={current ? says(current) : undefined}
          onClick={() => !disabled && setOpen((o) => !o)}
          onKeyDown={onKeyDown}
          className={cn(
            "flex h-8 w-56 max-w-full items-center gap-1.5 rounded-md field-edge bg-background px-2 text-left text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring",
            disabled ? "cursor-not-allowed opacity-60" : "hover:bg-accent"
          )}
        >
          {/* Dimmed, as in the list, when the machine picked has gone away since: Create would only say so. */}
          <span className={cn("flex min-w-0 flex-1 items-center gap-1.5", current?.unavailable && "opacity-50")}>
            <OsIcon
              os={current?.os}
              className="size-3.5 shrink-0"
              style={currentTint ? { color: currentTint } : undefined}
            />
            <span className={cn("min-w-0 flex-1 truncate", current ? "font-medium" : "text-muted-foreground")}>
              {current?.name ?? "Pick a machine"}
            </span>
          </span>
          {current?.warning && (
            <AlertTriangle className="size-3 shrink-0 text-amber-500" aria-label={current.warning} />
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>

        {open && (
          <div
            id={`${id}-list`}
            role="listbox"
            aria-labelledby={`${id}-label`}
            className="absolute left-0 top-full z-50 mt-1 w-max min-w-full max-w-[min(24rem,80vw)] overflow-y-auto overscroll-contain rounded-md popover-edge bg-popover p-1 shadow-md max-h-72"
          >
            {nodes.map((n, i) => {
              const tint = sessionColor(n.color);
              const no = blocked(n);
              return (
                <div
                  key={n.id ?? ""}
                  id={`${id}-${i}`}
                  role="option"
                  aria-selected={n.id === value}
                  aria-disabled={no || undefined}
                  title={says(n)}
                  onMouseEnter={() => setActive(i)}
                  // mousedown, not click: the outside-click listener runs on mousedown too, and focus
                  // stays on the control rather than moving to a row that is about to go.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(n);
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs",
                    i === active && !no && "bg-accent",
                    no ? "cursor-not-allowed opacity-50" : "cursor-pointer"
                  )}
                >
                  <OsIcon os={n.os} className="size-3.5 shrink-0" style={tint ? { color: tint } : undefined} />
                  <span className="min-w-0 flex-1">
                    <span className={cn("block truncate", n.id === value && "font-medium")}>{n.name}</span>
                    {(n.unavailable || n.warning) && (
                      <span className="block truncate text-[10px] text-muted-foreground">
                        {n.unavailable ?? n.warning}
                      </span>
                    )}
                  </span>
                  {n.warning && <AlertTriangle className="size-3 shrink-0 text-amber-500" aria-hidden="true" />}
                  <Check className={cn("size-3.5 shrink-0", n.id === value ? "opacity-100" : "opacity-0")} />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
