import { useCallback, useEffect, useRef, useState } from "react";
import { ImagePlus, Inbox, Loader2, Send, X } from "lucide-react";
import { sessionFileUrl } from "@/lib/api";
import { uploadImageFile } from "@/lib/upload";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageLightbox } from "./ImageLightbox";
import type { PostponedImage } from "@/lib/postponed";

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
  const [text, setText] = useState("");
  const [images, setImages] = useState<PostponedImage[]>([]);
  // Latched at open time: the parent drops its target as the dialog closes, and reading `editing`
  // directly would flip the title and the button label mid-fade.
  const [isEditing, setIsEditing] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  const addImageFiles = useCallback(
    async (files: File[]) => {
      for (const file of files.filter((f) => f.type.startsWith("image/"))) {
        try {
          const { path, fullPath } = await uploadImageFile(sessionId, file);
          setImages((prev) => [...prev, { path, fullPath }]);
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

  const canSubmit = text.trim().length > 0 || images.length > 0;
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
          className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-3"
        >
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
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                addImageFiles(Array.from(e.target.files ?? []));
                e.target.value = ""; // allow re-picking the same file
              }}
            />
            <Button
              variant="outline"
              size="icon"
              className="size-10 shrink-0 sm:size-9"
              onClick={() => fileInputRef.current?.click()}
              title="Attach an image (photo library or camera)"
              aria-label="Attach an image"
            >
              <ImagePlus className="size-4" />
            </Button>
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

          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            // The send chord goes with the Send button when there is nothing to send into: offering
            // a shortcut that returns silently is worse than not mentioning it.
            placeholder={
              closed
                ? "Write your message — Enter for a newline, Ctrl+Shift+Enter to postpone, paste an image to attach"
                : "Write your message — Enter for a newline, Ctrl+Enter to send, Ctrl+Shift+Enter to postpone, paste an image to attach"
            }
            className="min-h-[35vh] flex-1 resize-none leading-6"
          />

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
        <ImageLightbox src={preview.src} name={preview.name} onClose={() => setPreview(null)} />
      )}
    </>
  );
}
