// The set of files a session has open. It used to belong to the Files panel, but the tabs now sit in
// the session's own tab bar next to Terminal/Split/Files — a file is a view of the session, not a
// detail of one panel — so the state lives above both and is handed to the panel as an api.
//
// Everything that touches an open file goes through here: the tab model (one transient "preview"
// slot that single-click reuses, plus pinned tabs), the unsaved-edit guard, and persistence through
// lib/sessionUi, which carries it to the user's other browsers.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FileEntry } from "@/types";
import { patchUrlState, readUrlState } from "./urlState";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "./sessionUi";

// A tab restored from a saved path knows nothing but the path, so the size reads as unknown rather
// than zero — the preview header hides it instead of claiming "0 B".
export const UNKNOWN_SIZE = -1;

/** Build a minimal FileEntry from a path. Size is filled in once the tree/preview loads. */
export function fileEntryFromPath(path: string): FileEntry {
  return { name: path.split("/").pop() || path, path, isDir: false, size: UNKNOWN_SIZE };
}

/**
 * Reconstruct a session's open tabs: a URL deep-link for this session wins as the active tab,
 * otherwise the saved state. `files` holds every open tab; the active one is always present (older
 * saved state only had a single `file`). `preview` marks the transient tab that single-click reuses
 * (kept only if it's actually one of the open tabs).
 */
export function restoreTabs(
  sessionId: string,
  useUrl: boolean
): { tabs: FileEntry[]; active: string | null; preview: string | null } {
  const u = useUrl ? readUrlState() : {};
  const ui = loadSessionUi(sessionId);
  const active = (useUrl && u.session === sessionId && u.file ? u.file : ui.file) || null;
  const paths = ui.files && ui.files.length ? [...ui.files] : active ? [active] : [];
  if (active && !paths.includes(active)) paths.unshift(active);
  const preview = ui.preview && paths.includes(ui.preview) ? ui.preview : null;
  return { tabs: paths.map(fileEntryFromPath), active, preview };
}

/** How the active preview reports unsaved edits back up, so closing a tab can guard them. */
export interface PreviewGuard {
  dirty: boolean;
  save: () => Promise<boolean>;
}

/** The prompt shown while a tab with unsaved edits is being closed (rendered by the session view). */
export interface CloseGuardPrompt {
  name: string;
}

/** Everything the Files panel needs in order to work with the session's open files. */
export interface FileTabs {
  tabs: FileEntry[];
  activePath: string | null;
  previewPath: string | null;
  /** The active tab's entry, i.e. the file the preview pane renders. */
  selected: FileEntry | null;
  /**
   * Open a file and activate it. `pin` decides the tab model:
   *  - false (single click): reuse the one transient preview slot — replace the current preview tab
   *    in place, or create it if there's none. Keeps the tab list from piling up.
   *  - true (middle/double click): open (or promote to) a permanent tab.
   */
  open: (f: FileEntry, pin: boolean) => Promise<void>;
  /** Switch to an already-open tab, leaving its preview/pinned status alone. */
  activate: (path: string) => Promise<void>;
  /** Pin the transient preview tab so single-clicking another file won't replace it. */
  pin: (path: string) => void;
  close: (path: string) => Promise<void>;
  closeAll: () => Promise<void>;
  /**
   * Replace the whole tab list at once — for the cases where the files themselves moved out from
   * under it: a rename, a delete, or a switch to an unrelated root.
   */
  replace: (tabs: FileEntry[], active: string | null, preview: string | null) => void;
  /**
   * Ask about unsaved edits in the active tab before navigating away from it. Returns false to
   * abort. Only the active tab can be edited, so it is the only one that can be dirty.
   */
  guardActiveEdits: () => Promise<boolean>;
  /** Where the active preview registers its dirty state (passed straight to FilePreview). */
  previewGuard: React.MutableRefObject<PreviewGuard>;
}

/**
 * Own a session's open file tabs. Returns the api the Files panel and the session tab bar share,
 * plus the state behind the "save changes?" prompt, which the session view renders.
 */
export function useFileTabs(sessionId: string): {
  fileTabs: FileTabs;
  closeGuard: CloseGuardPrompt | null;
  settleCloseGuard: (choice: "save" | "discard" | "cancel") => void;
} {
  const [tabs, setTabs] = useState<FileEntry[]>(() => restoreTabs(sessionId, true).tabs);
  const [activePath, setActivePath] = useState<string | null>(() => restoreTabs(sessionId, true).active);
  const [previewPath, setPreviewPath] = useState<string | null>(() => restoreTabs(sessionId, true).preview);
  const selected = useMemo(() => tabs.find((t) => t.path === activePath) ?? null, [tabs, activePath]);

  const previewGuard = useRef<PreviewGuard>({ dirty: false, save: async () => true });
  const [closeGuard, setCloseGuard] = useState<CloseGuardPrompt | null>(null);
  const closeGuardResolve = useRef<((choice: "save" | "discard" | "cancel") => void) | null>(null);

  // Persist the open tabs + active + preview for this session, and mirror the active into the URL.
  const persist = useCallback(
    (nextTabs: FileEntry[], nextActive: string | null, nextPreview: string | null) => {
      const paths = nextTabs.map((t) => t.path);
      // Remembered scroll offsets belong to the open tabs (see SessionUi.fileScroll). Closing a tab
      // is what drops its offset — so reopening the file starts at the top, and the map can't
      // accumulate an entry for every file the session has ever previewed. Only written when
      // something actually went away: an unchanged field is a no-op at the server, but sending it
      // on every tab switch would make the bag's revision churn for nothing.
      const scroll = loadSessionUi(sessionId).fileScroll;
      const stale = scroll && Object.keys(scroll).some((p) => !paths.includes(p));
      saveSessionUi(sessionId, {
        file: nextActive ?? "",
        files: paths,
        preview: nextPreview ?? "",
        ...(stale
          ? { fileScroll: Object.fromEntries(Object.entries(scroll!).filter(([p]) => paths.includes(p))) }
          : {}),
      });
      patchUrlState({ file: nextActive ?? undefined });
    },
    [sessionId]
  );

  const apply = useCallback(
    (nextTabs: FileEntry[], nextActive: string | null, nextPreview: string | null) => {
      setTabs(nextTabs);
      setActivePath(nextActive);
      setPreviewPath(nextPreview);
      persist(nextTabs, nextActive, nextPreview);
    },
    [persist]
  );

  const guardActiveEdits = useCallback(async (): Promise<boolean> => {
    if (!previewGuard.current.dirty) return true;
    setCloseGuard({ name: selected?.name ?? "This file" });
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
      closeGuardResolve.current = resolve;
    });
    if (choice === "cancel") return false;
    if (choice === "save") return previewGuard.current.save();
    return true; // discard
  }, [selected]);

  const settleCloseGuard = useCallback((choice: "save" | "discard" | "cancel") => {
    closeGuardResolve.current?.(choice);
    closeGuardResolve.current = null;
    setCloseGuard(null);
  }, []);

  const open = useCallback(
    async (f: FileEntry, pin: boolean) => {
      // Switching away from an unsaved edit prompts to save first.
      if (f.path !== activePath && !(await guardActiveEdits())) return;
      const isOpen = tabs.some((t) => t.path === f.path);
      let next: FileEntry[];
      let nextPreview = previewPath;
      if (isOpen) {
        next = tabs.map((t) => (t.path === f.path ? f : t)); // refresh entry (size may now be known)
        if (pin && previewPath === f.path) nextPreview = null; // promote the preview tab to pinned
      } else if (pin || !previewPath) {
        next = [...tabs, f]; // new tab (pinned, or the first preview tab)
        if (!pin) nextPreview = f.path;
      } else {
        next = tabs.map((t) => (t.path === previewPath ? f : t)); // reuse the preview slot in place
        nextPreview = f.path;
      }
      apply(next, f.path, nextPreview);
    },
    [tabs, activePath, previewPath, apply, guardActiveEdits]
  );

  const activate = useCallback(
    async (path: string) => {
      if (path === activePath) return;
      if (!(await guardActiveEdits())) return;
      apply(tabs, path, previewPath);
    },
    [tabs, activePath, previewPath, apply, guardActiveEdits]
  );

  const pin = useCallback(
    (path: string) => {
      if (previewPath !== path) return;
      setPreviewPath(null);
      persist(tabs, path, null);
    },
    [tabs, previewPath, persist]
  );

  // Close a tab; if it was the active one, fall back to its neighbour (or empty).
  const close = useCallback(
    async (path: string) => {
      const idx = tabs.findIndex((t) => t.path === path);
      if (idx === -1) return;
      // Only the active tab can hold unsaved edits — guard just that case.
      if (path === activePath && !(await guardActiveEdits())) return;
      const next = tabs.filter((t) => t.path !== path);
      const nextActive =
        activePath === path ? (next.length ? next[Math.min(idx, next.length - 1)].path : null) : activePath;
      apply(next, nextActive, previewPath === path ? null : previewPath);
    },
    [tabs, activePath, previewPath, apply, guardActiveEdits]
  );

  const closeAll = useCallback(async () => {
    if (!(await guardActiveEdits())) return;
    apply([], null, null);
  }, [apply, guardActiveEdits]);

  // When the session actually changes, restore that session's tabs. Skips the initial mount (and
  // StrictMode's double-invoked mount effect), so the URL-restored selection survives.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    const restored = restoreTabs(sessionId, false);
    setTabs(restored.tabs);
    setActivePath(restored.active);
    setPreviewPath(restored.preview);
    patchUrlState({ file: restored.active ?? undefined });
  }, [sessionId]);

  // Adopt the tabs another browser opened or closed: sessionUi tells us when the server's copy has
  // replaced ours. Unsaved edits pin the active tab in place — a remote change is not worth losing
  // them over — so the list is taken but the selection is not moved off a dirty file.
  useEffect(
    () =>
      subscribeSessionUi(sessionId, () => {
        const restored = restoreTabs(sessionId, false);
        setTabs((cur) => {
          const same =
            cur.length === restored.tabs.length && cur.every((c, i) => c.path === restored.tabs[i].path);
          // Keep the entries already held rather than the bare path-only ones a restore builds: the
          // preview reloads the file whenever its entry changes identity, and the size it knows is
          // part of what it renders.
          return same ? cur : restored.tabs.map((t) => cur.find((c) => c.path === t.path) ?? t);
        });
        setPreviewPath(restored.preview);
        setActivePath((cur) =>
          previewGuard.current.dirty && cur && restored.tabs.some((t) => t.path === cur)
            ? cur
            : restored.active
        );
      }),
    [sessionId]
  );

  const fileTabs = useMemo<FileTabs>(
    () => ({
      tabs,
      activePath,
      previewPath,
      selected,
      open,
      activate,
      pin,
      close,
      closeAll,
      replace: apply,
      guardActiveEdits,
      previewGuard,
    }),
    [tabs, activePath, previewPath, selected, open, activate, pin, close, closeAll, apply, guardActiveEdits]
  );

  return { fileTabs, closeGuard, settleCloseGuard };
}
