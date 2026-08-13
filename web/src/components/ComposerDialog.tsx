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
    if (!canSubmit || sending) return;
    setSending(true);
    setError(null);
    const ok = await onSend(draft());
    setSending(false);
    if (ok) onClose();
    else setError("Terminal not connected — postpone it instead, or try again in a moment.");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, sending, text, images, onSend, onClose]);

  const postpone = useCallback(() => {
    if (!canSubmit) return;
    onPostpone(draft());
    onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, text, images, onPostpone, onClose]);

  // Enter is a newline here (this is the long-text surface); Ctrl/Cmd+Enter is the submit.
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-3">
          <DialogHeader className="shrink-0">
            <DialogTitle>{isEditing ? "Edit postponed message" : "Compose message"}</DialogTitle>
            <DialogDescription>
              Send it into the terminal now, or postpone it for later. Ctrl+Enter sends.
            </DialogDescription>
          </DialogHeader>

          <Textarea
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={onPaste}
            onKeyDown={onKeyDown}
            placeholder="Write your message — Enter for a newline, Ctrl+Enter to send, paste an image to attach it"
            className="min-h-[35vh] flex-1 resize-none leading-6"
          />

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

          {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}

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

          <DialogFooter className="shrink-0 sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                size="icon"
                onClick={() => fileInputRef.current?.click()}
                title="Attach an image (photo library or camera)"
              >
                <ImagePlus className="size-4" />
              </Button>
              {text.length > 0 && (
                <span className="hidden text-xs text-muted-foreground sm:inline">
                  {text.length} chars · {text.split("\n").length} lines
                </span>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose} disabled={sending}>
                Cancel
              </Button>
              <Button variant="outline" onClick={postpone} disabled={!canSubmit || sending}>
                <Inbox className="size-4" />
                {isEditing ? "Save" : "Postpone"}
              </Button>
              <Button onClick={send} disabled={!canSubmit || sending}>
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
