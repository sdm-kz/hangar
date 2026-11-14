import { useEffect, useRef, useState } from "react";
import type { Project } from "@/types";
import { COLOR_CHOICES, sessionColor } from "@/lib/sessionColors";
import { DEFAULT_GROUP_ICON_NAME, GROUP_ICONS, groupIcon, searchIcons } from "@/lib/groupIcons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { Ban, Loader2, Plus, Search } from "lucide-react";
import { useApi } from "@/lib/node";

/**
 * The icon grid, for a project or a virtual folder. "No icon" is a real choice — it draws the
 * default, and follows the default if that ever changes — so it is never a tile of its own: the
 * default's tile stands for it, lit while nothing is picked, and clicking it (or clicking the picked
 * tile again) goes back to no icon. `onIcon` is handed the resolved result, null for "the default".
 * The search box above narrows the grid by name and synonyms (see `searchIcons`).
 */
export function IconPicker({
  icon,
  defaultName,
  tint,
  onIcon,
  className,
}: {
  icon: string | null;
  /** The stored name of the glyph that "no icon" draws. */
  defaultName: string;
  /** The colour the icons are drawn in — the owner's accent, so the two are chosen against each other. */
  tint?: string | null;
  onIcon: (icon: string | null) => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // Esc in a search with text in it clears the text and leaves the dialog open. The dialog listens
  // for Esc on the document in the capture phase, before the box's own onKeyDown could see it, so
  // this listens on the window, which the capture phase passes through first.
  useEffect(() => {
    if (!query) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.activeElement !== searchRef.current) return;
      e.stopPropagation();
      e.preventDefault();
      setQuery("");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [query]);
  // An unknown stored name draws the default too, so it lights the default's tile.
  const shown = icon && GROUP_ICONS.some((i) => i.name === icon) ? icon : defaultName;
  const found = searchIcons(query);
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search icons: money, test, deploy…"
          aria-label="Search icons"
          className="h-7 pl-7 text-xs"
        />
      </div>
      {/* The grid scrolls on its own, so the search box above it stays in reach. */}
      <div className="flex max-h-56 flex-wrap content-start gap-1 overflow-y-auto overscroll-contain">
        {found.length === 0 && (
          <p className="w-full py-3 text-center text-xs text-muted-foreground">No icon matches “{query.trim()}”.</p>
        )}
        {found.map(({ name, Icon }) => (
          <button
            key={name}
            type="button"
            title={name === defaultName ? `${name} (default)` : name}
            aria-label={name}
            aria-pressed={shown === name}
            onClick={() => onIcon(name === defaultName || name === icon ? null : name)}
            className={cn(
              "flex size-7 shrink-0 items-center justify-center rounded border transition-colors hover:bg-accent",
              shown === name ? "border-foreground" : "border-transparent"
            )}
            style={tint ? { color: tint } : undefined}
          >
            <Icon className="size-4" />
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * The colour and icon swatches for a virtual folder. Shared by the two places that pick them — this
 * dialog, which holds the choice until the group exists, and the project settings popup, which
 * writes each click straight through to an existing group. Only the handlers differ, so only the
 * handlers are the caller's business.
 */
export function GroupAppearance({
  color,
  icon,
  onColor,
  onIcon,
  className,
}: {
  color: string | null;
  icon: string | null;
  onColor: (color: string | null) => void;
  /** The picked icon, or null for the default (see IconPicker). */
  onIcon: (icon: string | null) => void;
  className?: string;
}) {
  const tint = sessionColor(color);
  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div className="flex flex-wrap items-center gap-1.5">
        {COLOR_CHOICES.map((c) => (
          <button
            key={c.name}
            type="button"
            title={c.name}
            aria-label={c.name}
            aria-pressed={color === c.name}
            onClick={() => onColor(c.name)}
            className={cn(
              "size-5 rounded-full border-2 transition-transform hover:scale-110",
              color === c.name ? "border-foreground" : "border-transparent"
            )}
            style={{ backgroundColor: c.css }}
          />
        ))}
        <button
          type="button"
          title="No colour"
          aria-label="No colour"
          aria-pressed={color === null}
          onClick={() => onColor(null)}
          className={cn(
            "flex size-5 items-center justify-center rounded-full border-2 text-muted-foreground transition-transform hover:scale-110",
            color === null ? "border-foreground" : "border-border"
          )}
        >
          <Ban className="size-3" />
        </button>
      </div>
      {/* The icons wear the group's colour, so the two choices are made against each other rather
          than one after the other. */}
      <IconPicker icon={icon} defaultName={DEFAULT_GROUP_ICON_NAME} tint={tint} onIcon={onIcon} />
    </div>
  );
}

/**
 * Make a virtual folder from a session's own menu, the way "New project…" makes a project from a
 * folder's — named, dressed, and with the thing you started from already in it. Filing the session
 * is the whole reason this exists rather than sending you to the project's settings: you reach for
 * a new group *because* of the session in front of you, and having to go and find it again
 * afterwards is the step that makes people not bother.
 */
export function GroupDialog({
  project,
  onSaved,
  onCreated,
  onClose,
}: {
  /** The project the group is made in — the one the session's folder belongs to. */
  project: Project;
  /** The full project list, as returned by every mutation. */
  onSaved: (projects: Project[]) => void;
  /** The new group's id, once it exists — the caller files its session into it. */
  onCreated: (groupId: string) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [name, setName] = useState("");
  const [color, setColor] = useState<string | null>(null);
  const [icon, setIcon] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const Preview = groupIcon(icon);
  const accent = sessionColor(color);

  const create = async () => {
    const clean = name.trim();
    if (!clean) return;
    setBusy(true);
    setError(null);
    try {
      const before = new Set(project.groups.map((g) => g.id));
      const updated = await api.createProjectGroup(project.id, clean, color, icon);
      onSaved(updated);
      // Found by elimination rather than by position: the server appends, but another browser may
      // have appended one too, and filing the session into somebody else's group would be worse
      // than not filing it at all.
      const made = updated
        .find((p) => p.id === project.id)
        ?.groups.find((g) => !before.has(g.id));
      if (made) onCreated(made.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)_auto] max-h-[calc(100dvh-2rem)] max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Preview className="size-4 shrink-0" style={accent ? { color: accent } : undefined} />
            New group
          </DialogTitle>
          <DialogDescription>
            A virtual folder inside <span className="text-foreground">{project.name}</span>. The
            session you opened this from goes straight into it; drag any others onto it in the
            sidebar.
          </DialogDescription>
        </DialogHeader>

        {/* -mx-1 px-1 is not spacing: a scroller clips on both axes, and a control whose edge
              is flush with this box loses whatever it paints *outside* itself there -- which is
              its focus ring, cut clean off down the left while the rest of it draws. The padding
              buys the ring a gutter and the negative margin gives it back, so nothing moves. */}
        <div className="-mx-1 flex min-h-0 flex-col gap-4 overflow-y-auto overscroll-contain px-1">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="group-name">Name</Label>
            <Input
              id="group-name"
              value={name}
              autoFocus
              placeholder="Release 2.4"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                void create();
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Colour and icon</Label>
            <GroupAppearance
              color={color}
              icon={icon}
              onColor={setColor}
              onIcon={setIcon}
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" disabled={!name.trim() || busy} onClick={() => void create()}>
            {busy ? (
              <Loader2 className="mr-1.5 size-3.5 animate-spin" />
            ) : (
              <Plus className="mr-1.5 size-3.5" />
            )}
            Create group
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
