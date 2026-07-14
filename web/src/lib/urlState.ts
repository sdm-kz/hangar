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
 * layout params (e.g. `tab`) but drops `file`, which belongs to the previously-open session.
 */
export function sessionUrl(id: string): string {
  const p = new URLSearchParams(window.location.search);
  p.set("session", id);
  p.delete("file");
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
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}
