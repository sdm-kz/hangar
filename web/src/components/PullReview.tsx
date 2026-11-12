import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileText, Inbox, Loader2, MessageSquarePlus, Send, Trash2 } from "lucide-react";
import { commentCount, countComments, type ReviewTarget } from "@/lib/prReview";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useConfirm } from "@/components/ui/confirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useApi } from "@/lib/node";
import { chord } from "@/lib/shortcuts";

/** Where a floating thing goes on screen: just under the end of the selection it is about. */
export interface Spot {
  top: number;
  left: number;
}

const GAP = 6; // between the selection and what floats under it
const EDGE = 8; // kept clear of the window's edges

/** The element a selection endpoint is in — a text node's parent, or the node itself. */
function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Whether the selection takes in any of this cell's text, rather than only touching its edge. */
function takesText(range: Range, cell: Element): boolean {
  if (!range.intersectsNode(cell)) return false;
  const part = document.createRange();
  part.selectNodeContents(cell);
  if (range.compareBoundaryPoints(Range.START_TO_START, part) > 0)
    part.setStart(range.startContainer, range.startOffset);
  if (range.compareBoundaryPoints(Range.END_TO_END, part) < 0) part.setEnd(range.endContainer, range.endOffset);
  return !part.collapsed && part.toString().length > 0;
}

/**
 * The lines a selection in the review covers, or null when it is not something to comment on: empty,
 * outside the code, or spread over more than one file.
 *
 * Read from the cells rather than from the selected text. In a split diff the browser's idea of a
 * selection runs through both columns row by row, and even with the other column made unselectable
 * the text it hands back has no line numbers in it. The cells carry their side and number (see Code
 * in PullRequestView), so the lines are whole lines on one side, whatever part of them was dragged
 * over — a comment is about lines, the way GitHub's are.
 */
export function pickLines(range: Range, box: HTMLElement): ReviewTarget | null {
  if (range.collapsed || !box.contains(range.commonAncestorContainer)) return null;
  const file = elementOf(range.commonAncestorContainer)?.closest<HTMLElement>("[data-review-path]");
  if (!file?.dataset.reviewPath) return null;

  // The side is the one the drag started in; one that started in a gutter or a hunk header takes the
  // side of the first line it reached.
  const startCell = elementOf(range.startContainer)?.closest<HTMLElement>("[data-side]");
  const cells = Array.from(file.querySelectorAll<HTMLElement>("[data-side][data-line]"));
  const side = (startCell?.dataset.side ?? cells.find((c) => takesText(range, c))?.dataset.side) as
    | "old"
    | "new"
    | undefined;
  if (!side) return null;

  const picked = cells.filter((c) => c.dataset.side === side && takesText(range, c));
  if (!picked.length) return null;
  // The old side of a renamed file is the file under its old name.
  const path = (side === "old" && file.dataset.reviewOldPath) || file.dataset.reviewPath;

  const lines: string[] = [];
  let prev = -1;
  for (const c of picked) {
    const n = Number(c.dataset.line);
    // A selection across two hunks steps over lines the diff never sent — say so rather than
    // presenting the two ends as though they were next to each other.
    if (prev >= 0 && n > prev + 1) lines.push("…");
    // A blank line is drawn as a space so its row keeps its height; it is still a blank line.
    const text = c.textContent ?? "";
    lines.push(text === " " ? "" : text);
    prev = n;
  }
  return {
    path,
    side,
    start: Number(picked[0].dataset.line),
    end: prev,
    code: lines.join("\n"),
  };
}

/** Just under the end of a selection, kept on screen. */
export function spotFor(range: Range): Spot {
  const rects = range.getClientRects();
  const last = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
  return { top: last.bottom + GAP, left: last.left };
}

/** The button that turns a selection into a comment. It floats where the selection ends. */
export function CommentButton({ spot, onClick }: { spot: Spot; onClick: () => void }) {
  return (
    <button
      type="button"
      // Pressing it must not clear the selection it is about before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      title="Comment on the selected lines — send it to the session now, or add it to the review"
      style={{
        top: Math.min(spot.top, window.innerHeight - 40),
        left: Math.max(EDGE, Math.min(spot.left, window.innerWidth - 120)),
      }}
      className="fixed z-40 flex items-center gap-1 rounded-md border bg-popover px-2 py-1 text-xs font-medium shadow-md hover:bg-accent"
    >
      <MessageSquarePlus className="size-3.5" />
      Comment
    </button>
  );
}

/** "src/a.ts:10–14", for the card's header. */
function label(t: ReviewTarget): string {
  const lines = t.start === t.end ? `${t.start}` : `${t.start}–${t.end}`;
  return `${t.path}:${lines}${t.side === "old" ? " (old)" : ""}`;
}

/**
 * Writing a comment on the lines picked out. A card rather than a dialog: the code it is about stays
 * in view beside it, and nothing else on the page is put out of reach while it is open. It closes
 * only when told to — a stray click elsewhere is not a reason to throw away what was written.
 */
export function CommentCard({
  target,
  spot,
  closed,
  onSend,
  onAdd,
  onClose,
}: {
  target: ReviewTarget;
  spot: Spot;
  /** The session is not running, so there is nothing to send into — the review still takes it. */
  closed: boolean;
  onSend: (body: string) => Promise<void>;
  onAdd: (body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"send" | "add" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(spot);

  // Under the selection when there is room for the card there, above the bottom of the window when
  // there is not. Measured once drawn, since how tall the card is depends on the code it shows.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      top: Math.max(EDGE, Math.min(spot.top, window.innerHeight - height - EDGE)),
      left: Math.max(EDGE, Math.min(spot.left, window.innerWidth - width - EDGE)),
    });
  }, [spot]);

  const run = useCallback(
    async (kind: "send" | "add") => {
      if (!body.trim() || busy || (kind === "send" && closed)) return;
      setBusy(kind);
      setError(null);
      try {
        await (kind === "send" ? onSend : onAdd)(body);
        onClose();
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : "That did not go through — try again.");
        setBusy(null);
      }
    },
    [body, busy, closed, onSend, onAdd, onClose]
  );

  // The same chords the composer uses: Ctrl+Enter sends, Ctrl+Shift+Enter keeps it for later.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (!(e.ctrlKey || e.metaKey) || e.key !== "Enter") return;
    e.preventDefault();
    void run(e.shiftKey ? "add" : "send");
  };

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-label="Comment on the selected lines"
      style={{ top: pos.top, left: pos.left }}
      className="fixed z-40 flex w-[28rem] max-w-[calc(100vw-1rem)] flex-col gap-2 rounded-md border bg-popover p-2 text-sm shadow-lg"
    >
      <div className="truncate font-mono text-xs text-muted-foreground" title={label(target)}>
        {label(target)}
      </div>
      <pre className="max-h-32 overflow-auto rounded bg-muted/60 px-2 py-1 font-mono text-[11px] leading-snug">
        {target.code}
      </pre>
      <Textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          closed
            ? `What should change here? ${chord("mod", "shift", "Enter")} adds it to the review`
            : `What should change here? ${chord("mod", "Enter")} sends it now, ${chord("mod", "shift", "Enter")} adds it to the review`
        }
        className="min-h-24 resize-y text-sm"
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose} disabled={busy !== null}>
          Cancel
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void run("add")}
          disabled={!body.trim() || busy !== null}
          title={`Keep it in this pull request's review file, to send with the rest (${chord("mod", "shift", "Enter")})`}
        >
          {busy === "add" ? <Loader2 className="size-3.5 animate-spin" /> : <Inbox className="size-3.5" />}
          Add to review
        </Button>
        <Button
          size="sm"
          onClick={() => void run("send")}
          disabled={closed || !body.trim() || busy !== null}
          title={closed ? undefined : `Send it to the session's Claude now (${chord("mod", "Enter")})`}
        >
          {busy === "send" ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          Send now
        </Button>
      </div>
    </div>
  );
}

/** The header's way into the review: how many comments it holds, and the dialog that sends it. */
export function ReviewButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="The comments kept for this pull request — read them over, then send the whole review"
      className="mt-0.5 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <FileText className="size-3.5" />
      {/* The word goes on a narrow pane, the way "Viewed" does: the title beside it needs the room. */}
      <span className="hidden sm:inline">Review</span>
      <span className="rounded-full bg-primary px-1.5 text-[10px] tabular-nums text-primary-foreground">{count}</span>
    </button>
  );
}

/**
 * The review file, open for a last read before it goes. Editable, because it is plain Markdown and
 * what is in the box is exactly what Claude is sent: a comment dropped, one reworded, a line added at
 * the top about what matters most. Sending hands it over as one message and then deletes the file —
 * the review is in the conversation from then on, and a file left behind would be sent twice.
 */
export function ReviewDialog({
  sessionId,
  path,
  text,
  closed,
  onSave,
  onCheck,
  onDone,
  onClose,
}: {
  sessionId: string;
  /** The review file, relative to the session's folder. */
  path: string;
  text: string;
  closed: boolean;
  onSave: (text: string) => Promise<void>;
  /** Whether the file still holds this text; when not, the new version comes back in as `text`. */
  onCheck: (text: string) => Promise<boolean>;
  /** The review has been sent or discarded; the file is gone. */
  onDone: () => void;
  onClose: () => void;
}) {
  const api = useApi();
  const [draft, setDraft] = useState(text);
  // The version of the file the draft was started from — what "edited" is measured against, and
  // what is checked against the file before anything replaces or deletes it.
  const [base, setBase] = useState(text);
  const [busy, setBusy] = useState<"send" | "save" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = useConfirm();
  const dirty = draft !== base;

  // A newer version of the file — read on opening, or found by a check below. Into the box when
  // nothing has been typed there; otherwise the typing stays and becomes an edit of the new version.
  useEffect(() => {
    if (text === base) return;
    if (draft === base) setDraft(text);
    setBase(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const fail = (e: unknown, fallback: string) => {
    setError(e instanceof Error && e.message ? e.message : fallback);
    setBusy(null);
  };

  /** False, with the reader told why, when the file has changed since the draft was started. */
  const unchanged = async () => {
    if (await onCheck(base)) return true;
    setError(
      dirty
        ? "The review file was changed elsewhere since this opened. Your edits are still here — press again to replace it with them."
        : "The review file was changed elsewhere since this opened, and the box now shows the new version — press again to go ahead."
    );
    setBusy(null);
    return false;
  };

  const send = async () => {
    if (!draft.trim() || busy || closed) return;
    setBusy("send");
    setError(null);
    try {
      if (!(await unchanged())) return;
      await api.sendMessage(sessionId, draft.trim());
    } catch (e) {
      fail(e, "Could not send the review — try again.");
      return;
    }
    // Sent is what matters. The file going too is tidying, and if it fails the worst that happens is
    // the review stays offered — better than reporting a sent review as unsent.
    onDone();
  };

  const save = async () => {
    if (!dirty || busy) return;
    setBusy("save");
    setError(null);
    try {
      if (!(await unchanged())) return;
      await onSave(draft);
      setBusy(null);
    } catch (e) {
      fail(e, "Could not save the review.");
    }
  };

  const discard = async () => {
    if (busy) return;
    const ok = await confirm({
      title: "Discard this review?",
      description: `${commentCount(countComments(draft))} deleted along with the file, and nothing is sent.`,
      confirmLabel: "Discard",
    });
    if (!ok) return;
    setBusy("discard");
    setError(null);
    try {
      if (!(await unchanged())) return;
    } catch (e) {
      fail(e, "Could not read the review file.");
      return;
    }
    onDone();
  };

  // Escape and a click outside close it like any dialog — but not over edits without asking.
  const requestClose = async () => {
    if (busy) return;
    if (
      dirty &&
      !(await confirm({
        title: "Close without saving?",
        description: "Your edits to the review are dropped; the file stays as it was.",
        confirmLabel: "Close",
      }))
    )
      return;
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      void send();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key.toLowerCase() === "s" || e.code === "KeyS")) {
      // The letter, or the key where the layout's letter isn't Latin (Ы on a Russian one), as App's chords.
      e.preventDefault();
      void save();
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && void requestClose()}>
      <DialogContent className="flex max-h-[88vh] w-[calc(100vw-2rem)] max-w-3xl flex-col gap-3">
        <DialogHeader className="shrink-0">
          <DialogTitle>Review — {commentCount(countComments(draft))}</DialogTitle>
          <DialogDescription>
            Kept in <span className="font-mono text-xs">{path}</span>. Edit it freely — this is exactly what the
            session is sent.{" "}
            {closed
              ? "The session is closed, so the review waits here until it is running again."
              : `${chord("mod", "Enter")} sends it, ${chord("mod", "S")} saves.`}
          </DialogDescription>
        </DialogHeader>
        <Textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          className="min-h-[45vh] flex-1 resize-none font-mono text-xs leading-5"
        />
        {error && <p className="shrink-0 text-xs text-destructive">{error}</p>}
        <DialogFooter className="shrink-0">
          <div className="flex w-full items-center gap-2">
            <Button variant="ghost" onClick={() => void discard()} disabled={busy !== null} className="text-destructive">
              <Trash2 className="size-4" />
              Discard
            </Button>
            <div className="flex-1" />
            <Button variant="outline" onClick={() => void save()} disabled={!dirty || busy !== null} title={`Save (${chord("mod", "S")})`}>
              {busy === "save" && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
            <Button
              onClick={() => void send()}
              disabled={closed || !draft.trim() || busy !== null}
              title={closed ? undefined : `Send the whole review to the session (${chord("mod", "Enter")})`}
            >
              {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
              Send review
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
