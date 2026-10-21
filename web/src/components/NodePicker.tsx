import { AlertTriangle, Monitor } from "lucide-react";
import { sessionColor } from "@/lib/sessionColors";
import { cn } from "@/lib/utils";

/** A machine something can be started on, as a picker offers it. */
export interface LaunchNode {
  /** Null for this node. */
  id: string | null;
  name: string;
  color: string | null;
  /** Why it can't be picked right now — it is away, or has no claude — or null when it can. */
  unavailable: string | null;
  /** Something wrong there worth seeing from here — an overdue schedule. */
  warning?: string | null;
}

/**
 * Which machine a session (or a schedule) is for (plans/multi-node.md §7): one button per machine, this one
 * first. Drawn only when there is more than one to choose from, so a single-machine install never sees it.
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
  if (nodes.length < 2) return null;
  return (
    // Toggle buttons rather than radios: each is its own Tab stop, and one that can't be picked stays
    // focusable so its reason is read out, rather than vanishing from the keyboard and the screen reader.
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={label}>
      <span className="mr-1 text-xs text-muted-foreground">{label}</span>
      {nodes.map((n) => {
        const picked = n.id === value;
        const tint = sessionColor(n.color);
        const blocked = disabled || (!!n.unavailable && !picked);
        const says = [n.name, n.unavailable, n.warning].filter(Boolean).join(" — ");
        return (
          <button
            key={n.id ?? ""}
            type="button"
            aria-pressed={picked}
            aria-disabled={blocked || undefined}
            aria-label={says}
            title={says}
            onClick={() => !blocked && onChange(n.id)}
            className={cn(
              "flex max-w-[12rem] items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
              picked ? "border-foreground bg-accent font-medium" : "hover:bg-accent",
              n.unavailable && "opacity-50",
              blocked && "cursor-not-allowed"
            )}
          >
            <Monitor className="size-3.5 shrink-0" style={tint ? { color: tint } : undefined} />
            <span className="truncate">{n.name}</span>
            {n.warning && <AlertTriangle className="size-3 shrink-0 text-amber-500" aria-label={n.warning} />}
          </button>
        );
      })}
    </div>
  );
}
