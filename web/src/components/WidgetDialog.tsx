import { useMemo, useState } from "react";
import { Blocks, Link2, Loader2 } from "lucide-react";
import type { WidgetInstance, WidgetPlacement, WidgetTypeInfo, WidgetTypesAnswer } from "@/types";
import { widgetIcon } from "@/lib/widgetIcons";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const PLACEMENT_LABEL: Record<WidgetPlacement, { name: string; hint: string }> = {
  tab: { name: "Tab", hint: "a tab in this strip, the view filling the pane" },
  "tab-popover": { name: "Tab button", hint: "a compact button in this strip that opens a popup" },
  header: { name: "Header", hint: "a chip in the session's header that opens a popup" },
};

const FROM_LABEL = { session: "the session's name", branch: "its branch", folder: "its folder" } as const;

/**
 * Open a widget in this session (docs/design/widgets.md §9.5): pick one of the types the session can
 * open, fill whatever params it cannot read from the session itself, and say where it goes. A param
 * left empty that the type reads from the session stays linked to it — renaming the session moves the
 * widget along — so the field says where the value would come from rather than asking for it.
 */
export function WidgetDialog({
  answer,
  failed,
  full,
  onOpen,
  onClose,
}: {
  answer: WidgetTypesAnswer | null;
  failed: boolean;
  /** The session has as many widgets open as it may. */
  full: boolean;
  onOpen: (w: Omit<WidgetInstance, "id">) => void;
  onClose: () => void;
}) {
  const types = useMemo(() => (answer?.types ?? []).filter((t) => !t.shadowed), [answer]);
  const [picked, setPicked] = useState<string | null>(null);
  const type: WidgetTypeInfo | undefined = types.find((t) => t.name === picked) ?? (types.length === 1 ? types[0] : undefined);
  const [values, setValues] = useState<Record<string, string>>({});
  const [placement, setPlacement] = useState<WidgetPlacement | null>(null);
  const where = placement && type?.placements.includes(placement) ? placement : type?.placements[0] ?? "tab";

  const missing = type?.params.filter((p) => p.required && p.from.length === 0 && p.default == null && !values[p.name]?.trim()) ?? [];
  // A number that isn't one is said, not quietly sent as nothing.
  const notNumbers =
    type?.params.filter(
      (p) => (p.type === "integer" || p.type === "number") && values[p.name]?.trim() && !Number.isFinite(Number(values[p.name]))
    ) ?? [];
  const canOpen = !!type && type.runnable && missing.length === 0 && notNumbers.length === 0 && !full;

  function open() {
    if (!type || !canOpen) return;
    const params: Record<string, unknown> = {};
    for (const p of type.params) {
      const v = values[p.name]?.trim();
      if (v) params[p.name] = p.type === "integer" || p.type === "number" ? Number(v) : p.type === "boolean" ? v === "true" : v;
    }
    onOpen({ type: type.name, params, placement: where });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Blocks className="size-4" /> Open a widget
          </DialogTitle>
          <DialogDescription>
            A small live view — a ticket, a list, a number — that follows this session to every device.
          </DialogDescription>
        </DialogHeader>

        {failed ? (
          <p className="text-sm text-destructive">Could not read the widgets this session can open.</p>
        ) : !answer ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Looking for widgets…
          </p>
        ) : types.length === 0 ? (
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>There are no widgets yet.</p>
            <p>
              Ask Claude in this session for one —{" "}
              <span className="font-mono text-foreground">/hgr-widget a widget that lists my Jira tickets in progress</span>{" "}
              — and it shows up here.
            </p>
          </div>
        ) : (
          <form
            className="flex min-w-0 flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              open();
            }}
          >
            <div className="-mx-1 max-h-56 space-y-0.5 overflow-auto px-1">
              {types.map((t) => {
                const Icon = widgetIcon(t.icon);
                const on = t.name === type?.name;
                return (
                  <button
                    key={`${t.scope}/${t.name}`}
                    type="button"
                    onClick={() => setPicked(t.name)}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm",
                      on ? "bg-accent text-accent-foreground" : "hover:bg-accent/60"
                    )}
                  >
                    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate font-medium">{t.title.includes("{") ? t.name : t.title}</span>
                        <span className="shrink-0 rounded border px-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {t.scope}
                        </span>
                      </span>
                      {t.description && <span className="block truncate text-xs text-muted-foreground">{t.description}</span>}
                      {!t.runnable && <span className="block text-xs text-destructive">{t.problem}</span>}
                    </span>
                  </button>
                );
              })}
            </div>

            {type && type.params.length > 0 && (
              <div className="space-y-3">
                {type.params.map((p) => {
                  const linked = p.from.length > 0;
                  const placeholder = linked
                    ? `From ${p.from.map((f) => FROM_LABEL[f]).join(", then ")}`
                    : p.default != null
                      ? String(p.default)
                      : "";
                  return (
                    <div key={p.name} className="space-y-1.5">
                      <Label htmlFor={`wp-${p.name}`} className="flex items-center gap-1.5">
                        {p.label || p.name}
                        {linked && (
                          <span className="flex items-center gap-0.5 text-xs font-normal text-muted-foreground" title="Left empty, it stays linked to the session">
                            <Link2 className="size-3" /> linked if empty
                          </span>
                        )}
                      </Label>
                      {p.options?.length || p.type === "boolean" ? (
                        <select
                          id={`wp-${p.name}`}
                          value={values[p.name] ?? ""}
                          onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                          className="h-9 w-full rounded-md border bg-transparent px-2 text-sm"
                        >
                          <option value="">{placeholder || "—"}</option>
                          {(p.options?.length ? p.options : [true, false]).map((o) => (
                            <option key={String(o)} value={String(o)}>
                              {String(o)}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Input
                          id={`wp-${p.name}`}
                          value={values[p.name] ?? ""}
                          inputMode={p.type === "integer" || p.type === "number" ? "numeric" : undefined}
                          spellCheck={false}
                          placeholder={placeholder}
                          onChange={(e) => setValues((v) => ({ ...v, [p.name]: e.target.value }))}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {type && type.placements.length > 1 && (
              <div className="space-y-1.5">
                <Label>Show as</Label>
                <div className="flex flex-wrap gap-1.5">
                  {type.placements.map((pl) => (
                    <button
                      key={pl}
                      type="button"
                      title={PLACEMENT_LABEL[pl].hint}
                      onClick={() => setPlacement(pl)}
                      className={cn(
                        "rounded-md border px-2.5 py-1 text-sm",
                        pl === where ? "border-primary bg-accent" : "hover:bg-accent/60"
                      )}
                    >
                      {PLACEMENT_LABEL[pl].name}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">{PLACEMENT_LABEL[where].hint}.</p>
              </div>
            )}

            {notNumbers.length > 0 && (
              <p className="text-xs text-destructive">
                {notNumbers.map((p) => p.label || p.name).join(", ")} must be a number.
              </p>
            )}
            {full && <p className="text-xs text-destructive">This session has as many widgets open as it may; close one first.</p>}

            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canOpen}>
                Open
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
