// Lightweight deep-linking: mirror the selected session, active tab, and previewed
// file into the URL query string so a refresh or shared link restores the same view.
// We use replaceState (no history spam) on the root path so a hard refresh works
// without any server-side routing.

export type TabName = "terminal" | "files";

export interface UrlState {
  session?: string;
  tab?: TabName;
  file?: string;
}

export function readUrlState(): UrlState {
  const p = new URLSearchParams(window.location.search);
  const tab = p.get("tab");
  return {
    session: p.get("session") || undefined,
    tab: tab === "files" || tab === "terminal" ? tab : undefined,
    file: p.get("file") || undefined,
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
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}
