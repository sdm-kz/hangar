import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Inbox,
  Maximize2,
  Pause,
  PenLine,
  Play,
  Send,
  Trash2,
  X,
} from "lucide-react";
import { api, sessionFileUrl } from "@/lib/api";
import { uploadImageFile } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImageLightbox } from "./ImageLightbox";
import { ComposerDialog, type ComposerDraft } from "./ComposerDialog";
import {
  loadPostponed,
  newMessage,
  savePostponed,
  type PostponedImage,
  type PostponedMessage,
} from "@/lib/postponed";
import type { TerminalPaneHandle } from "./TerminalPane";

// Small delay between items in a "Send all" flush so Claude Code's TUI registers each as a distinct
// queued message rather than merging back-to-back submits.
const SEND_GAP_MS = 150;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const baseName = (p: string) => p.split(/[\\/]/).pop() || "image";

/**
 * What the full-size composer is working on: the inline draft (a new message), or one already-stashed
 * message being edited in place.
 */
type ComposerTarget = { kind: "draft" } | { kind: "message"; id: string };

/**
 * Per-session pool of "postponed" messages: a composer pinned under the terminal where the user can
 * stash text and pasted images while Claude is busy, then send them into the live terminal on demand.
 * Nothing sends by itself unless auto-send is switched on (the play button): then the server types the
 * next message in each time Claude finishes a turn (PostponedAutoSender), and switches it back off once
 * the pool has run dry. With it off, an idle session just highlights the bar as a nudge.
 */
export function PostponedPool({
  sessionId,
  busy,
  terminalRef,
  closed = false,
  serverCount,
  autoSend = false,
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
}) {
  const [messages, setMessages] = useState<PostponedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<PostponedImage[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  // Non-null while the full-size composer dialog is open: what it edits, plus its seed content.
  const [composer, setComposer] = useState<{ target: ComposerTarget; draft: ComposerDraft } | null>(null);
  // What the play button last asked for, until the server's report catches up — so the button answers
  // the click at once instead of a hub tick later. Null once the two agree.
  const [autoAsked, setAutoAsked] = useState<boolean | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Read by the re-sync effect below without making it re-run on every local edit.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const flushingRef = useRef(flushing);
  flushingRef.current = flushing;
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
    loadPostponed(sessionId).then((m) => { if (!cancelled) setMessages(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  // Re-read the pool when the server's count moves away from ours. Keyed on the count alone: our own
  // saves move it to where we already are, so only a change made elsewhere leaves the two apart. Not
  // mid-flush, whose own sends are still landing.
  useEffect(() => {
    if (serverCount === undefined || flushingRef.current) return;
    if (serverCount === messagesRef.current.length) return;
    let cancelled = false;
    const generation = generationRef.current;
    loadPostponed(sessionId)
      .then((m) => { if (!cancelled && generation === generationRef.current) setMessages(m); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [serverCount, sessionId]);

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
    el.style.height = `${el.scrollHeight}px`;
  }, [draft, expanded]);

  // Persist (to the server) alongside every mutation rather than via an effect, so a session switch
  // can't race a save of the previous session's messages under the new session's id. The save is
  // fire-and-forget and captures the sessionId it was created for.
  const commit = useCallback(
    (next: PostponedMessage[]) => {
      generationRef.current++;
      setMessages(next);
      void savePostponed(sessionId, next);
    },
    [sessionId]
  );

  const stash = useCallback(() => {
    const text = draft.trim();
    if (!text && draftImages.length === 0) return;
    commit([...messages, newMessage(text, draftImages)]);
    setDraft("");
    setDraftImages([]);
    setError(null);
  }, [draft, draftImages, messages, commit]);

  const deleteMsg = useCallback((id: string) => commit(messages.filter((m) => m.id !== id)), [messages, commit]);

  /** Open the full-size composer on the inline draft (a new message), carrying whatever is typed. */
  const openComposer = useCallback(() => {
    setComposer({ target: { kind: "draft" }, draft: { text: draft, images: draftImages } });
  }, [draft, draftImages]);

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
        commit(messages.filter((m) => m.id !== id));
      } else {
        setDraft("");
        setDraftImages([]);
      }
      setError(null);
      return true;
    },
    [composer, messages, commit, terminalRef]
  );

  // Composer "Postpone"/"Save": stash a new message, or overwrite the one being edited in place (so it
  // keeps its position in the pool). Expands the pool so the result is visible.
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
        setDraft("");
        setDraftImages([]);
      }
      setError(null);
      setExpanded(true);
    },
    [composer, messages, commit]
  );

  const sendOne = useCallback(
    async (msg: PostponedMessage) => {
      const ok = await terminalRef.current?.sendMessage({
        text: msg.text,
        imagePaths: msg.images.map((i) => i.fullPath),
      });
      if (ok) {
        commit(messages.filter((m) => m.id !== msg.id));
        setError(null);
      } else {
        setError("Terminal not connected — try again in a moment.");
      }
    },
    [messages, terminalRef, commit]
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
    commit(messages.filter((m) => !sent.includes(m.id)));
    if (sent.length < messages.length) setError("Terminal disconnected mid-send — remaining messages kept.");
    setFlushing(false);
  }, [messages, flushing, terminalRef, commit]);

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter((f) => f.type.startsWith("image/"));
      if (!images.length) return;
      for (const file of images) {
        try {
          const { path, fullPath } = await uploadImageFile(sessionId, file);
          setDraftImages((prev) => [...prev, { path, fullPath }]);
          setError(null);
        } catch {
          setError("Image upload failed.");
        }
      }
    },
    [sessionId]
  );

  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return; // text paste falls through to the textarea
      e.preventDefault();
      const file = item.getAsFile();
      if (file) await addImageFiles([file]);
    },
    [addImageFiles]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
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
  const canStash = draft.trim().length > 0 || draftImages.length > 0;

  return (
    <>
    <div data-owns-image-paste className="shrink-0 border-t bg-background">
      {/* One picker for both attach buttons (the bar's and the composer's), mounted outside the
          collapsible body so the bar can open it while the panel is still collapsed. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          addImageFiles(Array.from(e.target.files ?? []));
          e.target.value = ""; // allow re-picking the same file
        }}
      />
      {/* Header: the whole bar toggles expand/collapse; the flush-all action stops propagation. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
        aria-expanded={expanded}
        className="flex cursor-pointer select-none items-center gap-2 px-3 py-1.5"
        title={expanded ? "Collapse postponed messages" : "Expand postponed messages"}
      >
        <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
          {expanded ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
          <Inbox className="size-4" />
          <span>Postponed</span>
          {messages.length > 0 && (
            <Badge variant="secondary" className="px-1.5">
              {messages.length}
            </Badge>
          )}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {idle && (
            <span className="text-xs font-medium text-emerald-600 dark:text-emerald-500">Claude is idle</span>
          )}
          {auto && !closed && (
            <span className="hidden whitespace-nowrap text-xs font-medium text-emerald-600 sm:inline dark:text-emerald-500">
              {messages.length > 0 ? "Auto-sending" : "Sending the last one"}
            </span>
          )}
          {/* Always reachable, collapsed or not — the way in for anything longer than a line, and
              (next to it) for a photo; this replaces the button that used to float over the
              terminal. Attaching leaves the panel exactly as it was: the image joins the draft
              either way, and expanding under someone's thumb is more disruptive than helpful. */}
          <Button
            size="sm"
            variant="outline"
            className="size-9 px-0 sm:size-8"
            onClick={(e) => {
              e.stopPropagation();
              fileInputRef.current?.click();
            }}
            title="Attach an image (photo library or camera)"
            aria-label="Attach an image"
          >
            <ImagePlus className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            // Square icon button on a phone (matching attach), label back from sm up.
            className="size-9 px-0 sm:size-8 sm:w-auto sm:px-3"
            onClick={(e) => {
              e.stopPropagation();
              openComposer();
            }}
            title="Write a message in a full-size window — send it now or postpone it"
            aria-label="Compose a message"
          >
            <PenLine className="size-4" />
            <span className="hidden sm:inline">Compose</span>
          </Button>
          {/* Not offered at all in a closed session: there is no terminal to send into, and a
              greyed button cannot say why — a disabled one takes no pointer events, so the title
              that would have explained it never shows. What the pool still does — read, stash,
              discard — is all still here, and the panel above says where the terminal went. */}
          {/* Auto-send. Offered while there is something to queue, and kept while it is on so it can
              be paused even after the last message has gone in. Absent in a closed session, like
              Send all: a reopen is a new session, with a pool of its own. */}
          {(messages.length > 0 || auto) && !closed && (
            <Button
              size="sm"
              variant={auto ? "default" : "outline"}
              onClick={(e) => {
                e.stopPropagation();
                void toggleAuto();
              }}
              aria-pressed={auto}
              className={cn(
                "size-9 px-0 sm:size-8 sm:w-auto sm:px-3",
                auto && "bg-emerald-600 text-white hover:bg-emerald-600/90"
              )}
              title={
                auto
                  ? "Auto-send is on: each time Claude finishes, the next message goes in. Click to pause."
                  : "Auto-send: each time Claude finishes, send the next message — one at a time, in order"
              }
              aria-label={auto ? "Pause auto-send" : "Start auto-send"}
            >
              {auto ? <Pause className="size-4" /> : <Play className="size-4" />}
              <span className="hidden sm:inline">Auto</span>
            </Button>
          )}
          {/* Hidden while auto-send is on: the server is sending these, and a click here could race
              it into sending one twice. Pause to send by hand. */}
          {messages.length > 0 && !closed && !auto && (
            <Button
              size="sm"
              variant={idle ? "default" : "outline"}
              onClick={(e) => {
                e.stopPropagation();
                sendAll();
              }}
              disabled={flushing}
              className={cn(idle && "bg-emerald-600 text-white hover:bg-emerald-600/90")}
              title="Send every stashed message into the terminal, in order"
            >
              <Send className="size-4" />
              Send all
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-3 pb-2">
          {/* Stashed items */}
          {messages.length > 0 && (
            <div className="mb-2 max-h-[32vh] space-y-1.5 overflow-auto">
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
                        setPreview({ src: sessionFileUrl(sessionId, img.path), name: baseName(img.path) })
                      }
                      className="shrink-0"
                      title="Preview image"
                    >
                      <img
                        src={sessionFileUrl(sessionId, img.path)}
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
          )}

          {/* Composer */}
          {draftImages.length > 0 && (
            <div className="mb-1.5 flex flex-wrap gap-1.5">
              {draftImages.map((img, i) => (
                <div key={i} className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setPreview({ src: sessionFileUrl(sessionId, img.path), name: baseName(img.path) })
                    }
                    title="Preview image"
                  >
                    <img
                      src={sessionFileUrl(sessionId, img.path)}
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
          <div className="flex items-end gap-2">
            <Textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder="Postpone a message — Enter to stash, Shift+Enter or Ctrl+J for a newline, paste an image"
              // min-w-0 flex-1: the Textarea's own w-full would otherwise set a flex base of 100%
              // and, on a narrow screen, soak up the row by shrinking the buttons next to it.
              className="max-h-20 min-h-10 min-w-0 flex-1 resize-none py-2.5 leading-5"
            />
            {/* Desktop-only: on a phone these two would eat the width the message needs, and the
                bar right above already carries both (attach, and Compose for the full-size window).
                shrink-0 keeps them hittable next to the growing textarea. */}
            <Button
              variant="outline"
              size="icon"
              className="hidden shrink-0 sm:inline-flex sm:size-9"
              onClick={() => fileInputRef.current?.click()}
              title="Attach an image (photo library or camera)"
              aria-label="Attach an image"
            >
              <ImagePlus className="size-4" />
            </Button>
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
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
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
