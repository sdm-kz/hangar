// Lightweight deep-linking: mirror the selected session, active tab, and previewed
// file into the URL query string so a refresh or shared link restores the same view.
// We use replaceState (no history spam) on the root path so a hard refresh works
// without any server-side routing.

export type TabName = "terminal" | "files" | "split";

// Which sidebar tab is showing: the session list (default) or the server Files tree.
export type PanelName = "sessions" | "files";

export interface UrlState {
  session?: string;
  tab?: TabName;
  file?: string;
  panel?: PanelName;
  /** Absolute server path opened from the Files tree into the main area (distinct from `file`,
   *  which is a session-relative path in that session's own file browser). */
  open?: string;
}

/**
 * URL for the standalone full-page preview of a server file (absolute path), meant to be opened
 * in a new browser tab. It's a separate mode, not part of UrlState: main.tsx sees `preview` and
 * mounts the minimal PreviewApp instead of the full App, and since the path lives in the query
 * string a refresh of that tab restores the same preview.
 */
export function previewUrl(absPath: string): string {
  return `${window.location.pathname}?preview=${encodeURIComponent(absPath)}`;
}

/** The `preview` param if this tab was opened as a standalone file preview (see previewUrl). */
export function readPreviewPath(): string | null {
  return new URLSearchParams(window.location.search).get("preview");
}

/**
 * Deep-link URL for the Files sidebar tab, used to open it in a new browser tab. Only carries
 * `panel=files`; session/tab/file belong to the session view and aren't relevant to the Files tree.
 */
export function filesUrl(): string {
  return `${window.location.pathname}?panel=files`;
}

/**
 * Deep-link URL for a session, used to open it in a new browser tab. Keeps the current
 * layout params (e.g. `tab`) but drops `file`, which belongs to the previously-open session,
 * and `open`, since the session — not a server file — takes over the main area.
 */
export function sessionUrl(id: string): string {
  const p = new URLSearchParams(window.location.search);
  p.set("session", id);
  p.delete("file");
  p.delete("open");
  const qs = p.toString();
  return qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
}

export function readUrlState(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab");
  const panel = p.get("panel");
  return {
    session: p.get("session") || undefined,
    tab: tab === "files" || tab === "terminal" || tab === "split" ? tab : undefined,
    file: p.get("file") || undefined,
    panel: panel === "files" || panel === "sessions" ? panel : undefined,
    open: p.get("open") || undefined,
  };
}

/**
 * Merge a partial state into the URL. A key present in `patch` with a falsy value
 * clears that param; a key absent from `patch` is left untouched.
 */
export function patchUrlState(patch: UrlState): void {
  const p = new URLSearchParams(window.location.search);
  const apply = (key: keyof UrlState, val: string | undefined) => {
    if (val) p.set(key, val);
    else p.delete(key);
  };
  if ("session" in patch) apply("session", patch.session);
  if ("tab" in patch) apply("tab", patch.tab);
  if ("file" in patch) apply("file", patch.file);
  if ("panel" in patch) apply("panel", patch.panel);
  if ("open" in patch) apply("open", patch.open);
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}
