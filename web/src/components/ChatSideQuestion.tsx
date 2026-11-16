import { ChevronDown, ChevronRight, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyPathButton";

/**
 * A side question (/btw) and Claude's answer, which the conversation itself doesn't hold: set apart from
 * it, as Claude's own overlay is. It folds down to its question, to keep it out of the way; while that
 * overlay is still up in the terminal, Close takes it down and folds the card with it. Left to find and
 * marks, which work on what the transcript holds.
 */
export function ChatSideQuestion({
  question,
  answer,
  pending = "Answering…",
  dir,
  collapsed = false,
  onToggle,
  onClose,
}: {
  question: string | null;
  /** Null until it has been read: `pending` says what is going on meanwhile. */
  answer: string | null;
  pending?: string;
  /** Where a relative path in the answer starts: the session's folder. */
  dir?: string;
  /** Folded down to its question; `onToggle` (given once it is kept) folds and opens it. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** Given while the overlay is up in the terminal. */
  onClose?: () => void;
}) {
  const folded = collapsed && !!answer;
  const Chevron = folded ? ChevronRight : ChevronDown;
  return (
    <div data-find-skip className="group/side rounded-lg border border-dashed bg-muted/30 px-3.5 py-2.5">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <span className="shrink-0 font-mono font-semibold text-amber-600 dark:text-amber-400">/btw</span>
        {onToggle ? (
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-1 text-left hover:text-foreground"
            title={folded ? "Show the answer" : "Fold it down to the question"}
            aria-expanded={!folded}
            onClick={onToggle}
          >
            <span className={`min-w-0 flex-1 break-words pt-px ${folded ? "line-clamp-1" : "whitespace-pre-wrap"}`}>
              {question ?? "Side question"}
            </span>
            <Chevron className="mt-px size-3.5 shrink-0" />
          </button>
        ) : (
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pt-px">{question ?? "Side question"}</span>
        )}
        {answer && (
          <CopyButton
            text={answer}
            title="Copy answer (Markdown)"
            className="-my-1 grid size-6 shrink-0 select-none place-items-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover/side:opacity-100 [@media(pointer:coarse)]:opacity-100"
          />
        )}
        {onClose && (
          <Button
            variant="ghost"
            size="sm"
            className="-my-1 h-6 shrink-0 px-2 text-xs"
            title="Close it in the terminal (Esc)"
            onClick={onClose}
          >
            Close
          </Button>
        )}
      </div>
      {folded ? null : answer ? (
        <div className="prose prose-sm mt-1.5 max-w-none break-words dark:prose-invert prose-pre:bg-muted prose-pre:text-foreground [&>div>*:first-child]:mt-0 [&>div>*:last-child]:mb-0">
          <Markdown text={answer} dir={dir} copyCode />
        </div>
      ) : (
        <p className="mt-1.5 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {pending}
        </p>
      )}
    </div>
  );
}
