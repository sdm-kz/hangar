import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Inbox, Loader2, Paperclip, Send, X } from "lucide-react";
import { attachError, insertPaths, placeCaret, uploadAttachments, useFileDrop } from "@/lib/attach";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropCue } from "./DropCue";
import { ImageLightbox, type LightboxImage } from "./ImageLightbox";
import { SlashSuggestions, SlashTextarea, useSlashInput } from "./SlashCommands";
import { storedZoom } from "./ZoomControls";
import type { PostponedImage } from "@/lib/postponed";
import { useApi } from "@/lib/node";

export interface ComposerDraft {
  text: string;
  images: PostponedImage[];
}

const baseName = (p: string) => p.split(/[\\/]/).pop() || "image";

/**
 * Full-size message composer in a modal — room to write the long prompts that the terminal itself and
 * the one-line postponed composer are awkward for. Three exits: send it straight into the terminal,
 * postpone it into the pool, or cancel. Doubles as the editor for an already-stashed message
 * (`editing` relabels the stash action to "Save").
 */
export function ComposerDialog({
  sessionId,
  open,
  initial,
  editing = false,
  closed = false,
  onSend,
  onPostpone,
  onClose,
}: {
  sessionId: string;
  open: boolean;
  /** Seeds the fields; read once per open, so typing is never clobbered by a parent re-render. */
  initial?: ComposerDraft;
  /** Editing an existing stashed message rather than writing a new one. */
  editing?: boolean;
  /** The session has no live terminal: the draft can only be postponed, not sent. */
  closed?: boolean;
  /** Send into the live terminal. Resolve false to keep the dialog open and show a warning. */
  onSend: (draft: ComposerDraft) => Promise<boolean>;
  onPostpone: (draft: ComposerDraft) => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [text, setText] = useState("");
  const [images, setImages] = useState<PostponedImage[]>([]);
  // Latched at open time: the parent drops its target as the dialog closes, and reading `editing`
  // directly would flip the title and the button label mid-fade.
  const [isEditing, setIsEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string; gallery?: LightboxImage[] } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const slash = useSlashInput(sessionId, text, setText, textRef);
  // Read by the dialog's Esc handler, which the dialog may hold on to from an earlier render.
  const slashRef = useRef(slash);
  slashRef.current = slash;

  // Reseed on each open only — `initial` is a fresh object on every parent render, so depending on it
  // would reset the box mid-typing.
  useEffect(() => {
    if (!open) return;
    setText(initial?.text ?? "");
    setImages(initial?.images ?? []);
    setIsEditing(editing);
    setSending(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Written at the chat's size, as the message box under it is. Read as it opens: the chat's zoom can't
  // change under the dialog, and the dialog opens from the terminal too, where there is no chat to ask.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const zoom = useMemo(() => storedZoom("chat"), [open]);

  // Images go with the message; any other file is named in it, by path, where the caret is.
  const addFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      setUploading((n) => n + files.length);
      try {
        const got = await uploadAttachments(api, sessionId, files);
        if (got.images.length) setImages((prev) => [...prev, ...got.images]);
        if (got.paths.length) {
          let caret = 0;
          setText((cur) => {
            const next = insertPaths(cur, textRef.current, got.paths);
            caret = next.caret;
            return next.text;
          });
          placeCaret(textRef.current, () => caret);
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

  const canSubmit = (text.trim().length > 0 || images.length > 0) && uploading === 0;
  const draft = (): ComposerDraft => ({ text: text.trim(), images });

  const send = useCallback(async () => {
    if (closed || !canSubmit || sending) return;
    setSending(true);
    setError(null);
    const ok = await onSend(draft());
    setSending(false);
    if (ok) onClose();
    else setError("Terminal not connected — postpone it instead, or try again in a moment.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [closed, canSubmit, sending, text, images, onSend, onClose]);

  const postpone = useCallback(() => {
    // Guards on `sending` as well as the button does: a send in flight owns the dialog, and stashing
    // the same draft underneath it would close the dialog out from under the reply.
    if (!canSubmit || sending) return;
    onPostpone(draft());
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, sending, text, images, onPostpone, onClose]);

  // Enter is a newline here (this is the long-text surface), so both exits are chords on it:
  // Ctrl/Cmd+Enter sends, and the same chord with Shift takes the other one -- postpone, or Save
  // when this is an already-stashed message being edited. Shift for "not the default action" is the
  // pairing every send box uses, and it keeps the second exit off a key of its own.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash.onKeyDown(e)) return;
    if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    e.preventDefault();
    if (e.shiftKey) postpone();
    else void send();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        {/* Attaches pasted images itself (see onPaste); the marker keeps the terminal's own
            document-level paste listener from also dropping them into the live input. */}
        <DialogContent
          data-owns-image-paste
          // Files dropped anywhere on the dialog are attached.
          {...drop.dropProps}
          // Esc with the slash-command suggestions up closes them, not the dialog.
          onEscapeKeyDown={(e) => {
            if (!slashRef.current.open) return;
            e.preventDefault();
            slashRef.current.dismiss();
          }}
          className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-3"
        >
          {drop.over && <DropCue className="rounded-lg" />}
          <DialogHeader className="shrink-0">
            <DialogTitle>{isEditing ? "Edit postponed message" : "Compose message"}</DialogTitle>
            <DialogDescription>
              {closed ? (
                <>
                  This session is closed, so there is nowhere to send this — postpone it and it stays
                  with this session&rsquo;s stash, to read back from its row. Ctrl+Shift+Enter{" "}
                  {isEditing ? "saves" : "postpones"}.
                </>
              ) : (
                <>
                  Send it into the terminal now, or postpone it for later. Ctrl+Enter sends,
                  Ctrl+Shift+Enter {isEditing ? "saves" : "postpones"}.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {/* Attach sits above the editor, not in the footer: the text area is tall (and the footer
              ends up under the keyboard on a phone), so the button — and the thumbnails it produces
              — stay in sight next to the header. Same order as the inline composer in the panel. */}
          <div className="flex shrink-0 items-center gap-3">
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
            <Button
              variant="outline"
              size="icon"
              className="size-10 shrink-0 sm:size-9"
              onClick={() => fileInputRef.current?.click()}
              title="Attach images or files (or drop them on the dialog)"
              aria-label="Attach images or files"
            >
              <Paperclip className="size-4" />
            </Button>
            {uploading > 0 && (
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Uploading…
              </span>
            )}
            {text.length > 0 && (
              <span className="text-xs text-muted-foreground">
                {text.length} chars · {text.split("\n").length} lines
              </span>
            )}
          </div>

          {images.length > 0 && (
            <div className="flex shrink-0 flex-wrap gap-1.5">
              {images.map((img, i) => (
                <div key={i} className="relative">
                  <button
                    type="button"
                    onClick={() =>
                      setPreview({
                        src: api.sessionFileUrl(sessionId, img.path),
                        name: baseName(img.path),
                        gallery: images.map((i) => ({ src: api.sessionFileUrl(sessionId, i.path), name: baseName(i.path) })),
                      })
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
                    onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
                    title="Remove image"
                    className="absolute -right-1.5 -top-1.5 rounded-full bg-background text-muted-foreground shadow hover:text-destructive"
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* relative: the slash-command suggestions open above the box, as wide as it. */}
          <div className="relative flex min-h-0 flex-1 flex-col">
            <SlashSuggestions slash={slash} />
            <SlashTextarea
              slash={slash}
              wrapperClassName="flex min-h-0 flex-1 flex-col"
              ref={textRef}
              autoFocus
              value={text}
              {...slash.inputProps}
              onChange={(e) => {
                setText(e.target.value);
                slash.track(e.target);
              }}
              onPaste={onPaste}
              onKeyDown={onKeyDown}
              // The send chord goes with the Send button when there is nothing to send into: offering
              // a shortcut that returns silently is worse than not mentioning it.
              placeholder={
                closed
                  ? "Write your message — Enter for a newline, Ctrl+Shift+Enter to postpone, paste or drop images and files to attach"
                  : "Write your message — Enter for a newline, Ctrl+Enter to send, Ctrl+Shift+Enter to postpone, paste or drop images and files to attach"
              }
              className="min-h-[35vh] flex-1 resize-none"
              // text-sm and leading-6 at the chat's zoom.
              style={{ fontSize: `${0.875 * zoom}rem`, lineHeight: `${1.5 * zoom}rem` }}
            />
          </div>

          {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

          <DialogFooter className="shrink-0">
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={sending}>
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={postpone}
                disabled={!canSubmit || sending}
                title={`${isEditing ? "Save" : "Postpone"} (Ctrl+Shift+Enter)`}
              >
                <Inbox className="size-4" />
                {isEditing ? "Save" : "Postpone"}
              </Button>
              {/* No title for the closed case: a disabled button takes no pointer events, so one
                  would never be read. The description at the top of the dialog carries the why. */}
              <Button
                onClick={send}
                disabled={closed || !canSubmit || sending}
                title={closed ? undefined : "Send (Ctrl+Enter)"}
              >
                {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
                Send
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {preview && (
        <ImageLightbox
          src={preview.src}
          name={preview.name}
          gallery={preview.gallery}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}
