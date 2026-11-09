import { useEffect, useState } from "react";
import { Check, Copy, Inbox, Loader2, Trash2 } from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageLightbox, type LightboxImage } from "./ImageLightbox";
import { loadPostponed, savePostponed, type PostponedMessage } from "@/lib/postponed";
import { useApi } from "@/lib/node";

const baseName = (p: string) => p.split(/[\\/]/).pop() || "image";

/**
 * A session's stashed messages, read from the row that counts them.
 *
 * A number on a row is all a list can say about a stash, and this is where you read what it stood
 * for -- without leaving the list, and without reopening the session (and resuming a whole
 * conversation) to get at a note you left yourself. The pool is a file in the working directory and
 * the endpoints serve any session in the list, so nothing but a place to show it was missing.
 *
 * A closed session can be opened now, and its own pool is under the panel where its terminal would
 * be, so this is no longer the only way in -- but it is still the cheap one: opening the session
 * takes the main area off whatever is in it, to read a line of text.
 *
 * Reading, copying and discarding, and no sending: a message goes into a terminal, and a closed
 * session has none. For a live one the pool under its terminal is still where that happens, and is
 * one click away through the row.
 */
export function PostponedDialog({
  sessionId,
  sessionName,
  live,
  onClose,
}: {
  sessionId: string;
  sessionName: string;
  /** Whether the session still has a terminal to send into — changes what the dialog says, not what it does. */
  live: boolean;
  onClose: () => void;
}) {
  const api = useApi();
  const [messages, setMessages] = useState<PostponedMessage[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ src: string; name: string; gallery?: LightboxImage[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadPostponed(api, sessionId)
      .then((m) => !cancelled && setMessages(m))
      .catch(() => !cancelled && setMessages([]));
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const copy = async (m: PostponedMessage) => {
    await writeToClipboard(m.text);
    setCopied(m.id);
    setTimeout(() => setCopied((id) => (id === m.id ? null : id)), 1200);
  };

  const discard = async (id: string) => {
    const before = messages ?? [];
    const next = before.filter((m) => m.id !== id);
    setMessages(next); // optimistic: the row is gone the moment it is asked for
    setError(null);
    // Put the pool back as it was if the save did not land, rather than leaving the dialog showing a
    // deletion the file never took.
    if (!(await savePostponed(api, sessionId, next))) {
      setMessages(before);
      setError("Could not save — the message is still there.");
    }
  };

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex min-w-0 items-center gap-2">
              <Inbox className="size-4 shrink-0" />
              <span className="truncate">Postponed in {sessionName}</span>
            </DialogTitle>
            <DialogDescription>
              {live
                ? "Messages stashed for this session. Send them from the pool under its terminal."
                : "Messages stashed for this session before it was closed. Reopening it does not send them."}
            </DialogDescription>
          </DialogHeader>

          {messages === null ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : messages.length === 0 ? (
            // Reachable: the row's count comes from the session list, which is a few seconds behind a
            // pool emptied from somewhere else.
            <p className="py-6 text-sm text-muted-foreground">Nothing stashed here any more.</p>
          ) : (
            <div className="-mr-1 max-h-[50vh] space-y-2 overflow-y-auto pr-1">
              {messages.map((m) => (
                <div key={m.id} className="rounded-md border p-2 text-sm">
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      {m.text ? (
                        <p className="whitespace-pre-wrap break-words">{m.text}</p>
                      ) : (
                        <p className="italic text-muted-foreground">
                          {m.images.length} image{m.images.length === 1 ? "" : "s"}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {new Date(m.createdAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center text-muted-foreground">
                      {m.text && (
                        <button
                          type="button"
                          onClick={() => void copy(m)}
                          title="Copy text"
                          className="rounded p-1 hover:bg-accent hover:text-foreground"
                        >
                          {copied === m.id ? (
                            <Check className="size-3.5 text-emerald-500" />
                          ) : (
                            <Copy className="size-3.5" />
                          )}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void discard(m.id)}
                        title="Discard"
                        className="rounded p-1 hover:bg-accent hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  </div>
                  {m.images.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {m.images.map((img, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() =>
                            setPreview({
                              src: api.sessionFileUrl(sessionId, img.path),
                              name: baseName(img.path),
                              gallery: m.images.map((i) => ({
                                src: api.sessionFileUrl(sessionId, i.path),
                                name: baseName(i.path),
                              })),
                            })
                          }
                          title="Preview image"
                        >
                          <img
                            src={api.sessionFileUrl(sessionId, img.path)}
                            alt=""
                            className="size-12 cursor-zoom-in rounded border object-cover"
                            // The bytes live beside the pool in the working directory, and a folder
                            // that has been tidied since leaves the text worth showing on its own.
                            onError={(e) => {
                              e.currentTarget.style.display = "none";
                            }}
                          />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Close
            </Button>
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
