import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { RemoteEntry, SessionRemote, TransferSide } from "@/types";
import { ApiError } from "@/lib/api";
import { fileKind } from "@/lib/fileKind";
import { cn } from "@/lib/utils";
import { useTreeKeyNav, navRowProps } from "@/lib/useTreeKeyNav";
import { useMarkedPaths, withoutDescendants, type MarkedPaths } from "@/lib/useMarkedPaths";
import {
  announceRemoteChange,
  clearFileClip,
  clipSourceFor,
  describeClip,
  getFileClip,
  hasTextSelection,
  REMOTE_CHANGED_EVENT,
  sameSide,
  setFileClip,
  useFileClip,
  type RemoteChange,
} from "@/lib/fileClipboard";
import { connectionTarget, loadRemoteWhere, remoteTabLabel, saveRemoteWhere } from "@/lib/sessionRemotes";
import { useConfirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { RenameField } from "./RenameField";
import { CopyPathButton } from "./CopyPathButton";
import { ToolbarMore, type ToolAction } from "./ToolbarMore";
import { ServerFileViewer, type FileSource } from "./ServerFileViewer";
import { RemoteReconnect } from "./RemoteConnect";
import {
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  Download,
  Eye,
  EyeOff,
  File as FileIcon,
  FilePlus,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Home,
  Image as ImageIcon,
  Link2,
  ListChecks,
  Loader2,
  Pencil,
  RefreshCw,
  Scissors,
  Server,
  Square,
  SquareCheck,
  Trash2,
  Unplug,
  Upload,
  Video,
} from "lucide-react";
import { useApi, useSessionKey } from "@/lib/node";

// Toolbar geometry, as in the sidebar's Files tree: 28px buttons with a 2px gap, and the folder name
// keeps at least this much of the row.
const TOOL_SLOT = 30;
const LABEL_MIN = 64;
// Below this width the tree and the preview take turns instead of sitting side by side.
const NARROW = 640;

const TREE_WIDTH_KEY = "hangar.remoteTreeWidth";
const HIDDEN_KEY = "hangar.remoteShowHidden";

function readNumber(key: string, fallback: number): number {
  try {
    const n = Number(localStorage.getItem(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage disabled — preference is best-effort */
  }
}

/** POSIX parent; "/" has none. */
function parentOf(p: string): string | null {
  if (p === "/" || !p) return null;
  const i = p.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function baseName(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "/";
}

function join(dir: string, name: string): string {
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

/** Whether a host speaks Windows paths, judged by one it gave us: "C:\Users" arrives as "/C:/Users". */
function isWindowsPath(p: string): boolean {
  return /^\/[A-Za-z]:(\/|$)/.test(p);
}

/**
 * A path as typed (a start folder, the path bar) made absolute: "~" is home, a relative path is
 * taken against `base`, and on a Windows host "c:\logs" becomes the server's "/C:/logs" instead of
 * a folder called "c:\logs" under home. The server folds it the same way (RemoteManager.Normalize).
 */
function resolvePath(input: string, home: string, base: string): string {
  let p = input.trim();
  if (isWindowsPath(home)) {
    p = p.replace(/\\/g, "/");
    if (/^[A-Za-z]:(\/|$)/.test(p)) p = `/${p[0].toUpperCase()}${p.slice(1)}`;
  }
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  if (!p.startsWith("/")) p = join(base, p);
  return p.replace(/(.)\/+$/, "$1");
}

/** Whether `p` is `dir` or under it. */
function isUnder(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === "/" ? "/" : `${dir}/`);
}

function FileGlyph({ name }: { name: string }) {
  const kind = fileKind(name);
  if (kind === "image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "video") return <Video className="size-4 shrink-0 text-muted-foreground" />;
  if (kind === "text") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

/**
 * A remote files tab: a host's files over SFTP, laid out like the session's own Files panel — a lazy
 * tree on the left, the file previewed (and editable) on the right through the same viewer the rest
 * of the app uses. Files and folders copy and cut through the app's file clipboard, so they paste into
 * another folder here, into another SSH tab, or into the session's own Files panel — and back.
 */
export function RemoteFilesView({ sessionId, remote }: { sessionId: string; remote: SessionRemote }) {
  const api = useApi();
  const uiKey = useSessionKey(sessionId);
  const tab = remote.id;
  const confirm = useConfirm();
  // `manual`: the person pressed Disconnect, so the reconnect prompt must not reconnect by itself.
  const [status, setStatus] = useState<{
    state: "checking" | "connected" | "disconnected";
    error?: string | null;
    manual?: boolean;
  }>({ state: "checking" });
  const [home, setHome] = useState("/");
  const where = useMemo(() => loadRemoteWhere(uiKey, tab), [sessionId, tab]);
  // The folder the tree is rooted at, and the one the toolbar acts on.
  const [root, setRoot] = useState<string | null>(where.cwd ?? null);
  const [selectedDir, setSelectedDir] = useState<string | null>(where.cwd ?? null);
  const [openFile, setOpenFile] = useState<string | null>(where.file ?? null);
  // The last row clicked, file or folder: what Copy, Rename and Delete act on when nothing is marked.
  const [focusPath, setFocusPath] = useState<string | null>(where.file ?? null);
  const [children, setChildren] = useState<Map<string, RemoteEntry[]>>(new Map());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // what a long operation is doing
  const [showHidden, setShowHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [addressOpen, setAddressOpen] = useState(false);
  const [address, setAddress] = useState("");
  const [dropDir, setDropDir] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const mark = useMarkedPaths(scrollRef);
  const clip = useFileClip();
  const side = useMemo<TransferSide>(() => ({ kind: "remote", tab }), [tab]);
  const label = remoteTabLabel(remote);

  // ---- Connection -------------------------------------------------------------------------------

  const lost = useCallback((e: unknown): boolean => {
    if (e instanceof ApiError && e.status === 409) {
      setStatus({ state: "disconnected", error: e.message });
      return true;
    }
    return false;
  }, []);

  const fail = useCallback(
    (e: unknown, what: string) => {
      if (lost(e)) return;
      setError(`${what}: ${e instanceof Error ? e.message : String(e)}`);
    },
    [lost]
  );

  useEffect(() => {
    let alive = true;
    setStatus({ state: "checking" });
    api
      .remoteStatus(tab)
      .then((s) => {
        if (!alive) return;
        if (s.connected) {
          setHome(s.home ?? "/");
          setStatus({ state: "connected" });
        } else setStatus({ state: "disconnected", error: s.error });
      })
      .catch((e) => alive && setStatus({ state: "disconnected", error: e instanceof Error ? e.message : null }));
    return () => {
      alive = false;
    };
  }, [tab]);

  const onConnected = useCallback((h: string) => {
    setHome(h);
    setStatus({ state: "connected" });
  }, []);

  // Once connected, root the tree where the tab was left — or the connection's start folder, or home.
  const connected = status.state === "connected";
  useEffect(() => {
    if (!connected || root) return;
    const start = remote.connection.startPath?.trim();
    const r = start ? resolvePath(start, home, home) : home;
    setRoot(r);
    setSelectedDir((d) => d ?? r);
  }, [connected, root, home, remote.connection.startPath]);

  // ---- Listing ----------------------------------------------------------------------------------

  /** List a folder: "ok", "failed" (it is not there, or not readable), or "lost" (no connection). */
  const listDir = useCallback(
    async (path: string): Promise<"ok" | "failed" | "lost"> => {
      setLoading((s) => new Set(s).add(path));
      try {
        const res = await api.remoteList(tab, path);
        setChildren((m) => new Map(m).set(path, res.entries));
        return "ok";
      } catch (e) {
        if (lost(e)) return "lost";
        setChildren((m) => new Map(m).set(path, []));
        setError(`${path}: ${e instanceof Error ? e.message : "could not list"}`);
        return "failed";
      } finally {
        setLoading((s) => {
          const n = new Set(s);
          n.delete(path);
          return n;
        });
      }
    },
    [tab, lost]
  );

  // A new root is listed straight away, and only the root is open under it. A reconnect lists it
  // again but keeps the folders that were open — the tree is still the one the person was using.
  const listedRoot = useRef<string | null>(null);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  useEffect(() => {
    if (!connected || !root) return;
    if (listedRoot.current !== root) {
      listedRoot.current = root;
      setExpanded(new Set([root]));
      setChildren(new Map());
    } else {
      for (const d of expandedRef.current) if (d !== root) void listDir(d);
    }
    void listDir(root).then((r) => {
      // A root that is gone (deleted since, or a start folder that never existed) falls back home.
      if (r === "failed" && root !== home) setRoot((cur) => (cur === root ? home : cur));
    });
    saveRemoteWhere(uiKey, tab, { cwd: root });
  }, [connected, root, home, listDir, sessionId, tab]);

  useEffect(() => {
    saveRemoteWhere(uiKey, tab, { file: openFile ?? undefined });
  }, [openFile, sessionId, tab]);

  /** Re-list every open folder (or just the ones given) — after a change, or the refresh button. */
  const reload = useCallback(
    (dirs?: (string | null)[]) => {
      const targets = (dirs ?? [...expanded]).filter((d): d is string => !!d && (expanded.has(d) || d === root));
      for (const d of new Set(targets)) void listDir(d);
    },
    [expanded, listDir, root]
  );

  useEffect(() => {
    const on = (e: Event) => {
      const change = (e as CustomEvent<RemoteChange>).detail;
      if (change?.tab !== tab) return;
      if (change.gone?.length) setOpenFile((f) => (f && change.gone!.some((g) => isUnder(f, g)) ? null : f));
      reload();
    };
    window.addEventListener(REMOTE_CHANGED_EVENT, on);
    return () => window.removeEventListener(REMOTE_CHANGED_EVENT, on);
  }, [tab, reload]);

  const toggle = useCallback(
    (path: string) => {
      setSelectedDir(path);
      setFocusPath(path);
      const opening = !expanded.has(path);
      setExpanded((s) => {
        const n = new Set(s);
        if (opening) n.add(path);
        else n.delete(path);
        return n;
      });
      if (opening) void listDir(path);
    },
    [expanded, listDir]
  );

  const open = useCallback((path: string) => {
    setOpenFile(path);
    setFocusPath(path);
    setSelectedDir(parentOf(path));
  }, []);

  const treeKeys = useTreeKeyNav({ containerRef: scrollRef, onFocusFile: open, onToggleDir: toggle });

  const goTo = useCallback(
    (path: string) => {
      const p = path.trim();
      if (!p) return;
      const abs = resolvePath(p, home, root ?? home);
      setRoot(abs);
      setSelectedDir(abs);
      setAddressOpen(false);
      mark.clear();
    },
    [home, root, mark]
  );

  // ---- Actions ----------------------------------------------------------------------------------

  const target = selectedDir ?? root;
  const visible = useCallback(
    (entries: RemoteEntry[] | undefined) => (entries ?? []).filter((e) => showHidden || !e.name.startsWith(".")),
    [showHidden]
  );
  const entryOf = useCallback(
    (path: string): RemoteEntry | undefined => {
      const parent = parentOf(path);
      return parent ? children.get(parent)?.find((e) => e.path === path) : undefined;
    },
    [children]
  );

  /** What a copy, cut or delete acts on: the marked rows, else the row last clicked. */
  const subject = useCallback((): { path: string; isDir: boolean }[] => {
    if (mark.count > 0) return withoutDescendants([...mark.marked.keys()]).map((p) => ({ path: p, isDir: !!mark.marked.get(p) }));
    if (!focusPath || focusPath === root) return [];
    const e = entryOf(focusPath);
    return [{ path: focusPath, isDir: e?.isDir ?? false }];
  }, [mark, focusPath, root, entryOf]);

  const toClipboard = useCallback(
    (mode: "copy" | "cut") => {
      const items = subject();
      if (items.length === 0) return;
      setFileClip({
        mode,
        base: api.base,
        source: side,
        label,
        items: items.map((i) => ({ path: i.path, name: baseName(i.path), isDir: i.isDir })),
      });
      setNotice(`${mode === "cut" ? "Cut" : "Copied"} ${items.length === 1 ? baseName(items[0].path) : `${items.length} items`} — paste into any file panel.`);
      mark.clear();
    },
    [api, subject, side, label, mark]
  );

  const paste = useCallback(async () => {
    const c = getFileClip();
    if (!c || !target) return;
    const from = clipSourceFor(c, api.base);
    if ("error" in from) {
      setError(from.error);
      return;
    }
    const move = c.mode === "cut";
    setBusy(`${move ? "Moving" : "Copying"} ${c.items.length === 1 ? c.items[0].name : `${c.items.length} items`}…`);
    setError(null);
    try {
      const r = await api.transfer(from.source, c.items.map((i) => i.path), side, target, move);
      if (move && r.errors.length === 0) clearFileClip();
      if (r.errors.length) setError(r.errors.map((x) => `${baseName(x.path)}: ${x.error}`).join(" · "));
      else setNotice(`${move ? "Moved" : "Pasted"} ${r.paths.length === 1 ? baseName(r.paths[0]) : `${r.paths.length} items`} into ${baseName(target)}.`);
      setExpanded((s) => new Set(s).add(target));
      const dirs: (string | null)[] = [target];
      const moved = move ? c.items.map((i) => i.path).filter((p) => !r.errors.some((x) => x.path === p)) : [];
      if (move && (c.base ?? "") === api.base && sameSide(c.source, side)) {
        dirs.push(...c.items.map((i) => parentOf(i.path)));
        setOpenFile((f) => (f && moved.some((p) => isUnder(f, p)) ? null : f));
      }
      reload(dirs);
      void listDir(target);
      if (move && c.source.kind === "remote" && c.source.tab !== tab) announceRemoteChange(c.source.tab, moved);
    } catch (e) {
      // A 409 can be the source's: copied in a tab that has since closed or dropped. Only this tab
      // going away is a reason to show its connect prompt.
      if (e instanceof ApiError && e.status === 409) {
        const s = await api.remoteStatus(tab).catch(() => null);
        if (s?.connected) {
          setError("Paste failed: where it was copied from is no longer connected — copy it again.");
          return;
        }
      }
      fail(e, "Paste failed");
    } finally {
      setBusy(null);
    }
  }, [target, side, reload, listDir, tab, fail]);

  const remove = useCallback(async () => {
    const items = subject();
    if (items.length === 0) return;
    const what = items.length === 1 ? baseName(items[0].path) : `${items.length} items`;
    const ok = await confirm({
      title: `Delete ${what}?`,
      description: (
        <>
          On <span className="font-medium text-foreground">{connectionTarget(remote.connection)}</span>, permanently —
          there is no recycle bin over SFTP.
          {items.some((i) => i.isDir) && " Folders are deleted with everything in them."}
        </>
      ),
      confirmLabel: "Delete",
    });
    if (!ok) return;
    setBusy(`Deleting ${what}…`);
    try {
      for (const i of items) await api.remoteDelete(tab, i.path);
      if (openFile && items.some((i) => isUnder(openFile, i.path))) setOpenFile(null);
      mark.clear();
      setFocusPath(null);
      reload(items.map((i) => parentOf(i.path)));
    } catch (e) {
      fail(e, "Delete failed");
      reload(items.map((i) => parentOf(i.path)));
    } finally {
      setBusy(null);
    }
  }, [subject, confirm, remote.connection, tab, openFile, mark, reload, fail]);

  const rename = useCallback(
    async (path: string, name: string) => {
      setRenaming(null);
      if (!name.trim() || name === baseName(path)) return;
      try {
        const r = await api.remoteRename(tab, path, name.trim());
        if (openFile && isUnder(openFile, path)) setOpenFile(r.path + openFile.slice(path.length));
        if (selectedDir && isUnder(selectedDir, path)) setSelectedDir(r.path + selectedDir.slice(path.length));
        setFocusPath(r.path);
        reload([parentOf(path)]);
      } catch (e) {
        fail(e, "Rename failed");
      }
    },
    [tab, openFile, selectedDir, reload, fail]
  );

  const create = useCallback(
    async (kind: "file" | "folder") => {
      if (!target) return;
      const name = window.prompt(kind === "file" ? `New file in ${target}` : `New folder in ${target}`);
      if (!name?.trim()) return;
      try {
        const path = join(target, name.trim());
        const r = kind === "file" ? await api.remoteNewFile(tab, path) : await api.remoteMkdir(tab, path);
        setExpanded((s) => new Set(s).add(target));
        await listDir(target);
        if (kind === "file") open(r.path);
      } catch (e) {
        fail(e, kind === "file" ? "Could not create the file" : "Could not create the folder");
      }
    },
    [target, tab, listDir, open, fail]
  );

  const upload = useCallback(
    async (files: FileList | File[] | null, dir = target) => {
      if (!files || files.length === 0 || !dir) return;
      const list = Array.from(files);
      setBusy(`Uploading ${list.length === 1 ? list[0].name : `${list.length} files`}…`);
      try {
        await api.remoteUpload(tab, dir, list);
        setExpanded((s) => new Set(s).add(dir));
        await listDir(dir);
      } catch (e) {
        fail(e, "Upload failed");
      } finally {
        setBusy(null);
      }
    },
    [target, tab, listDir, fail]
  );

  const download = useCallback(() => {
    const files = subject().filter((i) => !i.isDir);
    // One click per file: a browser will not take a folder as one download, and zipping on the far
    // side would need a shell the host may not offer.
    for (const f of files) {
      const a = document.createElement("a");
      a.href = api.remoteFileUrl(tab, f.path, true);
      a.download = baseName(f.path);
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  }, [subject, tab]);

  const disconnect = useCallback(async () => {
    await api.remoteDisconnect(tab).catch(() => {});
    setStatus({ state: "disconnected", error: "Disconnected.", manual: true });
  }, [tab]);

  // Keyboard: the clipboard and the usual file-manager keys, while the tree has focus.
  const onTreeKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (renaming) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "Escape" && mark.selecting) {
      e.preventDefault();
      mark.clear();
      return;
    }
    if (mod && (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "x")) {
      if (hasTextSelection() || subject().length === 0) return;
      e.preventDefault();
      toClipboard(e.key.toLowerCase() === "c" ? "copy" : "cut");
    } else if (mod && e.key.toLowerCase() === "v") {
      e.preventDefault();
      void paste();
    } else if (e.key === "Delete") {
      e.preventDefault();
      void remove();
    } else if (e.key === "F2" && focusPath && focusPath !== root) {
      e.preventDefault();
      setRenaming(focusPath);
    } else treeKeys.onKeyDown?.(e);
  };

  // ---- Layout -----------------------------------------------------------------------------------

  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [status.state]);
  const narrow = width !== null && width < NARROW;
  const [treeWidth, setTreeWidth] = useState(() => readNumber(TREE_WIDTH_KEY, 300));
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = treeWidth;
    const move = (ev: PointerEvent) => setTreeWidth(Math.max(180, Math.min(start + ev.clientX - startX, (width ?? 1200) - 240)));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setTreeWidth((w) => (writeStored(TREE_WIDTH_KEY, String(Math.round(w))), w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const source = useMemo<FileSource>(
    () => ({
      url: (p, dl) => api.remoteFileUrl(tab, p, dl),
      text: (p) => api.remoteFileText(tab, p),
      write: (p, c) => api.remoteWrite(tab, p, c),
      newTab: false,
    }),
    [tab]
  );

  if (status.state === "checking")
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Connecting to {label}…
      </div>
    );
  if (status.state === "disconnected")
    return (
      <RemoteReconnect
        tabId={tab}
        connection={remote.connection}
        error={status.error}
        auto={!status.manual}
        onConnected={onConnected}
      />
    );

  const subjectCount = mark.count > 0 ? mark.count : focusPath && focusPath !== root ? 1 : 0;
  const canPaste = !!clip && !!target;
  const actions: ToolAction[] = [
    { id: "up", label: "Up one folder", icon: <ArrowUp className="size-4" />, onClick: () => root && parentOf(root) && goTo(parentOf(root)!), disabled: !root || root === "/" },
    {
      id: "paste",
      label: clip ? describeClip(clip) : "Paste (copy something in any file panel first)",
      icon: <ClipboardPaste className="size-4" />,
      onClick: () => void paste(),
      disabled: !canPaste || !!busy,
    },
    { id: "copy", label: "Copy", icon: <Copy className="size-4" />, onClick: () => toClipboard("copy"), disabled: subjectCount === 0 },
    { id: "cut", label: "Cut", icon: <Scissors className="size-4" />, onClick: () => toClipboard("cut"), disabled: subjectCount === 0 },
    { id: "file", label: "New file", icon: <FilePlus className="size-4" />, onClick: () => void create("file"), disabled: !target },
    { id: "folder", label: "New folder", icon: <FolderPlus className="size-4" />, onClick: () => void create("folder"), disabled: !target },
    { id: "upload", label: "Upload files here", icon: <Upload className="size-4" />, onClick: () => uploadRef.current?.click(), disabled: !target || !!busy },
    { id: "download", label: "Download", icon: <Download className="size-4" />, onClick: download, disabled: !subject().some((i) => !i.isDir) },
    { id: "delete", label: "Delete", icon: <Trash2 className="size-4" />, onClick: () => void remove(), disabled: subjectCount === 0 || !!busy },
    {
      id: "select",
      label: mark.selecting ? "Leave select mode" : "Select files",
      icon: <ListChecks className="size-4" />,
      onClick: () => (mark.selecting ? mark.clear() : mark.start()),
      pressed: mark.selecting,
    },
    { id: "home", label: "Home folder", icon: <Home className="size-4" />, onClick: () => goTo(home) },
    {
      id: "hidden",
      label: showHidden ? "Hide dotfiles" : "Show dotfiles",
      icon: showHidden ? <Eye className="size-4" /> : <EyeOff className="size-4" />,
      onClick: () =>
        setShowHidden((v) => {
          writeStored(HIDDEN_KEY, v ? "0" : "1");
          return !v;
        }),
      pressed: showHidden,
    },
    { id: "refresh", label: "Refresh", icon: <RefreshCw className="size-4" />, onClick: () => reload() },
    { id: "disconnect", label: "Disconnect", icon: <Unplug className="size-4" />, onClick: () => void disconnect() },
  ];
  const paneWidth = narrow ? width ?? 0 : treeWidth;
  const room = width === null ? Infinity : paneWidth - 16 - LABEL_MIN;
  const fitsAll = actions.length * TOOL_SLOT <= room;
  const shown = fitsAll ? actions.length : Math.max(0, Math.floor(room / TOOL_SLOT) - 1);

  const crumbs = (root ?? "/").split("/").filter(Boolean);

  const tree = (
    <div className="flex h-full min-h-0 min-w-0 flex-col" style={narrow ? undefined : { width: treeWidth }}>
      <div className="flex items-center gap-0.5 border-b px-2 py-1.5">
        <Server className="mr-1 size-4 shrink-0 text-muted-foreground" />
        <span className="mr-auto min-w-0 truncate text-xs font-medium" title={connectionTarget(remote.connection)}>
          {label}
        </span>
        {actions.slice(0, shown).map((a) => (
          <Button
            key={a.id}
            variant="ghost"
            size="icon"
            className={cn("size-7 shrink-0", a.pressed && "text-foreground")}
            title={a.label}
            aria-label={a.label}
            aria-pressed={a.pressed}
            disabled={a.disabled}
            onClick={a.onClick}
          >
            {a.icon}
          </Button>
        ))}
        {shown < actions.length && <ToolbarMore actions={actions.slice(shown)} />}
        <input
          ref={uploadRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            void upload(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Where the tree is rooted: each segment goes there, and the blank end opens the address field. */}
      {addressOpen ? (
        <form
          className="flex items-center gap-1 border-b px-2 py-1"
          onSubmit={(e) => {
            e.preventDefault();
            goTo(address);
          }}
        >
          <input
            value={address}
            autoFocus
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder="/path/to/folder, or ~/relative"
            aria-label="Remote path to go to"
            onChange={(e) => setAddress(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setAddressOpen(false);
              }
            }}
            onBlur={() => setTimeout(() => setAddressOpen(false), 150)}
            className="h-6 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <Button type="submit" variant="ghost" size="icon" className="size-6 shrink-0" title="Go (Enter)">
            <CornerDownLeft className="size-3.5" />
          </Button>
        </form>
      ) : (
        <div className="flex min-w-0 items-center border-b px-2 py-1 font-mono text-xs text-muted-foreground">
          <div className="flex min-w-0 items-center overflow-hidden">
            <button type="button" className="shrink-0 rounded px-0.5 hover:bg-accent hover:text-foreground" onClick={() => goTo("/")}>
              /
            </button>
            {crumbs.map((seg, i) => (
              <span key={i} className="flex min-w-0 items-center">
                <button
                  type="button"
                  className="min-w-0 truncate rounded px-0.5 hover:bg-accent hover:text-foreground"
                  onClick={() => goTo(`/${crumbs.slice(0, i + 1).join("/")}`)}
                >
                  {seg}
                </button>
                {i < crumbs.length - 1 && <span className="shrink-0">/</span>}
              </span>
            ))}
          </div>
          <button
            type="button"
            className="ml-1 h-5 min-w-4 flex-1 rounded hover:bg-accent"
            title="Type a path"
            aria-label="Type a path"
            onClick={() => {
              setAddress(root ?? "");
              setAddressOpen(true);
            }}
          />
          {root && <CopyPathButton path={root} iconClassName="size-3" className="shrink-0 text-muted-foreground hover:text-foreground" />}
        </div>
      )}

      {busy && (
        <div className="flex items-center gap-2 border-b bg-accent/40 px-2 py-1 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {busy}
        </div>
      )}
      {error && (
        <div className="cursor-pointer border-b bg-destructive/10 px-2 py-1 text-xs text-destructive" onClick={() => setError(null)} title="Dismiss">
          {error}
        </div>
      )}
      {notice && !error && !busy && (
        <div className="cursor-pointer border-b bg-accent/40 px-2 py-1 text-xs text-muted-foreground" onClick={() => setNotice(null)} title="Dismiss">
          {notice}
        </div>
      )}
      {mark.selecting && (
        <div className="flex items-center gap-1 border-b bg-accent/40 px-2 py-1 text-xs">
          <span className="min-w-0 flex-1 truncate text-muted-foreground">
            {mark.count > 0 ? `${mark.count} selected` : "Select files and folders"}
          </span>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={mark.clear}>
            Cancel
          </Button>
        </div>
      )}

      <div
        ref={scrollRef}
        {...treeKeys}
        onKeyDown={onTreeKey}
        // Arrowing onto a row focuses it; that row, not the last one clicked, is what Delete, F2 and
        // Ctrl+C act on.
        onFocus={(e) => {
          const row = (e.target as HTMLElement).closest<HTMLElement>("[data-nav-row]");
          if (row?.dataset.navRow) setFocusPath(row.dataset.navRow);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          const row = (e.target as HTMLElement).closest<HTMLElement>("[data-drop-dir]");
          setDropDir(row?.dataset.dropDir ?? root);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropDir(null);
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          const dir = dropDir ?? root;
          setDropDir(null);
          void upload(e.dataTransfer.files, dir);
        }}
        className={cn("min-h-0 flex-1 overflow-auto py-1 outline-none", dropDir === root && "bg-primary/5")}
      >
        {root &&
          (loading.has(root) && !children.has(root) ? (
            <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" /> Listing…
            </div>
          ) : visible(children.get(root)).length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Empty folder</div>
          ) : (
            visible(children.get(root)).map((e) => (
              <RemoteNode
                key={e.path}
                entry={e}
                depth={0}
                ctx={{
                  children,
                  expanded,
                  loading,
                  openFile,
                  selectedDir,
                  focusPath,
                  renaming,
                  dropDir,
                  clipCut: clip?.mode === "cut" && sameSide(clip.source, side) ? new Set(clip.items.map((i) => i.path)) : null,
                  mark,
                  visible,
                  onToggle: toggle,
                  onOpen: open,
                  onRename: (p, n) => void rename(p, n),
                  onStartRename: setRenaming,
                  onCancelRename: () => setRenaming(null),
                  onDelete: (p, isDir) => void removeOne(p, isDir),
                  downloadUrl: (p) => api.remoteFileUrl(tab, p, true),
                }}
              />
            ))
          ))}
      </div>
    </div>
  );

  // Deleting from a row's own button: the same confirmation, for that one row.
  async function removeOne(path: string, isDir: boolean) {
    const ok = await confirm({
      title: `Delete ${baseName(path)}?`,
      description: `On ${connectionTarget(remote.connection)}, permanently.${isDir ? " The folder is deleted with everything in it." : ""}`,
      confirmLabel: "Delete",
    });
    if (!ok) return;
    try {
      await api.remoteDelete(tab, path);
      if (openFile && isUnder(openFile, path)) setOpenFile(null);
      setFocusPath(null);
      reload([parentOf(path)]);
    } catch (e) {
      fail(e, "Delete failed");
    }
  }

  const preview = openFile ? (
    <div className="min-h-0 min-w-0 flex-1">
      <ServerFileViewer key={openFile} path={openFile} source={source} onClose={() => setOpenFile(null)} />
    </div>
  ) : (
    <div className="flex min-w-0 flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-sm text-muted-foreground">
      <Server className="size-8 opacity-40" />
      <p>Pick a file to preview it here.</p>
      <p className="text-xs">
        Copy and cut work across panels: paste into this session's Files, another SSH tab, or back here.
      </p>
    </div>
  );

  return (
    <div ref={rootRef} className="flex h-full min-h-0 min-w-0">
      {narrow ? (
        openFile ? preview : <div className="min-w-0 flex-1">{tree}</div>
      ) : (
        <>
          {tree}
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={startDrag}
            onDoubleClick={() => {
              setTreeWidth(300);
              writeStored(TREE_WIDTH_KEY, "300");
            }}
            className="w-1 shrink-0 cursor-col-resize border-l bg-transparent hover:bg-primary/20"
            title="Drag to resize; double-click to reset"
          />
          {preview}
        </>
      )}
    </div>
  );
}

interface NodeCtx {
  children: Map<string, RemoteEntry[]>;
  expanded: Set<string>;
  loading: Set<string>;
  openFile: string | null;
  selectedDir: string | null;
  focusPath: string | null;
  renaming: string | null;
  dropDir: string | null;
  /** Paths cut from this tab, drawn faded until they are pasted. */
  clipCut: Set<string> | null;
  mark: MarkedPaths;
  visible: (entries: RemoteEntry[] | undefined) => RemoteEntry[];
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
  onRename: (path: string, name: string) => void;
  onStartRename: (path: string) => void;
  onCancelRename: () => void;
  onDelete: (path: string, isDir: boolean) => void;
  downloadUrl: (path: string) => string;
}

function RemoteNode({ entry, depth, ctx }: { entry: RemoteEntry; depth: number; ctx: NodeCtx }) {
  const { path, name, isDir } = entry;
  const isOpen = ctx.expanded.has(path);
  const kids = ctx.children.get(path);
  const active = !isDir && ctx.openFile === path;
  const selected = isDir && ctx.selectedDir === path;
  const focused = ctx.focusPath === path;
  const marked = ctx.mark.has(path);
  const hover = "hidden shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground group-hover:block";

  return (
    <div>
      <div
        {...navRowProps({ path, isDir, open: isOpen, current: active || selected, depth })}
        data-drop-dir={isDir ? path : undefined}
        className={cn(
          "group flex cursor-pointer items-center gap-1 rounded px-1 py-0.5 text-sm hover:bg-accent",
          active && "bg-accent font-medium",
          selected && "bg-accent/50",
          focused && !active && !selected && "bg-accent/30",
          marked && "bg-primary/10",
          ctx.dropDir === path && "bg-primary/15 ring-1 ring-primary/40",
          ctx.clipCut?.has(path) && "opacity-50"
        )}
        style={{ paddingLeft: depth * 12 + 4 }}
        title={isDir ? path : `${path} — ${formatSize(entry.size)}${entry.modified ? ` — ${new Date(entry.modified).toLocaleString()}` : ""}`}
        onClick={(e) => {
          if (ctx.mark.selecting || e.ctrlKey || e.metaKey) ctx.mark.toggle(path, isDir, e.shiftKey);
          else if (isDir) ctx.onToggle(path);
          else ctx.onOpen(path);
        }}
      >
        {ctx.mark.selecting && (
          <span className={cn("shrink-0", marked ? "text-primary" : "text-muted-foreground")}>
            {marked ? <SquareCheck className="size-4" /> : <Square className="size-4" />}
          </span>
        )}
        {isDir ? (
          isOpen ? (
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-4 shrink-0" />
        )}
        {isDir ? (
          isOpen ? (
            <FolderOpen className="size-4 shrink-0 text-sky-500" />
          ) : (
            <Folder className="size-4 shrink-0 text-sky-500" />
          )
        ) : (
          <FileGlyph name={name} />
        )}
        {ctx.renaming === path ? (
          <RenameField value={name} onSubmit={(n) => ctx.onRename(path, n)} onCancel={ctx.onCancelRename} />
        ) : (
          <span className={cn("min-w-0 flex-1 truncate", name.startsWith(".") && "text-muted-foreground")}>{name}</span>
        )}
        {entry.isLink && <Link2 className="size-3 shrink-0 text-muted-foreground" aria-label="symbolic link" />}
        {ctx.loading.has(path) && <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />}
        {ctx.renaming !== path && (
          <>
            <CopyPathButton path={path} iconClassName="size-3" className={hover} />
            {!isDir && (
              <a
                href={ctx.downloadUrl(path)}
                download={name}
                className={hover}
                title="Download"
                onClick={(e) => e.stopPropagation()}
              >
                <Download className="size-3" />
              </a>
            )}
            {!ctx.mark.selecting && (
              <button
                className={hover}
                title="Select"
                onClick={(e) => {
                  e.stopPropagation();
                  ctx.mark.toggle(path, isDir, e.shiftKey);
                }}
              >
                <Square className="size-3" />
              </button>
            )}
            <button
              className={hover}
              title="Rename (F2)"
              onClick={(e) => {
                e.stopPropagation();
                ctx.onStartRename(path);
              }}
            >
              <Pencil className="size-3" />
            </button>
            <button
              className={cn(hover, "hover:text-destructive")}
              title="Delete"
              onClick={(e) => {
                e.stopPropagation();
                ctx.onDelete(path, isDir);
              }}
            >
              <Trash2 className="size-3" />
            </button>
          </>
        )}
      </div>
      {isDir && isOpen && kids && (
        <div>
          {ctx.visible(kids).length === 0 ? (
            <div className="px-1 py-0.5 text-xs text-muted-foreground" style={{ paddingLeft: (depth + 1) * 12 + 24 }}>
              empty
            </div>
          ) : (
            ctx.visible(kids).map((c) => <RemoteNode key={c.path} entry={c} depth={depth + 1} ctx={ctx} />)
          )}
        </div>
      )}
    </div>
  );
}
