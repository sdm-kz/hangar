import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, apiErrorText, type ApiError, type CaptureAdded, type NewSessionTarget } from "@/lib/tauri";
import { Canvas, type CanvasHandle } from "./Canvas";
import { MessageBox, SendBar, SessionPicker, type SendState, type SessionsState } from "./Composer";
import { NewSessionPanel, type OptionsState } from "./NewSession";
import { MAX_PAGES, loadPage, moveItem, neighbourOf, rawPng, thumbnail, type Page } from "./pages";
import { PageStrip } from "./PageStrip";
import {
  CANVAS_MIN,
  COMPOSER_HEIGHT,
  COMPOSER_MIN,
  MESSAGE_MIN,
  PICKER_MIN,
  PICKER_WIDTH,
  Splitter,
  TOOLBAR_HEIGHT,
  loadLayout,
  saveLayout,
} from "./Splitter";
import { Toolbar } from "./Toolbar";
import {
  COLORS,
  WEIGHTS,
  applyCrop,
  commit,
  emptyHistory,
  exportArea,
  FIT_MARGIN,
  frameOf,
  isCropped,
  measureText,
  redo,
  removeShape,
  restyle,
  replaceShape,
  toolForKey,
  uncrop,
  undo,
  type Doc,
  type Tool,
  type Weight,
} from "./model";
import { filterSessions, keepSelection, stepSelection } from "./sessions";
import { FIT, panBy, percent, place, scaleOf, stepZoom, zoomTo, type Size, type View } from "./view";

// The new-session form starts where it was left: the next capture tends to belong to the same work.
const NEW_TARGET_KEY = "snap.newSession";
function loadNewTarget(): NewSessionTarget {
  try {
    const t = JSON.parse(localStorage.getItem(NEW_TARGET_KEY) ?? "null") as Partial<NewSessionTarget> | null;
    if (t) return { folder: t.folder ?? "", projectId: t.projectId ?? null, groupId: t.groupId ?? null };
  } catch {
    /* storage unavailable or garbled: start empty */
  }
  return { folder: "", projectId: null, groupId: null };
}
function saveNewTarget(t: NewSessionTarget) {
  try {
    localStorage.setItem(NEW_TARGET_KEY, JSON.stringify(t));
  } catch {
    /* not remembered; nothing else depends on it */
  }
}

const isMac = navigator.userAgent.includes("Mac");

/** Device pixels per CSS pixel, followed as the window moves to a screen of another scaling — which
 *  needn't change its size. */
function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  useEffect(() => {
    const mq = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const changed = () => setDpr(window.devicePixelRatio || 1);
    mq.addEventListener("change", changed);
    return () => mq.removeEventListener("change", changed);
  }, [dpr]);
  return dpr;
}
const MOD = isMac ? "⌘" : "Ctrl+";

/** The last tool, colour and weight, so the next capture starts the way the last one was left. */
const PREFS_KEY = "snap.editor.prefs";
function loadPrefs(): { tool: Tool; color: string; weight: Weight } {
  const fallback = { tool: "arrow" as Tool, color: COLORS[0], weight: "m" as Weight };
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    return saved ? { ...fallback, ...saved, tool: saved.tool === "crop" ? "arrow" : (saved.tool ?? fallback.tool) } : fallback;
  } catch {
    return fallback;
  }
}

/** Let React commit the last state change (an ended text edit, a cleared selection) before exporting.
 *  A timer, not requestAnimationFrame: rAF stops for a window the OS reports as hidden — minimized, or
 *  behind a locked screen — and the send would never happen. */
const settle = () => new Promise<void>((r) => setTimeout(r, 32));

function toPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error("Could not encode the image"));
      else blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
    }, "image/png"),
  );
}

/**
 * A capture, to mark up and send. The picture fills the middle; tools above it; below it, the message
 * and which session it goes to. The message box has the focus from the start — the quickest path is
 * capture, type, ⌘↵ — and Esc leaves it, so the single-letter tool keys work.
 */
export default function Editor({ id }: { id: string }) {
  // The captures in this editor, in the order they go, and the one on show. That one's drawing and view
  // are `history` and `view` below; the others' wait in their pages (see pages.ts).
  const [pages, setPages] = useState<Page[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const prefs = useMemo(loadPrefs, []);
  const [history, setHistory] = useState(emptyHistory);
  const [tool, setTool] = useState<Tool>(prefs.tool);
  const [color, setColor] = useState(prefs.color);
  const [weight, setWeight] = useState<Weight>(prefs.weight);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [sessions, setSessions] = useState<SessionsState>({ kind: "loading" });
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  // Starting a new session for this capture, in place of sending to a running one.
  const [creating, setCreating] = useState(false);
  const [newTarget, setNewTarget] = useState<NewSessionTarget>(loadNewTarget);
  const [options, setOptions] = useState<OptionsState>({ kind: "loading" });
  const folderRef = useRef<HTMLInputElement>(null);
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [confirmClose, setConfirmClose] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<View>(FIT);
  // Held Space: a drag moves the picture instead of drawing on it.
  const [spaceHeld, setSpaceHeld] = useState(false);
  // The composer's height and the session list's width, dragged by the two splitters and kept for
  // the next capture. CSS holds each to what fits the window, so a size kept from a bigger one can't
  // squeeze the picture or the message box away.
  const savedLayout = useMemo(loadLayout, []);
  const [composerHeight, setComposerHeight] = useState(savedLayout.composer);
  const [pickerWidth, setPickerWidth] = useState(savedLayout.picker);
  const composerRef = useRef<HTMLDivElement>(null);
  const messageColRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const activePage = pages.find((p) => p.id === activeId) ?? null;
  const image = activePage?.image ?? null;
  const init = activePage?.init ?? null;
  const doc = history.present;
  const captureScale = init?.scale ?? 1;
  const strokeWidth = WEIGHTS[weight] * captureScale;
  const dirty = pages.length > 1 || history.past.length > 0 || message.trim().length > 0;

  // What the page changes below work from. They run one after another (`enqueue`), each from what the
  // last left, which a render may not have caught up with yet — so the pages and the one on show are
  // written here as they are set, not when React renders them.
  const pagesRef = useRef(pages);
  const activeRef = useRef(activeId);
  const historyRef = useRef(history);
  historyRef.current = history;
  const viewRef = useRef(view);
  viewRef.current = view;
  const updatePages = useCallback((change: (pages: Page[]) => Page[]) => {
    pagesRef.current = change(pagesRef.current);
    setPages(pagesRef.current);
  }, []);
  const show = useCallback((page: Page) => {
    activeRef.current = page.id;
    setActiveId(page.id);
    setHistory(page.history);
    setView(page.view);
    setSelectedId(null);
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ tool, color, weight }));
    } catch {
      /* a convenience only */
    }
  }, [tool, color, weight]);

  // ---- Loading ----
  // An editor is often loaded ahead of its capture (the spare, see lib.rs): it then hears "pending",
  // and loads when `capture-ready` names its id. Listening starts before the first ask, so the
  // announcement can't slip in between.
  useEffect(() => {
    let cancelled = false;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      loadPage(id).then(
        (page) => {
          if (cancelled) return URL.revokeObjectURL(page.url);
          // The tool, colour and weight as the last editor left them — this page may have been loaded
          // long before that one closed.
          const latest = loadPrefs();
          setTool(latest.tool);
          setColor(latest.color);
          setWeight(latest.weight);
          updatePages(() => [page]);
          show(page);
          void api.editorReady().then(() => messageRef.current?.focus());
        },
        (e) => {
          loading = false;
          if (String(e) !== "pending") setLoadError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    const ready = listen<string>("capture-ready", (e) => {
      if (e.payload === id) load();
    });
    void ready.then(() => !cancelled && load());
    return () => {
      cancelled = true;
      void ready.then((f) => f());
    };
  }, [id, updatePages, show]);
  useEffect(() => () => pagesRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  useEffect(() => {
    if (!init) return;
    const which = pages.length > 1 ? ` — ${pages.findIndex((p) => p.id === activeId) + 1} of ${pages.length}` : "";
    void getCurrentWindow().setTitle(`Hangar Tray App — ${init.width} × ${init.height}${which}`);
  }, [init, pages, activeId]);

  useEffect(() => saveLayout({ composer: composerHeight, picker: pickerWidth }), [composerHeight, pickerWidth]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setArea({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The picture is what is on show of it: the part a crop applied leaves, or all of it.
  const shown = image ? frameOf(doc, image.naturalWidth, image.naturalHeight) : null;
  // Fitted to the window until zoomed (see view.ts). The handlers below read the sizes through a ref,
  // so they needn't be re-attached each time the window or the zoom changes.
  const imageSize = useMemo<Size>(
    () => ({ width: shown?.width ?? 0, height: shown?.height ?? 0 }),
    [shown?.width, shown?.height],
  );
  // Applying a crop, or undoing one, changes what there is to show: the view goes back to fitting it.
  // The picture growing to fit a shape only adds to it, so a zoomed view stays where it was, moved by
  // whatever was added above and to the left. Not on a change of page, which brings its own view.
  const lastFrame = useRef({ page: activeId, frame: doc.frame });
  useEffect(() => {
    const last = lastFrame.current;
    lastFrame.current = { page: activeId, frame: doc.frame };
    if (last.page !== activeId || last.frame === doc.frame || !image) return;
    const was = frameOf({ ...doc, frame: last.frame }, image.naturalWidth, image.naturalHeight);
    const now = frameOf(doc, image.naturalWidth, image.naturalHeight);
    const grew =
      now.x <= was.x &&
      now.y <= was.y &&
      now.x + now.width >= was.x + was.width &&
      now.y + now.height >= was.y + was.height;
    setView((v) => (grew && v.zoom !== null ? { ...v, cx: v.cx + was.x - now.x, cy: v.cy + was.y - now.y } : FIT));
    // Only a change of frame (or page) moves the view; `doc` and `image` are read as they are then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, doc.frame]);
  const dpr = useDevicePixelRatio();
  const placement = useMemo(() => place(view, imageSize, area, dpr), [view, imageSize, area, dpr]);
  const viewScale = placement.scale;
  const viewport = useMemo(
    () => ({ width: placement.width, height: placement.height, panX: placement.panX, panY: placement.panY }),
    [placement],
  );
  const geometry = useRef({ imageSize, area, dpr });
  geometry.current = { imageSize, area, dpr };
  // Until the picture is in, there is nothing to zoom: it opens fitted.
  const zoomStep = useCallback((dir: 1 | -1) => {
    const g = geometry.current;
    if (g.imageSize.width === 0) return;
    setView((v) => stepZoom(v, dir, g.imageSize, g.area, g.dpr));
  }, []);
  const actualSize = useCallback(() => {
    const g = geometry.current;
    if (g.imageSize.width === 0) return;
    setView((v) => zoomTo(v, 1 / g.dpr, { x: g.area.width / 2, y: g.area.height / 2 }, g.imageSize, g.area, g.dpr));
  }, []);

  // Ctrl+wheel (a touchpad pinch arrives as one) zooms about the pointer; the wheel alone pans.
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geometry.current;
      if (g.imageSize.width === 0) return;
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? g.area.height : 1;
      if (e.ctrlKey || e.metaKey) {
        const box = el.getBoundingClientRect();
        const at = { x: e.clientX - box.left, y: e.clientY - box.top };
        const factor = Math.exp(-e.deltaY * unit * 0.002);
        setView((v) => zoomTo(v, scaleOf(v, g.imageSize, g.area, g.dpr) * factor, at, g.imageSize, g.area, g.dpr));
        return;
      }
      // Shift turns a plain wheel sideways, where the browser hasn't already.
      const sideways = e.shiftKey && e.deltaX === 0;
      const dx = (sideways ? e.deltaY : e.deltaX) * unit;
      const dy = (sideways ? 0 : e.deltaY) * unit;
      setView((v) => panBy(v, dx, dy, g.imageSize, g.area, g.dpr));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Dragging with the middle button, or with Space held, moves the picture. Caught on the way down,
  // before the canvas takes the press for the start of a stroke.
  const spaceRef = useRef(false);
  spaceRef.current = spaceHeld;
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    let drag: { id: number; x: number; y: number } | null = null;
    const down = (e: PointerEvent) => {
      if (e.button !== 1 && !(e.button === 0 && spaceRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      el.dataset.panning = "";
    };
    const move = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = drag.x - e.clientX;
      const dy = drag.y - e.clientY;
      drag = { ...drag, x: e.clientX, y: e.clientY };
      const g = geometry.current;
      setView((v) => panBy(v, dx, dy, g.imageSize, g.area, g.dpr));
    };
    const up = (e: PointerEvent) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag = null;
      delete el.dataset.panning;
    };
    // The middle button would otherwise start the browser's own autoscroll.
    const noAutoscroll = (e: MouseEvent) => {
      if (e.button === 1) e.preventDefault();
    };
    el.addEventListener("pointerdown", down, true);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("mousedown", noAutoscroll, true);
    return () => {
      el.removeEventListener("pointerdown", down, true);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      el.removeEventListener("mousedown", noAutoscroll, true);
    };
  }, []);
  useEffect(() => {
    const release = (e: KeyboardEvent) => {
      if (e.code === "Space") setSpaceHeld(false);
    };
    const lost = () => setSpaceHeld(false);
    window.addEventListener("keyup", release);
    window.addEventListener("blur", lost);
    return () => {
      window.removeEventListener("keyup", release);
      window.removeEventListener("blur", lost);
    };
  }, []);

  // ---- Sessions ----
  const loadSessions = useCallback(() => {
    setSessions((s) => (s.kind === "ready" ? s : { kind: "loading" }));
    api.listSessions().then(
      (view) => setSessions({ kind: "ready", items: view.items }),
      (e: ApiError | string) => setSessions({ kind: "error", error: e }),
    );
  }, []);
  const loaded = pages.length > 0;
  useEffect(() => {
    if (!loaded) return; // a spare editor, still waiting for its capture, has no one to send to yet
    loadSessions();
    const onFocus = () => loadSessions();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(loadSessions, 15_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [loaded, loadSessions]);

  const loadOptions = useCallback(() => {
    setOptions({ kind: "loading" });
    api.newSessionOptions().then(
      (o) => {
        setOptions({ kind: "ready", options: o });
        // Drop a remembered project or group that no longer exists.
        setNewTarget((t) => {
          const p = o.projects.find((x) => x.id === t.projectId);
          return {
            ...t,
            projectId: p ? p.id : null,
            groupId: p && p.groups.some((g) => g.id === t.groupId) ? t.groupId : null,
          };
        });
      },
      (e: ApiError | string) => setOptions({ kind: "error", error: e }),
    );
  }, []);
  const startCreating = useCallback(() => {
    setCreating(true);
    loadOptions();
    // Straight into the folder when there is none yet; otherwise the prompt is what is left to write.
    setTimeout(() => (newTarget.folder ? messageRef.current : folderRef.current)?.focus(), 0);
  }, [loadOptions, newTarget.folder]);
  useEffect(() => saveNewTarget(newTarget), [newTarget]);

  const allItems = useMemo(() => (sessions.kind === "ready" ? sessions.items : []), [sessions]);
  const items = useMemo(() => filterSessions(allItems, query), [allItems, query]);
  useEffect(() => setTarget((t) => keepSelection(items, t)), [items]);
  const targetItem = items.find((s) => s.key === target) ?? null;

  // ---- Actions ----
  const onCommit = useCallback((next: Doc) => setHistory((h) => commit(h, next)), []);

  const exportPng = useCallback(async (): Promise<Uint8Array | null> => {
    canvasRef.current?.finishEditing();
    setSelectedId(null);
    await settle();
    const canvas = canvasRef.current?.exportCanvas();
    return canvas ? toPng(canvas) : null;
  }, []);

  const flash = useCallback((text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 1800);
  }, []);

  // ---- Pages ----
  const queue = useRef(Promise.resolve());
  const enqueue = useCallback((job: () => Promise<void> | void) => {
    const next = queue.current.then(job).catch((e) => console.error("Page change failed", e));
    queue.current = next;
    return next;
  }, []);

  /** The page on show as it stands — its drawing, view and flattened picture — to be put away. */
  const snapshotActive = useCallback(async (): Promise<Page | null> => {
    const current = pagesRef.current.find((p) => p.id === activeRef.current);
    if (!current) return null;
    canvasRef.current?.finishEditing();
    setSelectedId(null);
    await settle();
    const history = historyRef.current;
    let { flat, thumb } = current;
    if (flat?.doc !== history.present) {
      const canvas = canvasRef.current?.exportCanvas();
      if (canvas) {
        flat = { doc: history.present, png: toPng(canvas) };
        thumb = thumbnail(canvas);
      }
    }
    return { ...current, history, view: viewRef.current, flat, thumb };
  }, []);

  /** Put the page on show away as it stands, then show `next` (added after the others when `add`). */
  const switchTo = useCallback(
    async (next: Page, add = false) => {
      if (add && pagesRef.current.some((p) => p.id === next.id)) return URL.revokeObjectURL(next.url);
      const left = await snapshotActive();
      updatePages((ps) => {
        const kept = left ? ps.map((p) => (p.id === left.id ? left : p)) : ps;
        return add ? [...kept, next] : kept;
      });
      show(next);
    },
    [snapshotActive, updatePages, show],
  );

  const selectPage = useCallback(
    (pageId: string) =>
      enqueue(async () => {
        const target = pagesRef.current.find((p) => p.id === pageId);
        if (target && pageId !== activeRef.current) await switchTo(target);
      }),
    [enqueue, switchTo],
  );
  // The page to go to is worked out in its turn, so a key held down steps once per press.
  const stepPage = useCallback(
    (dir: 1 | -1) =>
      enqueue(async () => {
        const ps = pagesRef.current;
        const next = ps[ps.findIndex((p) => p.id === activeRef.current) + dir];
        if (next) await switchTo(next);
      }),
    [enqueue, switchTo],
  );
  const removePage = useCallback(
    (pageId: string) =>
      enqueue(() => {
        const ps = pagesRef.current;
        const index = ps.findIndex((p) => p.id === pageId);
        if (index < 0 || ps.length < 2) return;
        if (pageId === activeRef.current) show(neighbourOf(ps, index)!);
        updatePages((all) => all.filter((p) => p.id !== pageId));
        URL.revokeObjectURL(ps[index].url);
        void api.dropCapture(pageId);
      }),
    [enqueue, show, updatePages],
  );
  const movePage = useCallback(
    (from: number, to: number) => enqueue(() => updatePages((ps) => moveItem(ps, from, to))),
    [enqueue, updatePages],
  );

  // A capture taken through "Add a capture" joins the others and is shown. Loaded in its turn, so a
  // send pressed meanwhile waits for it rather than going without it.
  useEffect(() => {
    const added = listen<CaptureAdded>("capture-added", (e) => {
      if (e.payload.editor !== id) return;
      void enqueue(() =>
        loadPage(e.payload.id).then(
          (page) => switchTo(page, true),
          (err) => flash(err instanceof Error ? err.message : String(err)),
        ),
      );
    });
    return () => void added.then((f) => f());
  }, [id, enqueue, switchTo, flash]);

  const working = send.kind === "sending" || send.kind === "sent";
  const canAdd = loaded && pages.length < MAX_PAGES && !working;
  const addCapture = useCallback(() => {
    if (!canAdd) return;
    canvasRef.current?.finishEditing();
    api.addCapture("region").catch((e) => flash(apiErrorText(e)));
  }, [canAdd, flash]);

  // The strip shows the page on show with its drawing, a moment after it changes.
  useEffect(() => {
    if (pages.length < 2 || !activeId) return;
    const timer = setTimeout(() => {
      const canvas = canvasRef.current?.exportCanvas();
      if (!canvas) return;
      const thumb = thumbnail(canvas);
      updatePages((ps) => ps.map((p) => (p.id === activeId ? { ...p, thumb } : p)));
    }, 500);
    return () => clearTimeout(timer);
  }, [doc, activeId, pages.length, updatePages]);

  /** Every page flattened, in order: the one on show as it is now, the others as they were left. */
  const exportAll = useCallback(async (): Promise<Uint8Array[]> => {
    let pngs: Promise<Uint8Array>[] = [];
    await enqueue(async () => {
      const current = await snapshotActive();
      if (current) updatePages((ps) => ps.map((p) => (p.id === current.id ? current : p)));
      pngs = pagesRef.current.map((p) => p.flat?.png ?? rawPng(p));
    });
    if (pngs.length === 0) throw new Error("Nothing to send");
    return Promise.all(pngs);
  }, [enqueue, snapshotActive, updatePages]);

  const close = useCallback(() => void getCurrentWindow().destroy(), []);
  const requestClose = useCallback(() => {
    if (dirty && send.kind !== "sent") setConfirmClose(true);
    else close();
  }, [dirty, send.kind, close]);

  // `postpone` puts it in the session's postponed messages instead of its prompt.
  const doSend = useCallback(
    async (key?: string, postpone = false) => {
      const s = items.find((i) => i.key === (key ?? target));
      if (!s || send.kind === "sending" || send.kind === "sent") return;
      setSend({ kind: "sending", postpone });
      try {
        const pngs = await exportAll();
        await api.sendCapture(pngs, s, message.trim(), postpone);
        setSend({ kind: "sent", postpone });
        setTimeout(close, 650);
      } catch (e) {
        setSend({ kind: "error", message: apiErrorText(e) });
        if ((e as ApiError)?.kind === "unauthorized") setSessions({ kind: "error", error: e as ApiError });
        else if ((e as ApiError)?.kind === "notFound") loadSessions();
      }
    },
    [items, target, send.kind, exportAll, message, close, loadSessions],
  );

  const doStart = useCallback(async () => {
    if (!newTarget.folder.trim() || send.kind === "sending" || send.kind === "sent") return;
    setSend({ kind: "sending", postpone: false });
    try {
      const pngs = await exportAll();
      const started = await api.startSession(pngs, newTarget, message.trim());
      setSend({ kind: "sent", postpone: false, started: started.name });
      if (started.note) flash(started.note);
      setTimeout(close, started.note ? 2500 : 900);
    } catch (e) {
      setSend({ kind: "error", message: apiErrorText(e) });
    }
  }, [newTarget, send.kind, exportAll, message, close, flash]);

  const copy = useCallback(async () => {
    try {
      const png = await exportPng();
      if (png) await api.copyImage(png);
      flash("Copied to the clipboard");
    } catch (e) {
      flash(apiErrorText(e));
    }
  }, [exportPng, flash]);

  const save = useCallback(async () => {
    try {
      const png = await exportPng();
      const path = png ? await api.saveImage(png) : null;
      if (path) flash(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      flash(apiErrorText(e));
    }
  }, [exportPng, flash]);

  const pickColor = (c: string) => {
    setColor(c);
    const s = doc.shapes.find((x) => x.id === selectedId);
    if (s) onCommit(replaceShape(doc, restyle(s, { color: c })));
  };
  const pickWeight = (w: Weight) => {
    setWeight(w);
    const s = doc.shapes.find((x) => x.id === selectedId);
    if (s) onCommit(replaceShape(doc, restyle(s, { width: WEIGHTS[w] * captureScale })));
  };

  // A send that failed for a reason the person can fix is retried by the next attempt, not stuck.
  useEffect(() => {
    if (send.kind === "error") setSend({ kind: "idle" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, message, creating, newTarget]);

  // ---- Closing ----
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((e) => {
      if (dirty && send.kind !== "sent") {
        e.preventDefault();
        setConfirmClose(true);
      }
    });
    return () => void unlisten.then((f) => f());
  }, [dirty, send.kind]);

  // ---- Keyboard ----
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const el = e.target as HTMLElement;
      const inField = el.tagName === "TEXTAREA" || el.tagName === "INPUT";
      const inSearch = el === searchRef.current;

      if (confirmClose) {
        if (e.key === "Escape") setConfirmClose(false);
        else if (e.key === "Enter") close();
        e.preventDefault();
        return;
      }
      if (mod && e.key === "Enter") {
        e.preventDefault();
        if (creating) void doStart();
        else void doSend(undefined, e.shiftKey);
        return;
      }
      // As do these: adding a capture, and stepping through them.
      if (mod && e.shiftKey && !e.altKey && e.code === "KeyN") {
        e.preventDefault();
        addCapture();
        return;
      }
      if (mod && !e.shiftKey && (e.key === "PageDown" || e.key === "PageUp")) {
        e.preventDefault();
        stepPage(e.key === "PageDown" ? 1 : -1);
        return;
      }
      // The zoom keys work from anywhere, the message box included: they mean nothing to a text field.
      if (mod && !e.altKey) {
        const k = e.code;
        if (k === "Equal" || k === "NumpadAdd" || k === "Minus" || k === "NumpadSubtract") {
          e.preventDefault();
          zoomStep(k === "Equal" || k === "NumpadAdd" ? 1 : -1);
          return;
        }
        if (k === "Digit0" || k === "Numpad0") {
          e.preventDefault();
          setView(FIT);
          return;
        }
        if (k === "Digit1" || k === "Numpad1") {
          e.preventDefault();
          actualSize();
          return;
        }
      }
      if ((inSearch || e.altKey) && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        setTarget((t) => stepSelection(items, t, e.key === "ArrowDown" ? 1 : -1));
        return;
      }
      if (inField) {
        if (e.key === "Escape") {
          e.preventDefault();
          if (inSearch && query) setQuery("");
          else el.blur();
        } else if (inSearch && e.key === "Enter") {
          e.preventDefault();
          messageRef.current?.focus();
        }
        return;
      }
      if (mod) {
        // By physical key, so the shortcuts work on any keyboard layout (see toolForKey).
        const k = e.code;
        if (k === "KeyZ") {
          e.preventDefault();
          setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
        } else if (k === "KeyY") {
          e.preventDefault();
          setHistory(redo);
        } else if (k === "KeyC") {
          e.preventDefault();
          void copy();
        } else if (k === "KeyS") {
          e.preventDefault();
          void save();
        }
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
        e.preventDefault();
        onCommit(removeShape(doc, selectedId));
        setSelectedId(null);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        if (selectedId) setSelectedId(null);
        else requestClose();
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // Out with the crop tool, Enter applies the crop being set; otherwise it is back to the message.
        if (tool === "crop" && doc.crop) onCommit(applyCrop(doc));
        else messageRef.current?.focus();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) setSpaceHeld(true);
        return;
      }
      if (e.key === "/" || e.code === "Slash") {
        e.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (!e.altKey && !e.shiftKey) {
        const t = toolForKey(e.code);
        if (t) setTool(t);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmClose, close, doSend, items, query, copy, save, selectedId, doc, tool, onCommit, requestClose, zoomStep, actualSize, addCapture, stepPage]);

  if (loadError) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">{loadError}</div>;
  }

  const out = image ? exportArea(doc, image.naturalWidth, image.naturalHeight) : null;

  return (
    <div className="flex h-full flex-col">
      <Toolbar
        tool={tool}
        onTool={setTool}
        color={color}
        onColor={pickColor}
        weight={weight}
        onWeight={pickWeight}
        canUndo={history.past.length > 0}
        canRedo={history.future.length > 0}
        onUndo={() => setHistory(undo)}
        onRedo={() => setHistory(redo)}
        crop={doc.crop ? "set" : image && isCropped(doc, image.naturalWidth, image.naturalHeight) ? "applied" : "none"}
        onApplyCrop={() => onCommit(applyCrop(doc))}
        onClearCrop={() =>
          onCommit(doc.crop ? { ...doc, crop: null } : image ? uncrop(doc, image.naturalWidth, image.naturalHeight, FIT_MARGIN * captureScale, measureText) : doc)
        }
        onCopy={() => void copy()}
        onSave={() => void save()}
        onAdd={addCapture}
        canAdd={canAdd}
        zoom={image ? percent(viewScale, dpr) : null}
        fitted={view.zoom === null}
        onZoom={zoomStep}
        onZoomToggle={() => (view.zoom === null ? actualSize() : setView(FIT))}
        mod={MOD}
      />
      {pages.length > 1 && (
        <PageStrip
          pages={pages}
          active={activeId}
          onSelect={(pageId) => void selectPage(pageId)}
          onRemove={(pageId) => void removePage(pageId)}
          onMove={(from, to) => void movePage(from, to)}
          onAdd={addCapture}
          canAdd={canAdd}
          mod={MOD}
        />
      )}
      <div
        ref={areaRef}
        className={clsx(
          "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas",
          // Important, over the cursor Konva sets on its canvas inline.
          spaceHeld && "cursor-grab [&_*]:cursor-grab!",
          "data-panning:cursor-grabbing! data-panning:[&_*]:cursor-grabbing!",
        )}
        onPointerDown={(e) => {
          // A press beside the picture still means "I'm drawing now, not typing".
          if (e.target === e.currentTarget) (document.activeElement as HTMLElement | null)?.blur();
        }}
      >
        {image && init && (
          <div
            className="shadow-[0_2px_16px_rgba(0,0,0,0.35)]"
            style={{ backgroundImage: CHECKER, backgroundSize: "16px 16px" }}
            onPointerDown={() => (document.activeElement as HTMLElement | null)?.blur()}
          >
            <Canvas
              // A page of its own: a drawing in progress or a text being typed stays with its picture.
              key={activeId}
              ref={canvasRef}
              image={image}
              viewScale={viewScale}
              viewport={viewport}
              dpr={dpr}
              captureScale={captureScale}
              doc={doc}
              tool={tool}
              color={color}
              strokeWidth={strokeWidth}
              selectedId={selectedId}
              onSelect={setSelectedId}
              onCommit={onCommit}
            />
          </div>
        )}
        {toast && (
          <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/80 px-3 py-1 text-[12px] text-white">
            {toast}
          </div>
        )}
        {confirmClose && (
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-panel px-4 py-2.5 shadow-xl">
            <span>Discard {pages.length > 1 ? `these ${pages.length} screenshots` : "this screenshot"}?</span>
            <button className="rounded-md border border-border px-2.5 py-1 hover:bg-muted" onClick={() => setConfirmClose(false)}>
              Keep editing <kbd>Esc</kbd>
            </button>
            <button className="rounded-md bg-danger px-2.5 py-1 text-white hover:brightness-110" onClick={close}>
              Discard <kbd className="border-white/30 bg-white/15 text-white">↵</kbd>
            </button>
          </div>
        )}
      </div>
      <Splitter
        axis="y"
        sign={-1}
        size={composerHeight}
        current={() => composerRef.current?.offsetHeight ?? composerHeight}
        min={COMPOSER_MIN}
        room={() => Math.max(0, (areaRef.current?.clientHeight ?? 0) - CANVAS_MIN)}
        reset={COMPOSER_HEIGHT}
        onSize={setComposerHeight}
        label="Resize the message area"
        // Over the composer's top border, not a strip of its own: the picture keeps its full height.
        className="z-10 -my-1 h-2"
      />
      <div
        ref={composerRef}
        style={{ height: composerHeight, minHeight: COMPOSER_MIN, maxHeight: `calc(100% - ${TOOLBAR_HEIGHT + CANVAS_MIN}px)` }}
        className="flex shrink-0 border-t border-border bg-panel p-3"
      >
        <div ref={messageColRef} className="flex min-w-0 flex-1 flex-col gap-2" style={{ minWidth: MESSAGE_MIN }}>
          <MessageBox ref={messageRef} value={message} onChange={setMessage} target={targetItem} creating={creating} mod={MOD} />
          <SendBar
            target={targetItem}
            creating={creating ? { folder: newTarget.folder } : null}
            send={send}
            onSend={() => void (creating ? doStart() : doSend())}
            onPostpone={() => void doSend(undefined, true)}
            mod={MOD}
            hint={
              out
                ? `${pages.length > 1 ? `${pages.length} pictures · this one ` : ""}${out.width} × ${out.height} PNG · ${isMac ? "⌥" : "Alt+"}↑↓ picks the session`
                : undefined
            }
          />
        </div>
        {/* In the gap between the message and the list, which is the handle's own width. */}
        <Splitter
          axis="x"
          sign={-1}
          size={pickerWidth}
          current={() => pickerRef.current?.offsetWidth ?? pickerWidth}
          min={PICKER_MIN}
          room={() => Math.max(0, (messageColRef.current?.offsetWidth ?? 0) - MESSAGE_MIN)}
          reset={PICKER_WIDTH}
          onSize={setPickerWidth}
          label="Resize the session list"
          className="w-3 self-stretch"
        />
        {creating ? (
          <NewSessionPanel
            width={pickerWidth}
            pickerRef={pickerRef}
            state={options}
            value={newTarget}
            onChange={setNewTarget}
            onBack={() => setCreating(false)}
            onRetry={loadOptions}
            onBrowse={() =>
              void api.pickFolder(newTarget.folder).then((f) => f && setNewTarget((t) => ({ ...t, folder: f })))
            }
            folderRef={folderRef}
          />
        ) : (
        <SessionPicker
          width={pickerWidth}
          pickerRef={pickerRef}
          state={sessions}
          items={items}
          query={query}
          onQuery={setQuery}
          selected={target}
          onSelect={setTarget}
          onSend={(sid) => {
            setTarget(sid);
            void doSend(sid);
          }}
          onRetry={loadSessions}
          onSettings={() => void api.openSettings()}
          onOpenHangar={() => void api.openHangar()}
          onNew={startCreating}
          searchRef={searchRef}
        />
        )}
      </div>
    </div>
  );
}

const CHECKER =
  "conic-gradient(rgba(127,127,127,0.22) 25%, transparent 0 50%, rgba(127,127,127,0.22) 0 75%, transparent 0)";
