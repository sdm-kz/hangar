import { type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, X } from "lucide-react";
import { writeToClipboard } from "@/lib/clipboard";
import { cn } from "@/lib/utils";

// How long the check mark (or the cross, when the copy didn't take) stays before the copy icon is back.
const FEEDBACK_MS = 1500;

/**
 * A button that copies some text to the clipboard, briefly swapping its icon for a check mark — or a
 * cross, when the browser refused. `text` may be a function, for text that is costly to build and only
 * needed on a click.
 */
export function CopyButton({
  text,
  className,
  iconClassName = "size-3.5",
  title = "Copy",
}: {
  text: string | (() => string);
  className?: string;
  iconClassName?: string;
  title?: string;
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = useCallback(
    async (e: MouseEvent) => {
      e.stopPropagation();
      const ok = await writeToClipboard(typeof text === "function" ? text() : text);
      setState(ok ? "copied" : "failed");
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setState("idle"), FEEDBACK_MS);
    },
    [text]
  );
  return (
    <button
      type="button"
      className={className}
      title={state === "copied" ? "Copied!" : state === "failed" ? "Couldn't copy" : title}
      aria-label={title}
      onClick={copy}
    >
      {state === "copied" ? (
        <Check className={cn(iconClassName, "text-emerald-500")} />
      ) : state === "failed" ? (
        <X className={cn(iconClassName, "text-destructive")} />
      ) : (
        <Copy className={iconClassName} />
      )}
    </button>
  );
}

// A hover action that copies a file/folder path to the clipboard. Shared by the session Files tree
// (FileBrowser) and the whole-server tree (FilesSidebar), which copy relative and absolute paths
// respectively.
export function CopyPathButton({
  path,
  className,
  iconClassName,
  title = "Copy path",
}: {
  path: string;
  className?: string;
  iconClassName?: string;
  title?: string;
}) {
  return <CopyButton text={path} className={className} iconClassName={iconClassName} title={title} />;
}
