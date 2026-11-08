import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  AlertTriangle,
  ArrowDown,
  Check,
  ChevronRight,
  Circle,
  ImageIcon,
  ImagePlus,
  Loader2,
  Send,
  Square,
  TerminalSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Markdown } from "./Markdown";
import type { Activity } from "./ActivityMark";
import type { TerminalPaneHandle } from "./TerminalPane";
import { applyChunk, chatItems, EMPTY_TRANSCRIPT, prettyInput, toolSummary, type ChatItem, type ChatTranscript } from "@/lib/chat";
import { uploadImageFile } from "@/lib/upload";
import type { PostponedImage } from "@/lib/postponed";
import { useApi } from "@/lib/node";
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

const baseName = (p: string) => p.split(/[\\/]/).pop() || "image";

/**
 * The session's terminal, read as a chat. Claude's TUI keeps running in the terminal underneath: this
 * view reads the transcript Claude writes as it goes (GET /api/sessions/{id}/chat) and types into the
 * terminal the way you would, so the two are always the same conversation and switching between them
 * loses nothing. What only the terminal can do — a picker, a dialog with more than yes and no — is
 * one click away.
 */
export function ChatView({
  sessionId,
  closed,
  busy,
  activity,
  activityLabel,
  terminalRef,
  onShowTerminal,
}: {
  sessionId: string;
  /** No live terminal: the conversation can be read, not added to. */
  closed: boolean;
  busy: boolean;
  activity?: Activity | null;
  activityLabel?: string;
  terminalRef: RefObject<TerminalPaneHandle | null>;
  onShowTerminal: () => void;
}) {
  const api = useApi();
  const [transcript, setTranscript] = useState<ChatTranscript>(EMPTY_TRANSCRIPT);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);

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
  useEffect(() => {
    pokeRef.current();
  }, [busy, activity]);

  const items = useMemo(() => chatItems(transcript.entries), [transcript.entries]);
  const shown = items.length > limit ? items.slice(items.length - limit) : items;
  const hidden = items.length - shown.length;

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
  }, [items, busy, activity, toBottom]);
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

  const waiting = activity === "waiting";
  const keys = (data: string) => {
    if (!terminalRef.current?.sendKeys(data)) return;
    window.setTimeout(() => pokeRef.current(), 300);
  };

  return (
    <div data-owns-image-paste className="@container flex h-full min-h-0 flex-col bg-background">
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full overflow-y-auto overscroll-contain">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
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
            ) : items.length === 0 ? (
              <p className="self-center py-8 text-center text-sm text-muted-foreground">
                {transcript.conversation
                  ? "Nothing said yet."
                  : closed
                    ? "This session left no conversation to show."
                    : "Nothing said yet. Write below, or in the terminal."}
              </p>
            ) : (
              shown.map((item) => <ChatRow key={item.key} item={item} sessionBusy={busy} />)
            )}
          </div>
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

      {!closed && waiting && (
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
        <p className="border-t px-4 py-3 text-center text-sm text-muted-foreground">
          The session is closed. Reopen it to carry on the conversation.
        </p>
      ) : (
        <Composer
          sessionId={sessionId}
          terminalRef={terminalRef}
          blocked={waiting}
          onSent={() => pokeRef.current()}
        />
      )}
    </div>
  );
}

/**
 * Claude is stopped on a question in the terminal. A tool permission has two answers worth a button —
 * the first choice is always "Yes", and Esc is always "No" — so those are typed for you. Anything
 * else (a plan to approve, a question with options of its own) is answered in the terminal.
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

function ChatRow({ item, sessionBusy }: { item: ChatItem; sessionBusy: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm bg-primary/10 px-3.5 py-2 text-sm">
            {item.text}
            {item.images > 0 && (
              <span className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                <ImageIcon className="size-3.5" /> {item.images === 1 ? "1 image" : `${item.images} images`}
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
        <div className="prose prose-sm max-w-none break-words dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground">
          <Markdown text={item.text} />
        </div>
      );
    case "thinking":
      return (
        <Fold title="Thinking" className="text-muted-foreground">
          <div className="whitespace-pre-wrap break-words text-xs italic">{item.text}</div>
        </Fold>
      );
    case "tool":
      return <ToolCard item={item} sessionBusy={sessionBusy} />;
  }
}

function ToolCard({ item, sessionBusy }: { item: Extract<ChatItem, { kind: "tool" }>; sessionBusy: boolean }) {
  const summary = toolSummary(item.input);
  const result = item.result;
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
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words font-mono">{prettyInput(item.input)}</pre>
        )}
        {result && (
          <pre
            className={cn(
              "max-h-72 overflow-auto whitespace-pre-wrap break-words border-t pt-2 font-mono",
              result.isError ? "text-destructive" : "text-muted-foreground"
            )}
          >
            {result.text || "(no output)"}
          </pre>
        )}
      </div>
    </details>
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
 * and an Enter — so a message sent while Claude is busy queues behind the turn, as it does in the TUI.
 */
function Composer({
  sessionId,
  terminalRef,
  blocked,
  onSent,
}: {
  sessionId: string;
  terminalRef: RefObject<TerminalPaneHandle | null>;
  /**
   * Claude is stopped on a question in the terminal. Whatever is sent now lands in that dialog, not the
   * conversation — and its Enter picks the highlighted answer, which is "Yes" — so nothing is sent until
   * it has been answered. Writing goes on; the message waits.
   */
  blocked: boolean;
  onSent: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState("");
  const [images, setImages] = useState<PostponedImage[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  // Enter sends at a keyboard; on a phone it is the only way to start a new line, so the button sends.
  const coarse = useMemo(() => window.matchMedia?.("(pointer: coarse)").matches ?? false, []);

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
  };

  const canSend = (!!text.trim() || images.length > 0) && !sending && uploading === 0 && !blocked;
  return (
    // The postponed pool's buttons float in the pane's bottom-right corner, over this bar. Where the pane
    // is too narrow for the composer to sit clear of them, it leaves their room free instead.
    <div className="border-t bg-background pb-3 pl-4 pr-28 pt-2 @[64rem]:pr-4">
      <div className="mx-auto w-full max-w-3xl">
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
        <div className="flex items-end gap-2 rounded-xl border bg-background px-2 py-1.5 focus-within:ring-1 focus-within:ring-ring">
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0"
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
          <Textarea
            ref={areaRef}
            rows={1}
            // The terminal under the chat keeps the keyboard otherwise, and what is typed goes into a
            // screen nobody can see. Not on a phone, where focus pops the keyboard up over the chat.
            autoFocus={!coarse}
            value={text}
            placeholder={blocked ? "Answer Claude's question first" : "Message Claude"}
            data-chat-composer
            className="min-h-8 flex-1 resize-none border-0 px-1 py-1.5 shadow-none focus-visible:ring-0"
            onChange={(e) => {
              setText(e.target.value);
              if (error) setError(null);
            }}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData.files ?? []).filter((f) => f.type.startsWith("image/"));
              if (!files.length) return;
              e.preventDefault();
              void addFiles(files);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !coarse && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <Button
            size="icon"
            className="size-8 shrink-0"
            title={blocked ? "Answer Claude's question first" : "Send"}
            disabled={!canSend} onClick={() => void send()}>
            {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
