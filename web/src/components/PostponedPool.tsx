import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Inbox,
  Loader2,
  Maximize2,
  Paperclip,
  Pause,
  PenLine,
  Play,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { attachError, insertPaths, placeCaret, uploadAttachments, useFileDrop } from "@/lib/attach";
import { DropCue } from "./DropCue";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ImageLightbox } from "./ImageLightbox";
import { ComposerDialog, type ComposerDraft } from "./ComposerDialog";
import { SlashSuggestions, SlashTextarea, useSlashInput } from "./SlashCommands";
import {
  loadPostponed,
  newMessage,
  registerPool,
  savePostponed,
  type PostponedImage,
  type PostponedMessage,
} from "@/lib/postponed";
import type { TerminalPaneHandle } from "./TerminalPane";
import { sessionKey, useApi, useNodeId } from "@/lib/node";
import { loadChatDraft, saveChatDraft } from "@/lib/chatDraft";

// Small delay between items in a "Send all" flush so Claude Code's TUI registers each as a distinct
// queued message rather than merging back-to-back submits.
const SEND_GAP_MS = 150;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseName = (p: string) => p.split(/[\\/]/).pop() || "image";

/**
 * What the full-size composer is working on: the inline draft (a new message), what is written in the
 * chat view's message box, or one already-stashed message being edited in place.
 */
type ComposerTarget = { kind: "draft" } | { kind: "chat" } | { kind: "message"; id: string };

/**
 * Per-session pool of "postponed" messages: buttons floating over the terminal's bottom-right corner,
 * with a drop-up holding the pool and a quick composer, where the user can
 * stash text and pasted images while Claude is busy, then send them into the live terminal on demand.
 * Nothing sends by itself unless auto-send is switched on (the play button): then the server types the
 * next message in each time Claude finishes a turn (PostponedAutoSender), and switches it back off once
 * the pool has run dry. With it off, an idle session just turns the pool button green as a nudge.
 */
export function PostponedPool({
  sessionId,
  busy,
  terminalRef,
  closed = false,
  serverCount,
  autoSend = false,
  slot = null,
}: {
  sessionId: string;
  // Whether Claude is currently working in this session (drives the "idle — send now" cue only).
  busy?: boolean;
  terminalRef: React.RefObject<TerminalPaneHandle | null>;
  // The session is closed: there is no terminal to send into, and there will not be one until it is
  // reopened. The pool still reads, stashes and discards — sending is what waits.
  closed?: boolean;
  // The pool's size as the server last reported it (on the session list). When it stops matching
  // ours, someone else changed the pool — auto-send taking a message, a schedule stashing one,
  // another device — and the list here is re-read rather than saved back over theirs.
  serverCount?: number;
  // Whether auto-send is on, as the server reports it.
  autoSend?: boolean;
  // Where the buttons go instead of the pane's corner: the chat view's message box, which has an image
  // button of its own, so the corner's is left out there. The drop-up opens above that box.
  slot?: HTMLElement | null;
}) {
  const api = useApi();
  const chatKey = sessionKey(useNodeId(), sessionId);
  const [messages, setMessages] = useState<PostponedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<PostponedImage[]>([]);
  const [open, setOpen] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  // Non-null while the full-size composer dialog is open: what it edits, plus its seed content.
  const [composer, setComposer] = useState<{ target: ComposerTarget; draft: ComposerDraft } | null>(null);
  // What the play button last asked for, until the server's report catches up — so the button answers
  // the click at once instead of a hub tick later. Null once the two agree.
  const [autoAsked, setAutoAsked] = useState<boolean | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // A stashed message is typed into Claude later, so a slash command in it runs then: suggest them here too.
  const slash = useSlashInput(sessionId, draft, setDraft, textareaRef);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Read by the re-sync effect below without making it re-run on every local edit.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const flushingRef = useRef(flushing);
  flushingRef.current = flushing;
  // Once the last message has gone into the terminal the drop-up has nothing left to show, so it
  // closes -- unless a new draft is half-written in it. Not on a discard: that is tidying up, and the
  // drop-up stays where the tidying is going on.
  const hasDraftRef = useRef(false);
  hasDraftRef.current = draft.trim().length > 0 || draftImages.length > 0;
  const closeIfSentDry = useCallback((remaining: number) => {
    if (remaining === 0 && !hasDraftRef.current) setOpen(false);
  }, []);
  // Bumped by every local change, so a re-read that was asked for before one lands as stale and is
  // dropped rather than undoing it.
  const generationRef = useRef(0);

  // Reload (from the server) and reset the composer when switching sessions — each session has its
  // own stash. `cancelled` guards against a slow load landing after another session switch.
  useEffect(() => {
    let cancelled = false;
    setMessages([]);
    setDraft("");
    setDraftImages([]);
    setComposer(null);
    setError(null);
    setAutoAsked(null);
    setOpen(false);
    loadPostponed(api, sessionId).then((m) => { if (!cancelled) setMessages(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  // The drop-up closes on a click anywhere else, or Escape — but not while the full-size composer or
  // an image preview is up over it: those are opened from the drop-up and should land back on it.
  useEffect(() => {
    if (!open || composer || preview) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, composer, preview]);

  // Re-read the pool when the server's count moves away from ours. Keyed on the count alone: our own
  // saves move it to where we already are, so only a change made elsewhere leaves the two apart. Not
  // mid-flush, whose own sends are still landing.
  useEffect(() => {
    if (serverCount === undefined || flushingRef.current) return;
    if (serverCount === messagesRef.current.length) return;
    let cancelled = false;
    const generation = generationRef.current;
    loadPostponed(api, sessionId)
      .then((m) => {
        if (cancelled || generation !== generationRef.current) return;
        // Emptied elsewhere: auto-send took the last one, or another device emptied the pool.
        if (messagesRef.current.length > 0) closeIfSentDry(m.length);
        setMessages(m);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverCount, sessionId, closeIfSentDry]);

  useEffect(() => {
    if (autoAsked !== null && autoAsked === autoSend) setAutoAsked(null);
  }, [autoAsked, autoSend]);
  const auto = autoAsked ?? autoSend;

  const toggleAuto = useCallback(async () => {
    const next = !auto;
    setAutoAsked(next);
    setError(null);
    try {
      await api.setPostponedAuto(sessionId, next);
    } catch {
      setAutoAsked(null);
      setError(next ? "Could not switch auto-send on." : "Could not switch auto-send off.");
    }
  }, [auto, sessionId]);

  // Grow the composer with its content, up to 3 lines (then it scrolls). Re-runs on every draft change
  // — including the reset to empty after a stash — so the box springs back down once sent.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    // scrollHeight leaves out the border, which a border-box height includes: without adding it back
    // the box comes out a hair short of one line and shows a scrollbar while empty.
    el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
  }, [draft, open]);

  // Persist (to the server) alongside every mutation rather than via an effect, so a session switch
  // can't race a save of the previous session's messages under the new session's id. The save is
  // fire-and-forget and captures the sessionId it was created for.
  const commit = useCallback(
    (next: PostponedMessage[]) => {
      generationRef.current++;
      setMessages(next);
      void savePostponed(api, sessionId, next);
    },
    [sessionId]
  );

  const stash = useCallback(() => {
    const text = draft.trim();
    // Not with an attachment still on its way: it would be left out, and land in the next draft.
    if ((!text && draftImages.length === 0) || uploading) return;
    commit([...messages, newMessage(text, draftImages)]);
    setDraft("");
    setDraftImages([]);
    setError(null);
  }, [draft, draftImages, messages, commit, uploading]);

  // The chat's message box stashes here too (Ctrl+Shift+Enter), through the list as it stands.
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(
    () =>
      registerPool(chatKey, (d) => {
        // Ahead of the render, so a second stash straight after the first adds to it.
        const next = [...messagesRef.current, newMessage(d.text, d.images)];
        messagesRef.current = next;
        commitRef.current(next);
        setError(null);
      }),
    [chatKey]
  );

  const deleteMsg = useCallback((id: string) => commit(messages.filter((m) => m.id !== id)), [messages, commit]);

  /** Open the full-size composer on the inline draft (a new message), carrying whatever is typed. */
  const openComposer = useCallback(() => {
    setComposer({ target: { kind: "draft" }, draft: { text: draft, images: draftImages } });
  }, [draft, draftImages]);

  /**
   * The corner's Compose. In the chat view it carries on what is written in the chat's message box, which
   * is where it sits; that stays in the box until the composer sends or postpones it.
   */
  const composeButton = useCallback(() => {
    const chat = slot ? loadChatDraft(chatKey) : null;
    if (chat && (chat.text.trim() || chat.images.length))
      setComposer({ target: { kind: "chat" }, draft: { text: chat.text, images: chat.images } });
    else openComposer();
  }, [slot, chatKey, openComposer]);

  /** Open the full-size composer on a stashed item, to rewrite or send it. */
  const editMsg = useCallback((msg: PostponedMessage) => {
    setComposer({ target: { kind: "message", id: msg.id }, draft: { text: msg.text, images: msg.images } });
  }, []);

  // Composer "Send": push straight into the terminal. On success drop whatever it was editing — the
  // stashed message, or the inline draft it was seeded from. Returning false leaves the dialog open.
  const composerSend = useCallback(
    async (d: ComposerDraft) => {
      const ok = await terminalRef.current?.sendMessage({
        text: d.text,
        imagePaths: d.images.map((i) => i.fullPath),
      });
      if (!ok) return false;
      if (composer?.target.kind === "message") {
        const id = composer.target.id;
        const rest = messages.filter((m) => m.id !== id);
        commit(rest);
        closeIfSentDry(rest.length);
      } else if (composer?.target.kind === "chat") {
        saveChatDraft(chatKey);
      } else {
        setDraft("");
        setDraftImages([]);
      }
      setError(null);
      return true;
    },
    [composer, messages, commit, terminalRef, closeIfSentDry, chatKey]
  );

  // Composer "Postpone"/"Save": stash a new message, or overwrite the one being edited in place (so it
  // keeps its position in the pool). The drop-up is left as it was: the count on the pool button
  // already shows the stash landed, and a drop-up springing open over the terminal is in the way.
  const composerPostpone = useCallback(
    (d: ComposerDraft) => {
      if (composer?.target.kind === "message") {
        const id = composer.target.id;
        // Gone while it was open (auto-send took it, or another device sent it): keep the rewrite as
        // a new message rather than drop it on the floor.
        commit(
          messages.some((m) => m.id === id)
            ? messages.map((m) => (m.id === id ? { ...m, text: d.text, images: d.images } : m))
            : [...messages, newMessage(d.text, d.images)]
        );
      } else {
        commit([...messages, newMessage(d.text, d.images)]);
        if (composer?.target.kind === "chat") saveChatDraft(chatKey);
        else {
          setDraft("");
          setDraftImages([]);
        }
      }
      setError(null);
    },
    [composer, messages, commit, chatKey]
  );

  const sendOne = useCallback(
    async (msg: PostponedMessage) => {
      const ok = await terminalRef.current?.sendMessage({
        text: msg.text,
        imagePaths: msg.images.map((i) => i.fullPath),
      });
      if (ok) {
        const rest = messages.filter((m) => m.id !== msg.id);
        commit(rest);
        closeIfSentDry(rest.length);
        setError(null);
      } else {
        setError("Terminal not connected — try again in a moment.");
      }
    },
    [messages, terminalRef, commit, closeIfSentDry]
  );

  const sendAll = useCallback(async () => {
    if (!messages.length || flushing) return;
    if (!terminalRef.current?.isReady()) {
      setError("Terminal not connected — try again in a moment.");
      return;
    }
    setFlushing(true);
    setError(null);
    const sent: string[] = [];
    for (const msg of messages) {
      const ok = await terminalRef.current?.sendMessage({
        text: msg.text,
        imagePaths: msg.images.map((i) => i.fullPath),
      });
      if (!ok) break;
      sent.push(msg.id);
      await delay(SEND_GAP_MS);
    }
    const rest = messages.filter((m) => !sent.includes(m.id));
    commit(rest);
    closeIfSentDry(rest.length);
    if (sent.length < messages.length) setError("Terminal disconnected mid-send — remaining messages kept.");
    setFlushing(false);
  }, [messages, flushing, terminalRef, commit, closeIfSentDry]);

  // Images go with the message; any other file is named in it, by path, where the caret is.
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      // What is attached joins the draft, which lives in the drop-up — open it, or the attach looks like
      // it did nothing (and an upload error would go unseen).
      setOpen(true);
      setUploading((n) => n + files.length);
      try {
        const got = await uploadAttachments(api, sessionId, files);
        if (got.images.length) setDraftImages((prev) => [...prev, ...got.images]);
        if (got.paths.length) {
          let caret = 0;
          setDraft((cur) => {
            const next = insertPaths(cur, textareaRef.current, got.paths);
            caret = next.caret;
            return next.text;
          });
          placeCaret(textareaRef.current, () => caret);
        }
        setError(attachError(got));
      } finally {
        setUploading((n) => n - files.length);
      }
    },
    [api, sessionId]
  );
  const drop = useFileDrop((files) => void addFiles(files));

  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // A screenshot, or files copied in a file manager; text falls through to the textarea.
      const files = Array.from(e.clipboardData?.files ?? []);
      if (!files.length) return;
      e.preventDefault();
      await addFiles(files);
    },
    [addFiles]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(e)) return;
    // Ctrl/Cmd+J inserts a newline at the cursor — a keyboard-only alternative to Shift+Enter (which
    // is awkward to reach on some mobile keyboards).
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "j") {
      e.preventDefault();
      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end } = el;
      setDraft((d) => d.slice(0, start) + "\n" + d.slice(end));
      // Drop the caret just after the inserted newline once React has repainted the new value.
      requestAnimationFrame(() => {
        el.selectionStart = el.selectionEnd = start + 1;
      });
      return;
    }
    // Enter stashes; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      stash();
    }
  };

  // The nudge to flush the stash, which only means anything while there is something to flush it
  // into: a closed session is not idle, it is gone, and painting Send all as the obvious next thing
  // to do would be inviting a click that cannot land.
  // Not while auto-send is on either: the server is about to send, and a green Send all would invite a
  // click that races it.
  const idle = !closed && !busy && !auto && messages.length > 0;
  const canStash = (draft.trim().length > 0 || draftImages.length > 0) && uploading === 0;

  const inline = !!slot;
  const body = (
    <>
    {/* Floats over the terminal's bottom-right corner instead of taking a bar's worth of height
        under it: the count, attach and Compose, with the pool itself in a drop-up above them. Both
        are placed against the pane (SessionView makes it relative), so the drop-up is sized to the
        pane and stays inside a narrow split rather than spilling out of it and being clipped.
        right-5 keeps them off xterm's scrollbar; z-10 for the same reason as the terminal's own
        corner controls — xterm's link canvas sits at z-index 2. `contents` keeps this wrapper out of
        the layout while it still holds both for the outside-click check and the paste guard. */}
    <div ref={rootRef} data-owns-image-paste className="contents">
      {/* The picker behind the corner's attach button. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = ""; // allow re-picking the same file
        }}
      />

      {open && (
        // Files dropped anywhere on it are attached to the draft.
        <div
          {...drop.dropProps}
          className={cn(
            "absolute z-10 rounded-lg border bg-background p-2 shadow-lg",
            inline
              ? "bottom-full right-0 mb-2 w-[min(32rem,100%)]"
              : "bottom-10 right-5 w-[min(32rem,calc(100%-2.5rem))]"
          )}
        >
          {/* Wraps: in a narrow split the buttons drop to a line of their own rather than spill out. */}
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
            <span className="text-sm font-medium text-muted-foreground">Postponed</span>
            {idle && (
              // Not on a phone, where it wraps the header: the green count button says it already.
              <span className="hidden whitespace-nowrap text-xs font-medium text-emerald-600 sm:inline dark:text-emerald-500">
                Claude is idle
              </span>
            )}
            {auto && !closed && (
              <span className="whitespace-nowrap text-xs font-medium text-emerald-600 dark:text-emerald-500">
                {messages.length > 0 ? "Auto-sending" : "Sending the last one"}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {/* Not offered at all in a closed session: there is no terminal to send into, and a
                  greyed button cannot say why — a disabled one takes no pointer events, so the title
                  that would have explained it never shows. What the pool still does — read, stash,
                  discard — is all still here, and the panel above says where the terminal went. */}
              {/* Auto-send. Offered while there is something to queue, and kept while it is on so it
                  can be paused even after the last message has gone in. Absent in a closed session,
                  like Send all: a reopen is a new session, with a pool of its own. */}
              {(messages.length > 0 || auto) && !closed && (
                <Button
                  size="sm"
                  variant={auto ? "default" : "outline"}
                  onClick={() => void toggleAuto()}
                  aria-pressed={auto}
                  className={cn("h-8 px-2.5", auto && "bg-emerald-600 text-white hover:bg-emerald-600/90")}
                  title={
                    auto
                      ? "Auto-send is on: each time Claude finishes, the next message goes in. Click to pause."
                      : "Auto-send: each time Claude finishes, send the next message — one at a time, in order"
                  }
                  aria-label={auto ? "Pause auto-send" : "Start auto-send"}
                >
                  {auto ? <Pause className="size-4" /> : <Play className="size-4" />}
                  Auto
                </Button>
              )}
              {/* Hidden while auto-send is on: the server is sending these, and a click here could
                  race it into sending one twice. Pause to send by hand. */}
              {messages.length > 0 && !closed && !auto && (
                <Button
                  size="sm"
                  variant={idle ? "default" : "outline"}
                  onClick={() => sendAll()}
                  disabled={flushing}
                  className={cn("h-8 px-2.5", idle && "bg-emerald-600 text-white hover:bg-emerald-600/90")}
                  title="Send every stashed message into the terminal, in order"
                >
                  <Send className="size-4" />
                  Send all
                </Button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close postponed messages"
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            </div>
          </div>

          {/* Stashed items */}
          {messages.length > 0 ? (
            <div className="mb-2 max-h-[40vh] space-y-1.5 overflow-auto">
              {messages.map((m) => (
                <div
                  key={m.id}
                  className="flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm"
                >
                  {m.images.map((img, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() =>
                        setPreview({ src: api.sessionFileUrl(sessionId, img.path), name: baseName(img.path) })
                      }
                      className="shrink-0"
                      title="Preview image"
                    >
                      <img
                        src={api.sessionFileUrl(sessionId, img.path)}
                        alt=""
                        className="size-9 cursor-zoom-in rounded border object-cover"
                        onError={(e) => {
                          e.currentTarget.style.display = "none";
                        }}
                      />
                    </button>
                  ))}
                  {/* Click the body to pull the message back into the composer for editing. */}
                  <button
                    type="button"
                    onClick={() => editMsg(m)}
                    title="Click to edit in the full-size composer"
                    className="min-w-0 flex-1 cursor-pointer self-center rounded text-left hover:text-foreground"
                  >
                    {m.text ? (
                      <p className="line-clamp-3 whitespace-pre-wrap break-words">{m.text}</p>
                    ) : (
                      <p className="italic text-muted-foreground">
                        {m.images.length} image{m.images.length === 1 ? "" : "s"}
                      </p>
                    )}
                  </button>
                  <div className="flex shrink-0 items-center self-center text-muted-foreground">
                    {/* Same as Send all above: absent in a closed session, and while auto-send is on. */}
                    {!closed && !auto && (
                      <button
                        type="button"
                        onClick={() => sendOne(m)}
                        title="Send this message now"
                        className="rounded p-1 hover:bg-accent hover:text-foreground"
                      >
                        <Send className="size-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteMsg(m.id)}
                      title="Discard"
                      className="rounded p-1 hover:bg-accent hover:text-destructive"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mb-2 px-1 text-xs text-muted-foreground">Nothing postponed yet.</p>
          )}

          {/* Quick stash */}
          {draftImages.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {draftImages.map((img, i) => (
                <div key={i} className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setPreview({ src: api.sessionFileUrl(sessionId, img.path), name: baseName(img.path) })
                    }
                    title="Preview image"
                  >
                    <img
                      src={api.sessionFileUrl(sessionId, img.path)}
                      alt=""
                      className="size-12 cursor-zoom-in rounded border object-cover"
                      onError={(e) => {
                        e.currentTarget.style.display = "none";
                      }}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => setDraftImages((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove image"
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-background text-muted-foreground shadow hover:text-destructive"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          {/* relative: the slash-command suggestions open above the box, as wide as this row. */}
          <div className="relative flex items-end gap-2">
            <SlashSuggestions slash={slash} />
            <SlashTextarea
              slash={slash}
              // min-w-0 flex-1: the Textarea's own w-full would otherwise set a flex base of 100%
              // and, on a narrow screen, soak up the row by shrinking the buttons next to it.
              wrapperClassName="min-w-0 flex-1"
              ref={textareaRef}
              value={draft}
              {...slash.inputProps}
              onChange={(e) => {
                setDraft(e.target.value);
                slash.track(e.target);
              }}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Postpone a message — Enter to stash"
              title="Enter to stash, Shift+Enter or Ctrl+J for a newline; paste an image to attach it"
              className="max-h-20 min-h-10 resize-none py-2.5 leading-5"
            />
            {/* Desktop-only: on a phone it would eat the width the message needs, and Compose sits
                right below in the corner anyway. */}
            <Button
              variant="outline"
              size="icon"
              className="hidden shrink-0 sm:inline-flex sm:size-9"
              onClick={openComposer}
              title="Expand into the full-size composer"
              aria-label="Expand into the full-size composer"
            >
              <Maximize2 className="size-4" />
            </Button>
            <Button
              className="h-10 shrink-0 sm:h-9"
              onClick={stash}
              disabled={!canStash}
              title="Add to the postponed pool"
            >
              Stash
            </Button>
          </div>
          {uploading > 0 && (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Uploading…
            </p>
          )}
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
          {drop.over && <DropCue className="rounded-lg" />}
        </div>
      )}

      {/* The buttons take dropped files for the draft too. In the chat they sit in its message box, but
          are not its: a file dropped on them is for a postponed message. */}
      <div
        className={inline ? "flex shrink-0 items-center" : "absolute bottom-1 right-5 z-10 flex items-center gap-1"}
        {...drop.dropProps}
      >
        {/* The pool's toggle: its count, green when Claude is idle and there is something to send
            (the nudge the old bar gave), and a dot for a draft left unstashed in the drop-up. */}
        <Button
          size="sm"
          variant={inline ? "ghost" : "outline"}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className={cn(
            "relative gap-1 px-2",
            inline ? "h-7 [&_svg]:size-4" : "h-7 bg-background/90 shadow-md backdrop-blur [&_svg]:size-3.5",
            idle && "border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-600/90 hover:text-white",
            auto && !closed && "border-emerald-600 text-emerald-600 dark:text-emerald-500"
          )}
          title={
            idle
              ? "Claude is idle — postponed messages are waiting"
              : auto && !closed
                ? "Postponed messages — auto-sending"
                : "Postponed messages"
          }
          aria-label={`Postponed messages (${messages.length})`}
        >
          {auto && !closed ? <Play /> : <Inbox />}
          {messages.length > 0 && <span className="tabular-nums">{messages.length}</span>}
          {!open && canStash && (
            <span className="absolute -right-1 -top-1 size-2.5 rounded-full border-2 border-background bg-primary" />
          )}
        </Button>
        {!inline && (
          <Button
            size="sm"
            variant="outline"
            className="size-7 bg-background/90 px-0 shadow-md backdrop-blur [&_svg]:size-3.5"
            onClick={() => fileInputRef.current?.click()}
            title="Attach images or files to a postponed message (or drop them here)"
            aria-label="Attach images or files"
          >
            <Paperclip />
          </Button>
        )}
        <Button
          size="sm"
          variant={inline ? "ghost" : "outline"}
          className={cn(
            "px-0",
            inline ? "size-7 [&_svg]:size-4" : "size-7 bg-background/90 shadow-md backdrop-blur [&_svg]:size-3.5"
          )}
          onClick={composeButton}
          title="Write a message in a full-size window — send it now or postpone it"
          aria-label="Compose a message"
        >
          <PenLine />
        </Button>
      </div>
    </div>
    </>
  );

  return (
    <>
    {slot ? createPortal(body, slot) : body}
    <ComposerDialog
      sessionId={sessionId}
      open={!!composer}
      initial={composer?.draft}
      editing={composer?.target.kind === "message"}
      closed={closed}
      onSend={composerSend}
      onPostpone={composerPostpone}
      onClose={() => setComposer(null)}
    />
    {preview && (
      <ImageLightbox src={preview.src} name={preview.name} onClose={() => setPreview(null)} />
    )}
    </>
  );
}
