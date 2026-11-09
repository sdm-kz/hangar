import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  Circle,
  Clock,
  ImageIcon,
  ImagePlus,
  Inbox,
  Loader2,
  Search,
  Send,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./Markdown";
import { ChatQuestion, parseQuestions } from "./ChatQuestion";
import { ChatPlan, parsePlan } from "./ChatPlan";
import { usePersistentZoom, ZoomControls, ZOOM_LEVELS } from "./ZoomControls";
import { SlashSuggestions, SlashTextarea, useSlashInput } from "./SlashCommands";
import { ImageLightbox } from "./ImageLightbox";
import { useChatFind } from "./ChatFind";
import { CopyButton } from "./CopyPathButton";
import type { Activity } from "./ActivityMark";
import type { TerminalPaneHandle } from "./TerminalPane";
import {
  applyChunk,
  chatItems,
  EMPTY_TRANSCRIPT,
  prettyInput,
  queuedMessages,
  toolSummary,
  type ChatImageRef,
  type ChatItem,
  type ChatTranscript,
} from "@/lib/chat";
import { uploadImageFile } from "@/lib/upload";
import type { PostponedImage } from "@/lib/postponed";
import type { ChatEntry, SessionStatus } from "@/types";
import { sessionKey, useApi, useNodeId } from "@/lib/node";
import { loadChatDraft, onChatDraft, saveChatDraft } from "@/lib/chatDraft";
import { postponeTo } from "@/lib/postponed";
import { cn } from "@/lib/utils";

// How often the transcript is read: often while Claude is writing to it, rarely while it sits idle, and
// hardly at all from a tab nobody is looking at.
const POLL_ACTIVE_MS = 1000;
const POLL_IDLE_MS = 4000;
const POLL_HIDDEN_MS = 15000;
// Items drawn at first, and how many more each "show earlier" adds. A long session is thousands of them.
const PAGE = 150;
// Within this many pixels of the bottom counts as reading the latest, which new items keep in view.
const STICK_PX = 80;

// Between the keys that answer a question or a plan: each one redraws Claude's dialog before it takes the next.
const QUESTION_KEY_GAP_MS = 150;

// The find key: ⌘F on a Mac, where Ctrl+F moves the caret in the message box; Ctrl+F elsewhere.
const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);

// Ctrl-wheel travel per zoom step, as in the terminal: a mouse notch steps at once, a pinch ramps.
const WHEEL_ZOOM_STEP = 40;

const baseName = (p: string) => p.split(/[\\/]/).pop() || "image";

// A copy button that shows while the pointer is over what it copies (each place names that its group),
// and always on a touch screen, which has no hover. Icon-only, and not selectable, so a selection dragged
// across the chat — and find, which reads the chat's text — never takes it in.
const COPY_BUTTON =
  "grid size-6 shrink-0 select-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100";

/**
 * The session's terminal, read as a chat. Claude's TUI keeps running in the terminal underneath: this
 * view reads the transcript Claude writes as it goes (GET /api/sessions/{id}/chat) and types into the
 * terminal the way you would, so the two are always the same conversation and switching between them
 * loses nothing. What only the terminal can do — a picker, a dialog with more than yes and no — is
 * one click away.
 */
export function ChatView({
  sessionId,
  conversation: reported,
  closed,
  busy,
  activity,
  activityLabel,
  terminalRef,
  onShowTerminal,
  poolSlot,
}: {
  sessionId: string;
  /** The conversation the session last reported running: a new one (a /clear) is read at once. */
  conversation?: string | null;
  /** No live terminal: the conversation can be read, not added to. */
  closed: boolean;
  busy: boolean;
  activity?: Activity | null;
  activityLabel?: string;
  terminalRef: RefObject<TerminalPaneHandle | null>;
  onShowTerminal: () => void;
  /** Called with the place in the message box where the session's postponed-message buttons go. */
  poolSlot?: (el: HTMLElement | null) => void;
}) {
  const api = useApi();
  const [transcript, setTranscript] = useState<ChatTranscript>(EMPTY_TRANSCRIPT);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  // The chat's own zoom, like the terminal's: one reading size for every session's chat, kept across
  // reloads, and apart from the terminal's — the two are set for different text.
  const [zoom, setZoom] = usePersistentZoom("chat");
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);

  // ---- Reading the transcript ----
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;
  const closedRef = useRef(closed);
  closedRef.current = closed;
  const activeRef = useRef(busy);
  activeRef.current = busy || activity === "waiting";
  const pokeRef = useRef<() => void>(() => {});
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let inFlight = false;
    // Start from nothing: what was read for another session must not be continued for this one.
    transcriptRef.current = EMPTY_TRANSCRIPT;
    setTranscript(EMPTY_TRANSCRIPT);
    setLoaded(false);
    setFailed(false);
    setStatus(null);
    const tick = async () => {
      window.clearTimeout(timer);
      if (inFlight) return;
      inFlight = true;
      let ok = false;
      try {
        const t = transcriptRef.current;
        const chunk = await api.getSessionChat(sessionId, t.conversation, t.offset);
        if (stopped) return;
        setTranscript((cur) => (transcriptRef.current = applyChunk(cur, chunk)));
        // Only when it changed: a new object every poll would redraw the whole chat every second.
        setStatus((cur) => (sameStatus(cur, chunk.status ?? null) ? cur : (chunk.status ?? null)));
        setLoaded(true);
        setFailed(false);
        ok = true;
      } catch {
        // A read that fails (the node dropped, the file was busy, a node too old to have this) is retried
        // on the next tick; until one works, the view says so rather than spinning.
        if (!stopped) setFailed(true);
      } finally {
        inFlight = false;
      }
      // A closed session's conversation is done: one read is all there is.
      if (stopped || (closedRef.current && ok)) return;
      const wait = document.hidden ? POLL_HIDDEN_MS : activeRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS;
      timer = window.setTimeout(tick, wait);
    };
    pokeRef.current = () => void tick();
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      pokeRef.current = () => {};
    };
  }, [api, sessionId]);

  // A change of state is the moment something new was written: a turn ended, a tool started, a dialog
  // came up. Read then rather than waiting out the idle interval.
  // So is a new conversation: a /clear changes nothing else the session reports, and the chat would go
  // on showing the one it left until the next idle read.
  useEffect(() => {
    pokeRef.current();
  }, [busy, activity, reported]);

  const items = useMemo(() => chatItems(transcript.entries), [transcript.entries]);
  // A closed session's queue went with it: nothing in it is coming.
  const queued = useMemo(() => (closed ? [] : queuedMessages(transcript.entries)), [closed, transcript.entries]);
  const queuedKeys = useMemo(() => queued.map((q) => q.key), [queued]);
  const info = useMemo(() => sessionInfo(status, transcript.entries), [status, transcript.entries]);
  const shown = items.length > limit ? items.slice(items.length - limit) : items;
  const hidden = items.length - shown.length;
  const conversation = transcript.conversation;
  const images = useMemo<ChatImageSource>(
    () => ({
      url: (image) =>
        conversation && image.at != null && image.n != null
          ? api.chatImageUrl(sessionId, conversation, { uuid: image.uuid, at: image.at, n: image.n })
          : null,
      open: (src, name) => setPreview({ src, name }),
    }),
    [api, sessionId, conversation]
  );

  // ---- Scrolling: follow new items while reading the latest, stay put while reading back ----
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    setShowJump(!atBottom.current);
  };
  const toBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setShowJump(false);
  }, []);
  useLayoutEffect(() => {
    if (atBottom.current) toBottom();
  }, [items, queued, busy, activity, toBottom]);
  // Rendered Markdown and images settle after layout; keep the bottom in view while they do.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
    });
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const showEarlier = () => {
    const el = scrollRef.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    setLimit((l) => l + PAGE);
    // Keep what was at the top of the view where it was, rather than jumping to the new top.
    requestAnimationFrame(() => {
      if (el) el.scrollTop = el.scrollHeight - before;
    });
  };

  // ---- Find: Ctrl/⌘+F and the button in the corner ----
  const itemCount = items.length;
  const revealItem = useCallback(
    // In whole pages, as "show earlier" draws them, so its count stays in step.
    (i: number) => setLimit((l) => Math.max(l, Math.ceil((itemCount - i) / PAGE) * PAGE)),
    [itemCount]
  );
  const find = useChatFind({
    items,
    extraKeys: queuedKeys,
    shownFrom: hidden,
    contentRef,
    scrollRef,
    revealItem,
    onScrolled: onScroll,
  });

  // ---- Zoom: the buttons, Ctrl/⌘ with + - 0, and Ctrl/⌘-wheel, the keys the terminal answers to ----
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const stepZoom = useCallback(
    (delta: number) => {
      const i = ZOOM_LEVELS.indexOf(zoomRef.current) + delta;
      setZoom(ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i))]);
    },
    [setZoom]
  );
  // Only while the chat has focus — the browser's own zoom, which takes the whole app with it, is what
  // these keys do anywhere else. Its find, too.
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Only from the conversation itself: in the message box, the postponed pool or a picture opened full
    // size, Esc is theirs.
    if (e.key === "Escape" && find.open && !e.defaultPrevented && !preview && scrollRef.current?.contains(e.target as Node)) {
      e.preventDefault();
      find.close();
      return;
    }
    if (e.altKey || !(e.ctrlKey || e.metaKey)) return;
    if (!e.shiftKey && (MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey) && (e.key.toLowerCase() === "f" || e.code === "KeyF")) {
      e.preventDefault();
      find.start();
      return;
    }
    const delta =
      e.key === "+" || e.key === "=" || e.code === "Equal" || e.code === "NumpadAdd"
        ? 1
        : e.key === "-" || e.key === "_" || e.code === "Minus" || e.code === "NumpadSubtract"
          ? -1
          : 0;
    const reset = e.key === "0" || e.code === "Digit0" || e.code === "Numpad0";
    if (!delta && !reset) return;
    e.preventDefault();
    if (reset) setZoom(1);
    else stepZoom(delta);
  };
  // React's wheel handler is passive, and a passive one can't stop the browser zooming the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let travel = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      travel += e.deltaY;
      const steps = Math.trunc(travel / WHEEL_ZOOM_STEP);
      if (steps === 0) return;
      travel -= steps * WHEEL_ZOOM_STEP;
      stepZoom(-steps);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [stepZoom]);

  const waiting = activity === "waiting";
  // A question Claude is waiting on: the newest thing in the conversation is its AskUserQuestion, with no
  // answer yet. Read off the transcript, so it doesn't need the hooks' "waiting" to be seen.
  const last = items[items.length - 1];
  const questionKey =
    !closed && last?.kind === "tool" && last.name === "AskUserQuestion" && !last.result && parseQuestions(last.input)
      ? last.key
      : null;
  // The same for a plan waiting on approval: its ExitPlanMode, unanswered.
  const planKey =
    !closed && last?.kind === "tool" && last.name === "ExitPlanMode" && !last.result && parsePlan(last.input)
      ? last.key
      : null;
  const readScreen = useCallback(() => terminalRef.current?.screenLines() ?? [], [terminalRef]);
  const answerQuestion = async (keys: string[]) => {
    for (const k of keys) {
      if (!terminalRef.current?.sendKeys(k)) return false;
      await new Promise((r) => window.setTimeout(r, QUESTION_KEY_GAP_MS));
    }
    window.setTimeout(() => pokeRef.current(), 300);
    return true;
  };
  const keys = (data: string) => {
    if (!terminalRef.current?.sendKeys(data)) return;
    window.setTimeout(() => pokeRef.current(), 300);
  };

  return (
    <div
      data-owns-image-paste
      onKeyDown={onKeyDown}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <div className="group relative min-h-0 flex-1">
        {/* Focusable, so a click in the conversation keeps the keyboard in the chat — and Ctrl+F with it. */}
        <div
          ref={scrollRef}
          tabIndex={-1}
          onScroll={onScroll}
          className="h-full overflow-y-auto overscroll-contain outline-none"
        >
          {/* CSS zoom rather than a font size: it scales the cards, code and spacing with the text, and
              takes part in layout, so the scroll height and the stick-to-bottom stay right. */}
          <div ref={contentRef} style={{ zoom }} className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
            {hidden > 0 ? (
              <button
                type="button"
                className="self-center rounded-full border px-3 py-1 text-xs text-muted-foreground hover:bg-muted"
                onClick={showEarlier}
              >
                Show earlier ({hidden})
              </button>
            ) : (
              transcript.truncated && (
                <p className="self-center text-xs text-muted-foreground">
                  The start of this long conversation isn't loaded here. The terminal has all of it.
                </p>
              )
            )}
            {!loaded ? (
              <p className="flex items-center gap-2 self-center py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {failed ? "Couldn't read the conversation. Trying again…" : "Reading the conversation…"}
              </p>
            ) : items.length === 0 && queued.length === 0 ? (
              <p className="self-center py-8 text-center text-sm text-muted-foreground">
                {transcript.conversation
                  ? "Nothing said yet."
                  : closed
                    ? "This session left no conversation to show."
                    : "Nothing said yet. Write below, or in the terminal."}
              </p>
            ) : (
              // Each in a box of its own, with nothing of its own to lay out, for find to know it by.
              shown.map((item) => (
                <div key={item.key} data-find-key={item.key} className="contents">
                  {item.kind === "tool" && item.name === "AskUserQuestion" && parseQuestions(item.input) ? (
                    <ChatQuestion
                      input={item.input}
                      result={item.result}
                      pending={item.key === questionKey}
                      onAnswer={answerQuestion}
                      onShowTerminal={onShowTerminal}
                    />
                  ) : item.kind === "tool" && item.name === "ExitPlanMode" && parsePlan(item.input) ? (
                    <ChatPlan
                      callId={item.id}
                      input={item.input}
                      result={item.result}
                      pending={item.key === planKey}
                      readScreen={readScreen}
                      onAnswer={answerQuestion}
                      onShowTerminal={onShowTerminal}
                    />
                  ) : (
                    <ChatRow item={item} sessionBusy={busy} images={images} />
                  )}
                </div>
              ))
            )}
            {loaded &&
              queued.map((q) => (
                <div key={q.key} data-find-key={q.key} className="flex flex-col items-end gap-1">
                  <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-dashed px-3.5 py-2 text-sm text-muted-foreground">
                    {q.text}
                  </div>
                  <span data-find-skip className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Clock className="size-3" /> Queued — Claude reads it as soon as it can
                  </span>
                </div>
              ))}
          </div>
        </div>
        {/* In the corner, like the terminal's. Shown on hover, and pinned open once zoomed, since a size
            that isn't the default should say so and offer the way back. The find bar opens beside it, and
            under it where the two don't fit side by side. */}
        <div className="pointer-events-none absolute left-4 right-4 top-3 z-10 flex flex-wrap-reverse items-start justify-end gap-1.5 [&>*]:pointer-events-auto">
          {find.bar}
          <ZoomControls
            zoom={zoom}
            onChange={setZoom}
            leading={
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title={`Find in the chat (${MAC ? "⌘F" : "Ctrl+F"})`}
                aria-pressed={find.open}
                onClick={find.open ? find.close : find.start}
              >
                <Search className="size-4" />
              </Button>
            }
            className={cn(
              "relative mr-0 transition-opacity",
              zoom === 1 &&
                !find.open &&
                "opacity-0 focus-within:opacity-100 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
            )}
          />
        </div>
        {showJump && (
          <button
            type="button"
            title="Jump to the latest"
            onClick={toBottom}
            className="absolute bottom-3 right-4 grid size-9 place-items-center rounded-full border bg-background shadow-md hover:bg-muted"
          >
            <ArrowDown className="size-5" />
          </button>
        )}
      </div>

      {/* A question and a plan have their own cards in the conversation; the bar is for everything else
          Claude waits on. */}
      {!closed && waiting && !questionKey && !planKey && (
        <WaitingBar label={activityLabel} onKeys={keys} onShowTerminal={onShowTerminal} />
      )}
      {!closed && busy && !waiting && (
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2 px-4 pb-1 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          <span className="min-w-0 flex-1 truncate">{activityLabel || "Claude is working…"}</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5" title="Stop (Esc)" onClick={() => keys("\x1b")}>
            <Square className="size-3.5" /> Stop
          </Button>
        </div>
      )}
      {closed ? (
        // The postponed pool still reads and discards in a closed session, so its buttons stay.
        <div className="border-t px-4 py-2">
          <div className="relative mx-auto flex w-full max-w-3xl items-center gap-2">
            <p className="min-w-0 flex-1 py-1 text-center text-sm text-muted-foreground">
              The session is closed. Reopen it to carry on the conversation.
            </p>
            <div ref={poolSlot} className="contents" />
          </div>
        </div>
      ) : (
        <Composer
          sessionId={sessionId}
          terminalRef={terminalRef}
          blocked={waiting || !!questionKey || !!planKey}
          busy={busy}
          onSent={() => pokeRef.current()}
          onShowTerminal={onShowTerminal}
          poolSlot={poolSlot}
          info={info}
        />
      )}
      {/* On the page itself: the panes it could open in are positioned, and would hold it to their box. */}
      {preview &&
        createPortal(
          <ImageLightbox src={preview.src} name={preview.name} onClose={() => setPreview(null)} />,
          document.body
        )}
    </div>
  );
}

/**
 * Claude is stopped on a question in the terminal. A tool permission has two answers worth a button —
 * the first choice is always "Yes", and Esc is always "No" — so those are typed for you. Anything
 * else (a plan or a question the chat couldn't read) is answered in the terminal.
 */
function WaitingBar({
  label,
  onKeys,
  onShowTerminal,
}: {
  label?: string;
  onKeys: (data: string) => void;
  onShowTerminal: () => void;
}) {
  const permission = !!label?.startsWith("Wants to run ") && !/^Wants to run (AskUserQuestion|ExitPlanMode)\b/.test(label);
  return (
    <div className="mx-auto mb-2 w-full max-w-3xl px-4">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
        <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="min-w-0 flex-1 break-words text-sm">{label || "Claude is waiting for you"}</span>
        <div className="flex shrink-0 gap-1.5">
          {permission && (
            <>
              <Button size="sm" className="h-7" onClick={() => onKeys("1")}>
                Allow
              </Button>
              <Button size="sm" variant="outline" className="h-7" onClick={() => onKeys("\x1b")}>
                Deny
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" className="h-7 gap-1.5" onClick={onShowTerminal}>
            <TerminalSquare className="size-3.5" /> {permission ? "Terminal" : "Answer in terminal"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Where the chat's images come from, and what a click on one does. */
interface ChatImageSource {
  /** The image's URL, or null when its node didn't say where it is. */
  url: (image: ChatImageRef) => string | null;
  open: (src: string, name: string) => void;
}

function ChatRow({ item, sessionBusy, images }: { item: ChatItem; sessionBusy: boolean; images: ChatImageSource }) {
  switch (item.kind) {
    case "user":
      return (
        // The button to the bubble's left, in the room its 85% leaves, clear of the text.
        <div className="group/msg flex items-end justify-end gap-1">
          {item.text && (
            <CopyButton text={item.text} title="Copy message" className={cn(COPY_BUTTON, "group-hover/msg:opacity-100")} />
          )}
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-muted px-3.5 py-2 text-sm">
            {item.text}
            {item.images.length > 0 && (
              <ChatImages images={item.images} source={images} name="Image" className={item.text ? "mt-2" : undefined} />
            )}
            {item.queued && (
              <span data-find-skip className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
                <Clock className="size-3" /> Sent while Claude was working
              </span>
            )}
          </div>
        </div>
      );
    case "command":
      return (
        <div className="flex justify-end">
          <code className="max-w-[85%] truncate rounded-md bg-muted px-2 py-1 font-mono text-xs">{item.text}</code>
        </div>
      );
    case "output":
      return (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 px-3 py-2 font-mono text-xs text-muted-foreground">
          {item.text}
        </pre>
      );
    case "notice":
      return (
        <div
          className={cn(
            "flex items-center gap-3 text-xs",
            item.tone === "error" ? "text-destructive" : "text-muted-foreground"
          )}
        >
          <span className="h-px flex-1 bg-border" />
          <span className="max-w-[80%] text-center">{item.text}</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      );
    case "summary":
      return (
        <Fold title="Summary of the earlier conversation" className="text-muted-foreground">
          <div className="whitespace-pre-wrap break-words text-xs">{item.text}</div>
        </Fold>
      );
    case "assistant":
      return (
        // The button in the space under the reply's last paragraph, which ends in a margin of its own.
        <div className="group/msg relative">
          <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground">
            <Markdown text={item.text} copyCode />
          </div>
          <CopyButton
            text={item.text}
            title="Copy reply (Markdown)"
            className={cn(COPY_BUTTON, "absolute -bottom-2 right-0 group-hover/msg:opacity-100")}
          />
        </div>
      );
    case "thinking":
      return (
        <Fold title="Thinking" className="text-muted-foreground">
          <div className="whitespace-pre-wrap break-words text-xs italic">{item.text}</div>
        </Fold>
      );
    case "tool":
      return <ToolCard item={item} sessionBusy={sessionBusy} images={images} />;
  }
}

/**
 * Thumbnails of a message's images, each opening full size. They are fetched as they come into view, at a
 * fixed height so the conversation doesn't shift as they arrive.
 */
function ChatImages({
  images,
  source,
  name,
  className,
}: {
  images: ChatImageRef[];
  source: ChatImageSource;
  /** What the viewer calls them: numbered when there are several. */
  name: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {images.map((image, i) => {
        const label = images.length > 1 ? `${name} ${i + 1}` : name;
        const src = source.url(image);
        return src ? (
          <ChatThumb key={i} src={src} label={label} onOpen={() => source.open(src, label)} />
        ) : (
          <ImagePlaceholder key={i} label={label} />
        );
      })}
    </div>
  );
}

function ChatThumb({ src, label, onOpen }: { src: string; label: string; onOpen: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ImagePlaceholder label={label} />;
  return (
    <button type="button" title={`Open ${label.toLowerCase()}`} onClick={onOpen} className="rounded-md">
      <img
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        className="h-28 w-auto max-w-[14rem] cursor-zoom-in rounded-md border bg-background object-cover"
        onError={() => setFailed(true)}
      />
    </button>
  );
}

// An image that can't be shown — its node is too old to say where it is, or it is gone from the transcript.
function ImagePlaceholder({ label }: { label: string }) {
  return (
    <span
      title={label}
      className="flex h-28 w-20 items-center justify-center rounded-md border border-dashed text-muted-foreground"
    >
      <ImageIcon className="size-5" />
    </span>
  );
}

function ToolCard({
  item,
  sessionBusy,
  images,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  sessionBusy: boolean;
  images: ChatImageSource;
}) {
  const summary = toolSummary(item.input);
  const result = item.result;
  // A picture's result is the picture: the "[image]" its text stands in with says nothing more.
  const resultText = result?.images.length ? result.text.replace(/^\[image\]$/gm, "").trim() : result?.text;
  // No result yet: still running while the session works, otherwise it never finished (interrupted).
  const icon = result ? (
    result.isError ? (
      <X className="size-3.5 text-destructive" />
    ) : (
      <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
    )
  ) : sessionBusy ? (
    <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
  ) : (
    <Circle className="size-3.5 text-muted-foreground" />
  );
  return (
    <details className="group rounded-md border bg-muted/30 text-xs">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        {icon}
        <span className="shrink-0 font-medium">{item.name}</span>
        {summary && <span className="min-w-0 truncate font-mono text-muted-foreground">{summary}</span>}
      </summary>
      <div className="flex flex-col gap-2 border-t px-2.5 py-2">
        {item.input && (
          <ToolText copy={() => prettyInput(item.input)} title="Copy input">
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words pr-7 font-mono">{prettyInput(item.input)}</pre>
          </ToolText>
        )}
        {result && (resultText || !result.images.length) && (
          <ToolText copy={resultText || null} title="Copy output" divided>
            <pre
              className={cn(
                "max-h-72 overflow-auto whitespace-pre-wrap break-words pr-7 font-mono",
                result.isError ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {resultText || "(no output)"}
            </pre>
          </ToolText>
        )}
        {result && result.images.length > 0 && (
          <ChatImages
            images={result.images}
            source={images}
            name={summary ? baseName(summary) : "Image"}
            className="border-t pt-2"
          />
        )}
      </div>
    </details>
  );
}

/**
 * A tool's input or its output, with a button in the top right corner that copies it. The button is out of
 * the <pre>, which scrolls, so it stays put; the <pre> leaves room for it on the right.
 */
function ToolText({
  copy,
  title,
  divided,
  children,
}: {
  /** The text to copy; null when there is nothing worth it ("(no output)"). */
  copy: string | (() => string) | null;
  title: string;
  /** A rule above it, between the input and the output. */
  divided?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={cn("group/io relative", divided && "border-t pt-2")}>
      {children}
      {copy && (
        <CopyButton
          text={copy}
          title={title}
          className={cn(COPY_BUTTON, "absolute right-0 bg-background/80 group-hover/io:opacity-100", divided ? "top-2" : "top-0")}
        />
      )}
    </div>
  );
}

function Fold({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return (
    <details className={cn("group text-xs", className)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
        {title}
      </summary>
      <div className="mt-1.5 border-l-2 pl-3">{children}</div>
    </details>
  );
}

/**
 * Where a message is written. It goes into the terminal the way typing it there would — a bracketed paste
 * and an Enter — so a message sent while Claude is busy queues behind the turn, as it does in the TUI:
 * the chat shows it as queued until Claude takes it, between two steps of the turn or after it.
 */
function Composer({
  sessionId,
  terminalRef,
  blocked,
  busy,
  onSent,
  onShowTerminal,
  poolSlot,
  info,
}: {
  sessionId: string;
  terminalRef: RefObject<TerminalPaneHandle | null>;
  /**
   * Claude is stopped on a question in the terminal. Whatever is sent now lands in that dialog, not the
   * conversation — and its Enter picks the highlighted answer, which is "Yes" — so nothing is sent until
   * it has been answered. Writing goes on; the message waits.
   */
  blocked: boolean;
  /** Claude is mid-turn: what is sent now waits for it. */
  busy: boolean;
  onSent: () => void;
  /** A command that answers in the terminal was sent: show the terminal. */
  onShowTerminal: () => void;
  poolSlot?: (el: HTMLElement | null) => void;
  info: SessionLine;
}) {
  const api = useApi();
  // What was written here and not sent is kept per session, so a switch to another session and back
  // finds it where it was.
  const draftKey = sessionKey(useNodeId(), sessionId);
  const [text, setText] = useState(() => loadChatDraft(draftKey).text);
  const [images, setImages] = useState<PostponedImage[]>(() => loadChatDraft(draftKey).images);
  useEffect(() => saveChatDraft(draftKey, { text, images }), [draftKey, text, images]);
  // Taken from here by the full-size composer, and sent or postponed from there.
  useEffect(
    () =>
      onChatDraft(draftKey, (d) => {
        setText(d.text);
        setImages(d.images);
      }),
    [draftKey]
  );
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashInput(sessionId, text, setText, areaRef);
  // Enter sends at a keyboard; on a phone it is the only way to start a new line, so the button sends.
  const coarse = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches ?? false, []);

  // A draft brought back is carried on from its end, not typed in front of.
  useEffect(() => {
    const el = areaRef.current;
    if (el) el.selectionStart = el.selectionEnd = el.value.length;
  }, []);

  // Grow with what is written, up to a third of the window; past that it scrolls.
  useLayoutEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, [text]);

  const addFiles = async (files: File[]) => {
    const pics = files.filter((f) => f.type.startsWith("image/"));
    if (!pics.length) return;
    setUploading((n) => n + pics.length);
    for (const f of pics) {
      try {
        const up = await uploadImageFile(api, sessionId, f);
        setImages((cur) => [...cur, { path: up.path, fullPath: up.fullPath }]);
      } catch {
        setError("An image didn't upload.");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const send = async () => {
    const body = text.trim();
    if ((!body && !images.length) || sending || uploading || blocked) return;
    const term = terminalRef.current;
    if (!term?.isReady()) {
      setError("The terminal isn't connected yet. Try again in a moment.");
      return;
    }
    setSending(true);
    setError(null);
    const ok = await term.sendMessage({ text: body, imagePaths: images.map((i) => i.fullPath) });
    setSending(false);
    if (!ok) {
      setError("The terminal disconnected before the message went. It is still here to send again.");
      return;
    }
    setText("");
    setImages([]);
    onSent();
    // A bare /model, /config, /context… answers in the terminal; the chat would show nothing.
    const bare = body.match(/^\/(\S+)$/);
    if (bare && slash.commands?.find((c) => c.name === bare[1])?.dialog) onShowTerminal();
  };

  // Ctrl+Shift+Enter puts the message in the session's postponed pool instead, as it does in the full-size
  // composer. Nothing goes into the terminal, so a question Claude is waiting on doesn't stop it.
  const postpone = () => {
    const body = text.trim();
    if ((!body && !images.length) || sending || uploading) return;
    if (!postponeTo(draftKey, { text: body, images })) {
      setError("The postponed pool isn't here to take it. Try again in a moment.");
      return;
    }
    setText("");
    setImages([]);
    setError(null);
  };
  // Held, the chord turns the send button into Postpone, so the shortcut shows what it will do.
  const postponing = usePostponeChord();

  const hasContent = !!text.trim() || images.length > 0;
  const canSend = hasContent && !sending && uploading === 0 && !blocked;
  const canPostpone = hasContent && !sending && uploading === 0;
  return (
    <div className="border-t bg-background px-4 pb-1.5 pt-2">
      {/* relative: the postponed pool's drop-up opens above the message box, against its right edge. */}
      <div className="relative mx-auto w-full max-w-3xl">
        <SlashSuggestions slash={slash} />
        {error && <p className="mb-1.5 text-xs text-destructive">{error}</p>}
        {(images.length > 0 || uploading > 0) && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {images.map((img) => (
              <span key={img.fullPath} className="flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 text-xs">
                <ImageIcon className="size-3.5" />
                <span className="max-w-[10rem] truncate">{baseName(img.path)}</span>
                <button
                  type="button"
                  title="Remove"
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => setImages((cur) => cur.filter((x) => x !== img))}
                >
                  <X className="size-3.5" />
                </button>
              </span>
            ))}
            {uploading > 0 && (
              <span className="flex items-center gap-1 px-1 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Uploading…
              </span>
            )}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-xl border bg-background px-1.5 py-1 focus-within:ring-1 focus-within:ring-ring">
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            title="Attach an image"
            onClick={() => fileRef.current?.click()}
          >
            <ImagePlus className="size-4" />
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              void addFiles(Array.from(e.target.files ?? []));
              e.target.value = "";
            }}
          />
          <SlashTextarea
            slash={slash}
            wrapperClassName="min-w-0 flex-1"
            ref={areaRef}
            rows={1}
            // The terminal under the chat keeps the keyboard otherwise, and what is typed goes into a
            // screen nobody can see. Not on a phone, where focus pops the keyboard up over the chat.
            autoFocus={!coarse}
            value={text}
            placeholder={
              blocked
                ? "Answer Claude's question first"
                : busy
                  ? "Claude is working. A message sent now waits for it"
                  : "Message Claude, or / for commands"
            }
            data-chat-composer
            {...slash.inputProps}
            className="min-h-7 resize-none border-0 px-1 py-1 leading-5 shadow-none focus-visible:ring-0"
            onChange={(e) => {
              setText(e.target.value);
              slash.track(e.target);
              if (error) setError(null);
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (repeatTyped(e)) return;
              if (slash.onKeyDown(e)) return;
              if (e.key === "Enter" && e.shiftKey && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                postpone();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !coarse) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {/* The postponed pool's buttons, which float in the terminal's corner, sit here in the chat. */}
          <div ref={poolSlot} className="contents" />
          {postponing ? (
            <Button
              size="icon"
              className="size-7 shrink-0"
              title="Postpone (Ctrl+Shift+Enter)"
              aria-label="Postpone"
              disabled={!canPostpone}
              onClick={postpone}
            >
              <Inbox className="size-4" />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-7 shrink-0"
              title={
                blocked
                  ? "Answer Claude's question first"
                  : `${busy ? "Queue for Claude" : "Send"} (Enter). Ctrl+Shift+Enter postpones it`
              }
              disabled={!canSend}
              onClick={() => void send()}
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          )}
        </div>
        <SessionFooter info={info} />
      </div>
    </div>
  );
}

/** Whether Ctrl (⌘ on a Mac) and Shift are held together: the postpone chord, short of its Enter. */
function usePostponeChord(): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const update = (e: KeyboardEvent | PointerEvent) => setHeld((e.ctrlKey || e.metaKey) && e.shiftKey);
    // Let go while the window was away (Alt-Tab with the keys down): its keyup never comes.
    const reset = () => setHeld(false);
    // Capture: a box that stops its keys (the slash list, a dialog) must not leave the button stuck. A
    // pointer move says which keys are down too, and catches a keyup that went missing.
    window.addEventListener("keydown", update, true);
    window.addEventListener("keyup", update, true);
    window.addEventListener("pointermove", update, true);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update, true);
      window.removeEventListener("keyup", update, true);
      window.removeEventListener("pointermove", update, true);
      window.removeEventListener("blur", reset);
    };
  }, []);
  return held;
}

function sameStatus(a: SessionStatus | null, b: SessionStatus | null): boolean {
  return a === b || (!!a && !!b && a.model === b.model && a.contextPercent === b.contextPercent && a.contextWindow === b.contextWindow);
}

interface SessionLine {
  model: string | null;
  /** Share of the context window in use, when Claude has said (its status line). */
  percent: number | null;
  window: number | null;
  /** Tokens in context, from the transcript: what is known when the percentage isn't. */
  tokens: number | null;
}

/**
 * The model and context use under the message box. Claude's status line is the source — only it knows the
 * window's size. A session started before Hangar gave it one (or whose user has a status line of their own)
 * has only the transcript, which names the model and counts the tokens but can't say what they are out of.
 */
function sessionInfo(status: SessionStatus | null, entries: ChatEntry[]): SessionLine {
  let model: string | null = null;
  let tokens: number | null = null;
  for (let i = entries.length - 1; i >= 0 && (model === null || tokens === null); i--) {
    const e = entries[i];
    // "<synthetic>" is what Claude files its own error notes under: not a model that answered.
    if (e.kind !== "assistant" || !e.model || e.model === "<synthetic>") continue;
    model ??= e.model;
    if (e.context) tokens ??= e.context;
  }
  return {
    model: status?.model || (model && modelName(model)),
    percent: status?.contextPercent ?? null,
    window: status?.contextWindow ?? null,
    tokens,
  };
}

/** claude-opus-5-5 → Opus 5.5, claude-haiku-4-5-20251001 → Haiku 4.5; anything else as it is. */
function modelName(id: string): string {
  // The minor version is one or two digits on their own: claude-opus-4-20250514 is Opus 4, not 4.20.
  const m = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}`;
}

const kTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1000)}k`);

function SessionFooter({ info }: { info: SessionLine }) {
  if (!info.model && info.percent === null && info.tokens === null) return <div className="h-4" />;
  const pct = info.percent;
  const tone = pct === null ? "" : pct >= 90 ? "text-destructive" : pct >= 75 ? "text-amber-600 dark:text-amber-400" : "";
  const bar = pct === null ? "" : pct >= 90 ? "bg-destructive" : pct >= 75 ? "bg-amber-500" : "bg-muted-foreground/60";
  return (
    <div className="flex h-4 items-center gap-3 px-1 pt-1 text-[11px] leading-none text-muted-foreground">
      {info.model && <span title="The model answering in this session">{info.model}</span>}
      {pct !== null ? (
        <span
          className={cn("flex items-center gap-1.5", tone)}
          title={`Context window ${Math.round(pct)}% used${info.window ? ` of ${kTokens(info.window)} tokens` : ""}`}
        >
          <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
            <span className={cn("block h-full rounded-full", bar)} style={{ width: `${Math.max(2, pct)}%` }} />
          </span>
          {Math.round(pct)}% context
        </span>
      ) : (
        info.tokens !== null && (
          <span title="Tokens in the context window. The percentage comes from Hangar's status line, which a session gets when Hangar starts it — unless you have a status line of your own.">
            {kTokens(info.tokens)} tokens in context
          </span>
        )
      )}
    </div>
  );
}

/**
 * A held key that repeats, as it does in the terminal. On macOS a held letter opens the accent picker
 * (ł ļ ľ) instead, and only the first press is typed: the picker lives in the system's text input, which
 * each repeat goes through. Typing the repeats in here keeps them from getting there — xterm does the same
 * with every key, which is why the terminal never shows the picker. Returns whether it took the key.
 */
function repeatTyped(e: React.KeyboardEvent<HTMLTextAreaElement>): boolean {
  if (!e.repeat || e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return false;
  e.preventDefault();
  // execCommand keeps it on the undo stack and fires the input event React's onChange listens for.
  if (!document.execCommand("insertText", false, e.key)) {
    const el = e.currentTarget;
    el.setRangeText(e.key, el.selectionStart, el.selectionEnd, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  return true;
}

