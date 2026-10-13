import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api, apiErrorText, type ApiError, type EditorInit } from "@/lib/tauri";
import { Canvas, type CanvasHandle } from "./Canvas";
import { MessageBox, SendBar, SessionPicker, type SendState, type SessionsState } from "./Composer";
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
  commit,
  emptyHistory,
  exportArea,
  redo,
  removeShape,
  restyle,
  replaceShape,
  toolForKey,
  undo,
  type Doc,
  type Tool,
  type Weight,
} from "./model";
import { filterSessions, keepSelection, stepSelection } from "./sessions";

const isMac = navigator.userAgent.includes("Mac");
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
  const [init, setInit] = useState<EditorInit | null>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
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
  const [send, setSend] = useState<SendState>({ kind: "idle" });
  const [confirmClose, setConfirmClose] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const messageRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const [area, setArea] = useState({ width: 0, height: 0 });
  // The composer's height and the session list's width, dragged by the two splitters and kept for
  // the next capture. CSS holds each to what fits the window, so a size kept from a bigger one can't
  // squeeze the picture or the message box away.
  const savedLayout = useMemo(loadLayout, []);
  const [composerHeight, setComposerHeight] = useState(savedLayout.composer);
  const [pickerWidth, setPickerWidth] = useState(savedLayout.picker);
  const composerRef = useRef<HTMLDivElement>(null);
  const messageColRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const doc = history.present;
  const captureScale = init?.scale ?? 1;
  const strokeWidth = WEIGHTS[weight] * captureScale;
  const dirty = history.past.length > 0 || message.trim().length > 0;

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
    let url: string | null = null;
    const load = () => {
      if (loading) return;
      loading = true;
      Promise.all([api.editorInit(id), api.capturePng(id)]).then(
        ([info, png]) => {
          if (cancelled) return;
          // The tool, colour and weight as the last editor left them — this page may have been loaded
          // long before that one closed.
          const latest = loadPrefs();
          setTool(latest.tool);
          setColor(latest.color);
          setWeight(latest.weight);
          setInit(info);
        // A blob: URL is this page's own origin, so the canvas it's drawn into can still be exported.
        url = URL.createObjectURL(new Blob([png], { type: "image/png" }));
        const img = new Image();
          img.onload = () => {
            if (cancelled) return;
            setImage(img);
            void getCurrentWindow().setTitle(`Homeport Snap — ${info.width} × ${info.height}`);
            void api.editorReady().then(() => messageRef.current?.focus());
          };
          img.onerror = () => setLoadError("Could not load the capture.");
          img.src = url!;
        },
        (e) => {
          loading = false;
          if (String(e) !== "pending") setLoadError(String(e));
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
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);

  useEffect(() => saveLayout({ composer: composerHeight, picker: pickerWidth }), [composerHeight, pickerWidth]);

  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setArea({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the picture to the window, never past its real size (one capture pixel per device pixel).
  const viewScale = useMemo(() => {
    if (!image || area.width === 0) return 1;
    const pad = 32;
    const fit = Math.min((area.width - pad) / image.naturalWidth, (area.height - pad) / image.naturalHeight);
    return Math.max(0.05, Math.min(fit, 1 / (window.devicePixelRatio || 1)));
  }, [image, area]);

  // ---- Sessions ----
  const loadSessions = useCallback(() => {
    setSessions((s) => (s.kind === "ready" ? s : { kind: "loading" }));
    api.listSessions().then(
      (view) => setSessions({ kind: "ready", items: view.items }),
      (e: ApiError | string) => setSessions({ kind: "error", error: e }),
    );
  }, []);
  useEffect(() => {
    if (!init) return; // a spare editor, still waiting for its capture, has no one to send to yet
    loadSessions();
    const onFocus = () => loadSessions();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(loadSessions, 15_000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [init, loadSessions]);

  const allItems = useMemo(() => (sessions.kind === "ready" ? sessions.items : []), [sessions]);
  const items = useMemo(() => filterSessions(allItems, query), [allItems, query]);
  useEffect(() => setTarget((t) => keepSelection(items, t)), [items]);
  const targetItem = items.find((s) => s.id === target) ?? null;

  // ---- Actions ----
  const onCommit = useCallback((next: Doc) => setHistory((h) => commit(h, next)), []);

  const exportPng = useCallback(async (): Promise<Uint8Array | null> => {
    canvasRef.current?.finishEditing();
    setSelectedId(null);
    await settle();
    const canvas = canvasRef.current?.exportCanvas();
    return canvas ? toPng(canvas) : null;
  }, []);

  const flash = (text: string) => {
    setToast(text);
    setTimeout(() => setToast((t) => (t === text ? null : t)), 1800);
  };

  const close = useCallback(() => void getCurrentWindow().destroy(), []);
  const requestClose = useCallback(() => {
    if (dirty && send.kind !== "sent") setConfirmClose(true);
    else close();
  }, [dirty, send.kind, close]);

  // `postpone` puts it in the session's postponed messages instead of its prompt.
  const doSend = useCallback(
    async (sessionId?: string, postpone = false) => {
      const s = items.find((i) => i.id === (sessionId ?? target));
      if (!s || send.kind === "sending" || send.kind === "sent") return;
      setSend({ kind: "sending", postpone });
      try {
        const png = await exportPng();
        if (!png) throw new Error("Nothing to send");
        await api.sendCapture(png, s, message.trim(), postpone);
        setSend({ kind: "sent", postpone });
        setTimeout(close, 650);
      } catch (e) {
        setSend({ kind: "error", message: apiErrorText(e) });
        if ((e as ApiError)?.kind === "unauthorized") setSessions({ kind: "error", error: e as ApiError });
        else if ((e as ApiError)?.kind === "notFound") loadSessions();
      }
    },
    [items, target, send.kind, exportPng, message, close, loadSessions],
  );

  const copy = useCallback(async () => {
    try {
      const png = await exportPng();
      if (png) await api.copyImage(png);
      flash("Copied to the clipboard");
    } catch (e) {
      flash(apiErrorText(e));
    }
  }, [exportPng]);

  const save = useCallback(async () => {
    try {
      const png = await exportPng();
      const path = png ? await api.saveImage(png) : null;
      if (path) flash(`Saved ${path.split(/[\\/]/).pop()}`);
    } catch (e) {
      flash(apiErrorText(e));
    }
  }, [exportPng]);

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
  }, [target, message]);

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
        void doSend(undefined, e.shiftKey);
        return;
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
        messageRef.current?.focus();
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
  }, [confirmClose, close, doSend, items, query, copy, save, selectedId, doc, onCommit, requestClose]);

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
        hasCrop={!!doc.crop}
        onClearCrop={() => onCommit({ ...doc, crop: null })}
        onCopy={() => void copy()}
        onSave={() => void save()}
        mod={MOD}
      />
      <div
        ref={areaRef}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-canvas"
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
              ref={canvasRef}
              image={image}
              viewScale={viewScale}
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
            <span>Discard this screenshot?</span>
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
          <MessageBox ref={messageRef} value={message} onChange={setMessage} target={targetItem} mod={MOD} />
          <SendBar
            target={targetItem}
            send={send}
            onSend={() => void doSend()}
            onPostpone={() => void doSend(undefined, true)}
            mod={MOD}
            hint={out ? `${out.width} × ${out.height} PNG · ${isMac ? "⌥" : "Alt+"}↑↓ picks the session` : undefined}
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
          onOpenHomeport={() => void api.openHomeport()}
          searchRef={searchRef}
        />
      </div>
    </div>
  );
}

const CHECKER =
  "conic-gradient(rgba(127,127,127,0.22) 25%, transparent 0 50%, rgba(127,127,127,0.22) 0 75%, transparent 0)";
