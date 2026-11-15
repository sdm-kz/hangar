/**
 * F: an open file in and out of its full-page view. One listener for every viewer on screen (a
 * session's file tabs, the explorer's preview, a file opened from the files sidebar), so a single
 * key press reaches one of them, never two.
 *
 * Which one: the viewer holding the focus; else the one inside the same panel as the focus (a file
 * tab's tree, say, beside its preview); else, with the focus on nothing in particular, the only
 * viewer showing. Several on screen and none of them nearer the focus: nobody, rather than a guess.
 * A viewer in full page always takes it, as the way back out.
 */
import { useEffect, useRef } from "react";

interface Viewer {
  root: () => HTMLElement | null;
  open: () => boolean;
  toggle: () => void;
}

const viewers = new Set<Viewer>();

/** Marks a panel whose viewer F means when the focus is elsewhere in the panel (its file tree). */
export const FILE_SCOPE = { "data-file-scope": "" } as const;

/** Where F is a letter being typed, or belongs to something else. */
function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']");
}

const showing = (v: Viewer) => {
  const el = v.root();
  return !!el && el.getClientRects().length > 0;
};

function pick(target: Element | null): Viewer | undefined {
  const shown = [...viewers].filter(showing);
  const open = shown.find((v) => v.open());
  if (open) return open;
  const holding = shown.find((v) => target && v.root()?.contains(target));
  if (holding) return holding;
  const scope = target?.closest("[data-file-scope]");
  const inScope = scope ? shown.filter((v) => scope.contains(v.root())) : [];
  if (inScope.length === 1) return inScope[0];
  // The focus is on nothing in particular (the page itself), or in a panel with no viewer of its
  // own (the files sidebar, beside the file it opened).
  const loose = !target || target === document.body || target === document.documentElement || (!!scope && inScope.length === 0);
  return loose && shown.length === 1 ? shown[0] : undefined;
}

function onKey(e: KeyboardEvent) {
  if (e.code !== "KeyF" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.repeat || e.defaultPrevented) return;
  if (typing(e.target) || document.querySelector('[role="dialog"], [role="menu"]')) return;
  const v = pick(e.target instanceof Element ? e.target : null);
  if (!v) return;
  e.preventDefault();
  v.toggle();
}

/**
 * Lets F toggle this viewer's full-page view. `open` is whether it is in full page now (an image's
 * full-size viewer counts); `toggle` goes in or comes out. Off while `enabled` is false — no file,
 * or a file being edited, whose way out is Save or Cancel.
 */
export function useFullPageKey(
  rootRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
  open: boolean,
  toggle: () => void
) {
  const latest = useRef({ open, toggle });
  latest.current = { open, toggle };
  useEffect(() => {
    if (!enabled) return;
    const v: Viewer = { root: () => rootRef.current, open: () => latest.current.open, toggle: () => latest.current.toggle() };
    if (viewers.size === 0) window.addEventListener("keydown", onKey);
    viewers.add(v);
    return () => {
      viewers.delete(v);
      if (viewers.size === 0) window.removeEventListener("keydown", onKey);
    };
  }, [enabled, rootRef]);
}
