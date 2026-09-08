import { useCallback, type KeyboardEvent, type RefObject } from "react";

// Arrow-key navigation for the file trees: the scroll container is the single tab stop and focus
// roves over its rows, which is how a tree is expected to behave (and the only way to walk a long
// list of files without reaching for the mouse). Rows are found in the DOM rather than tracked in
// state, so one hook serves every shape of tree — the lazy directory tree, the changes tree, and a
// flat search result list — without any of them having to flatten themselves for it.
const ROW_SELECTOR = "[data-nav-row]";

/**
 * Attributes marking an element as a navigable row. Put them on the element that should take focus
 * — the clickable row itself; `tabIndex: -1` keeps it out of the Tab order but focusable by script.
 */
export function navRowProps(opts: {
  path: string;
  isDir?: boolean;
  open?: boolean; // expanded directory
  current?: boolean; // where the arrows resume from when nothing in the tree has focus
  depth: number;
}) {
  return {
    tabIndex: -1,
    "data-nav-row": opts.path,
    "data-nav-dir": opts.isDir ? "1" : undefined,
    "data-nav-open": opts.open ? "1" : undefined,
    "data-nav-current": opts.current ? "1" : undefined,
    "data-nav-depth": String(opts.depth),
  };
}

function rowsIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(ROW_SELECTOR));
}

// Where the next move starts from: the focused row, else the row the tree marks as current (a
// selection made by clicking, or restored from the URL), else "before the first row".
function currentIndex(list: HTMLElement[]): number {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    const row = active.closest<HTMLElement>(ROW_SELECTOR);
    const i = row ? list.indexOf(row) : -1;
    if (i >= 0) return i;
  }
  return list.findIndex((r) => r.dataset.navCurrent === "1");
}

const isDirRow = (el: HTMLElement) => el.dataset.navDir === "1";
const depthOf = (el: HTMLElement) => Number(el.dataset.navDepth ?? 0);

export function useTreeKeyNav(opts: {
  containerRef: RefObject<HTMLElement | null>;
  // Arrowing onto a file selects it, the way clicking it would — that is what makes stepping through
  // a folder of images with the arrow keys useful. Directories are only focused, never opened.
  onFocusFile?: (path: string) => void;
  // Enter (or →) on a directory row.
  onToggleDir?: (path: string, open: boolean) => void;
  // Enter on a file row, when activating differs from focusing it.
  onActivateFile?: (path: string) => void;
}) {
  const { containerRef, onFocusFile, onToggleDir, onActivateFile } = opts;

  const goTo = useCallback(
    (list: HTMLElement[], index: number) => {
      const el = list[Math.max(0, Math.min(index, list.length - 1))];
      // Already there: at either end of the list a held-down arrow key would otherwise re-select
      // the same file on every repeat.
      if (!el || el === document.activeElement) return;
      // Scrolled explicitly afterwards: `preventScroll` avoids the jump-to-centre some browsers do
      // on focus, `nearest` then brings the row just inside the edge.
      el.focus({ preventScroll: true });
      el.scrollIntoView({ block: "nearest" });
      if (!isDirRow(el)) onFocusFile?.(el.dataset.navRow ?? "");
    },
    [onFocusFile]
  );

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      const container = containerRef.current;
      if (!container || e.altKey || e.ctrlKey || e.metaKey) return;
      // Never steal keys from a rename field (or any other input) living inside a row.
      const target = e.target as HTMLElement;
      if (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;

      const list = rowsIn(container);
      if (list.length === 0) return;
      const i = currentIndex(list);
      const cur = i >= 0 ? list[i] : null;

      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          goTo(list, i + 1);
          return;
        case "ArrowUp":
          e.preventDefault();
          goTo(list, i <= 0 ? 0 : i - 1);
          return;
        case "Home":
          e.preventDefault();
          goTo(list, 0);
          return;
        case "End":
          e.preventDefault();
          goTo(list, list.length - 1);
          return;
        case "ArrowRight":
          if (!cur || !isDirRow(cur)) return;
          e.preventDefault();
          // Closed: open it. Already open: step into it, which is just the next row down.
          if (cur.dataset.navOpen !== "1") onToggleDir?.(cur.dataset.navRow ?? "", false);
          else goTo(list, i + 1);
          return;
        case "ArrowLeft": {
          if (!cur) return;
          e.preventDefault();
          if (isDirRow(cur) && cur.dataset.navOpen === "1") {
            onToggleDir?.(cur.dataset.navRow ?? "", true);
            return;
          }
          // Otherwise jump out to the enclosing folder: the nearest row above at a smaller depth.
          const depth = depthOf(cur);
          for (let j = i - 1; j >= 0; j--)
            if (depthOf(list[j]) < depth) {
              goTo(list, j);
              return;
            }
          return;
        }
        case "Enter":
          if (!cur) return;
          e.preventDefault();
          if (isDirRow(cur)) onToggleDir?.(cur.dataset.navRow ?? "", cur.dataset.navOpen === "1");
          else (onActivateFile ?? onFocusFile)?.(cur.dataset.navRow ?? "");
          return;
      }
    },
    [containerRef, goTo, onToggleDir, onActivateFile, onFocusFile]
  );

  // Spread onto the scrolling container: it is the tree's single tab stop, and every row's keys
  // bubble up to it.
  return { tabIndex: 0, onKeyDown } as const;
}
