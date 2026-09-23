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

/**
 * The guard key of the Files explorer's own preview. It previews whichever file is active, so its
 * edits belong to that file only until the active file changes — which is why it is kept apart from
 * the per-path guards of the file tabs, and asked about whenever the active file moves.
 */
export const EXPLORER_GUARD = "<explorer>";

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
   * Ask about unsaved edits in every open file before something replaces them all (a switch to an
   * unrelated root). Returns false to abort.
   */
  guardActiveEdits: () => Promise<boolean>;
  /**
   * Ask about unsaved edits in one file before its preview goes away — its tab closing, or another
   * tab taking its place in the group it is shown in. Returns false to abort.
   */
  guardEdits: (key: string, name?: string) => Promise<boolean>;
  /**
   * Where a file's preview registers its dirty state (passed straight to FilePreview). One per path:
   * with the pane split, two files can be on screen — and being edited — at once.
   */
  guardFor: (path: string) => React.MutableRefObject<PreviewGuard>;
  /**
   * The guard keys holding unsaved edits right now — paths, and EXPLORER_GUARD. Reactive, so a file
   * tab's preview can stay mounted while it has edits even when it is not on screen.
   */
  dirty: ReadonlySet<string>;
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

  // Guards by path, created on first ask and kept for the life of the hook: a preview holds on to the
  // object it was handed, so a path must always get the same one back.
  // Each guard reports a change of its dirty flag into `dirty`, so what reads it re-renders.
  const guards = useRef(new Map<string, React.MutableRefObject<PreviewGuard>>());
  const [dirty, setDirty] = useState<ReadonlySet<string>>(() => new Set());
  const guardFor = useCallback((key: string) => {
    let g = guards.current.get(key);
    if (!g) {
      let cur: PreviewGuard = { dirty: false, save: async () => true };
      g = {
        get current() {
          return cur;
        },
        set current(next: PreviewGuard) {
          const changed = next.dirty !== cur.dirty;
          cur = next;
          if (changed)
            setDirty((s) => {
              const n = new Set(s);
              if (next.dirty) n.add(key);
              else n.delete(key);
              return n;
            });
        },
      };
      guards.current.set(key, g);
    }
    return g;
  }, []);
  const isDirty = useCallback((key: string | null) => !!key && !!guards.current.get(key)?.current.dirty, []);
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

  const guardEdits = useCallback(
    async (key: string, name?: string): Promise<boolean> => {
      const guard = guards.current.get(key);
      if (!guard?.current.dirty) return true;
      setCloseGuard({ name: name ?? (key.split("/").pop() || key) });
      const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
        // One prompt at a time: a question still open when another arrives is answered "cancel",
        // rather than left hanging with whatever was waiting on it.
        closeGuardResolve.current?.("cancel");
        closeGuardResolve.current = resolve;
      });
      if (choice === "cancel") return false;
      if (choice === "save") return guard.current.save();
      // Discarded: the edits are as good as gone, so a second question about the same file on the
      // way out (the layout asks, then the tab api does) would only ask the same thing twice.
      guard.current = { ...guard.current, dirty: false };
      return true;
    },
    []
  );

  // The explorer's preview shows the active file; its edits are that file's.
  const guardExplorer = useCallback(
    () => guardEdits(EXPLORER_GUARD, activePath ? activePath.split("/").pop() : undefined),
    [guardEdits, activePath]
  );

  const guardActiveEdits = useCallback(async (): Promise<boolean> => {
    for (const path of [...guards.current.keys()]) if (!(await guardEdits(path))) return false;
    return true;
  }, [guardEdits]);

  const settleCloseGuard = useCallback((choice: "save" | "discard" | "cancel") => {
    closeGuardResolve.current?.(choice);
    closeGuardResolve.current = null;
    setCloseGuard(null);
  }, []);

  const open = useCallback(
    async (f: FileEntry, pin: boolean) => {
      // Reusing the preview slot replaces the file in it, so unsaved edits there are asked about
      // first. Nothing else is hidden by opening a file here — which tab the pane shows is the
      // layout's business, and it guards what it hides.
      if (!pin && previewPath && previewPath !== f.path && !tabs.some((t) => t.path === f.path) && !(await guardEdits(previewPath)))
        return;
      // The explorer's preview follows the active file, so moving it off one with edits asks first.
      if (f.path !== activePath && !(await guardExplorer())) return;
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
    [tabs, previewPath, apply, guardExplorer]
  );

  const activate = useCallback(
    async (path: string) => {
      if (path === activePath) return;
      if (!(await guardExplorer())) return;
      apply(tabs, path, previewPath);
    },
    [tabs, activePath, previewPath, apply, guardExplorer]
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
      if (!(await guardEdits(path))) return;
      if (path === activePath && !(await guardExplorer())) return;
      const next = tabs.filter((t) => t.path !== path);
      const nextActive =
        activePath === path ? (next.length ? next[Math.min(idx, next.length - 1)].path : null) : activePath;
      apply(next, nextActive, previewPath === path ? null : previewPath);
    },
    [tabs, activePath, previewPath, apply, guardEdits, guardExplorer]
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
          (isDirty(cur) || isDirty(EXPLORER_GUARD)) && cur && restored.tabs.some((t) => t.path === cur)
            ? cur
            : restored.active
        );
      }),
    [sessionId, isDirty]
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
      guardEdits,
      guardFor,
      dirty,
    }),
    [tabs, activePath, previewPath, selected, open, activate, pin, close, closeAll, apply, guardActiveEdits, guardEdits, guardFor, dirty]
  );

  return { fileTabs, closeGuard, settleCloseGuard };
}
