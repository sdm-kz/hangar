import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Inbox, Pencil, Send, Trash2, X } from "lucide-react";
import { api, sessionFileUrl } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImageLightbox } from "./ImageLightbox";
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

function readAsDataURL(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result as string);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(file);
  });
}

/**
 * Per-session pool of "postponed" messages: a composer pinned under the terminal where the user can
 * stash text and pasted images while Claude is busy, then send them into the live terminal on demand.
 * Nothing sends automatically — when the session goes idle the bar just highlights as a nudge.
 */
export function PostponedPool({
  sessionId,
  busy,
  terminalRef,
}: {
  sessionId: string;
  // Whether Claude is currently working in this session (drives the "idle — send now" cue only).
  busy?: boolean;
  terminalRef: React.RefObject<TerminalPaneHandle | null>;
}) {
  const [messages, setMessages] = useState<PostponedMessage[]>(() => loadPostponed(sessionId));
  const [draft, setDraft] = useState("");
  const [draftImages, setDraftImages] = useState<PostponedImage[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Reload (and reset the composer) when switching sessions — each session has its own stash.
  useEffect(() => {
    setMessages(loadPostponed(sessionId));
    setDraft("");
    setDraftImages([]);
    setError(null);
  }, [sessionId]);

  // Persist alongside every mutation (rather than via an effect) so a session switch can't race a
  // save of the previous session's messages under the new session's key.
  const commit = useCallback(
    (next: PostponedMessage[]) => {
      setMessages(next);
      savePostponed(sessionId, next);
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

  // Pull a stashed item back into the composer to tweak it (text appended, images merged).
  const editMsg = useCallback(
    (msg: PostponedMessage) => {
      setDraft((d) => (d ? d + "\n" : "") + msg.text);
      setDraftImages((imgs) => [...imgs, ...msg.images]);
      commit(messages.filter((m) => m.id !== msg.id));
      setExpanded(true);
      textareaRef.current?.focus();
    },
    [messages, commit]
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

  const onPaste = useCallback(
    async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith("image/"));
      if (!item) return; // text paste falls through to the textarea
      e.preventDefault();
      const file = item.getAsFile();
      if (!file) return;
      const ext = file.type.split("/")[1] || "png";
      try {
        const dataUrl = await readAsDataURL(file);
        const b64 = dataUrl.split(",", 2)[1] ?? "";
        const { path, fullPath } = await api.uploadSessionImage(sessionId, b64, ext);
        setDraftImages((prev) => [...prev, { path, fullPath }]);
        setError(null);
      } catch {
        setError("Image upload failed.");
      }
    },
    [sessionId]
  );

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter stashes; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      stash();
    }
  };

  const idle = !busy && messages.length > 0;
  const canStash = draft.trim().length > 0 || draftImages.length > 0;

  return (
    <>
    <div data-postponed-pool className="shrink-0 border-t bg-background">
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
          {messages.length > 0 && (
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
                  <div className="min-w-0 flex-1 self-center">
                    {m.text ? (
                      <p className="line-clamp-3 whitespace-pre-wrap break-words">{m.text}</p>
                    ) : (
                      <p className="italic text-muted-foreground">
                        {m.images.length} image{m.images.length === 1 ? "" : "s"}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center self-center text-muted-foreground">
                    <button
                      type="button"
                      onClick={() => sendOne(m)}
                      title="Send this message now"
                      className="rounded p-1 hover:bg-accent hover:text-foreground"
                    >
                      <Send className="size-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => editMsg(m)}
                      title="Edit in composer"
                      className="rounded p-1 hover:bg-accent hover:text-foreground"
                    >
                      <Pencil className="size-3.5" />
                    </button>
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
              placeholder="Postpone a message — Enter to stash, Shift+Enter for a newline, paste an image"
              className="max-h-32 min-h-9 resize-none py-1.5"
            />
            <Button onClick={stash} disabled={!canStash} title="Add to the postponed pool">
              Stash
            </Button>
          </div>
          {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
        </div>
      )}
    </div>
    {preview && (
      <ImageLightbox src={preview.src} name={preview.name} onClose={() => setPreview(null)} />
    )}
    </>
  );
}
