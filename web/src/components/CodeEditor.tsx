import { Fragment, useMemo, type ReactNode } from "react";
import type { CodeNav } from "@/lib/codeNav";
import { highlightLines } from "@/lib/highlight";
import { cn } from "@/lib/utils";

// Past this many characters the draft is edited as plain text: highlighting runs on every
// keystroke, and on a file this size that is what makes typing lag.
const HIGHLIGHT_LIMIT = 200_000;

// What the textarea and the highlighted copy under it must share to the pixel, or the caret drifts
// away from the characters it sits on.
const TEXT = "m-0 border-0 p-4 font-mono text-xs leading-relaxed whitespace-pre [tab-size:4] [grid-area:1/1]";

/**
 * A plain-text editor with syntax highlighting: a textarea whose own text is transparent, laid over
 * a highlighted copy of the same text. The textarea does all the editing — selection, undo, IME,
 * the browser's own shortcuts — and the copy under it only paints the colors.
 *
 * Both sit in one grid cell inside a box that scrolls, so they grow to the same size and scroll as
 * one; the textarea never scrolls by itself, which is what would pull the two apart. So the copy is
 * always there, even with nothing to color (an unknown language, a file past the limit): then it
 * holds the plain text, transparent, to give the cell its size.
 *
 * Handed a `nav`, it navigates names as the read-only view does (see codeNav): the copy is the code
 * the marks are painted on — they show through the textarea — and the textarea takes the clicks.
 *
 * The copy is drawn from tokens through React rather than from highlight.js' HTML, for the reason
 * highlightLines gives: the text is whatever is in the file, and React escapes it.
 */
export function CodeEditor({
  name,
  value,
  onChange,
  zoom = 1,
  nav,
  className,
}: {
  /** The file's name, which picks the language. */
  name: string;
  value: string;
  onChange: (value: string) => void;
  /** CSS zoom, as the read-only view applies it. It goes on the box both layers share, so they
   *  scale as one and the caret stays on its characters. */
  zoom?: number;
  /** The view's code navigation, to work in the editor too. */
  nav?: Pick<CodeNav, "ref" | "input" | "overlay">;
  className?: string;
}) {
  const lines = useMemo(
    () => (value.length <= HIGHLIGHT_LIMIT ? highlightLines(name, value) : null),
    [name, value]
  );

  return (
    <div className={cn("h-full w-full overflow-auto", className)}>
      <div style={{ zoom }} className="grid min-h-full w-max min-w-full">
        {/* The trailing newline gives a final empty line its height, so the caret on it has a row.
            Plain text is transparent rather than invisible: code navigation paints its marks on it. */}
        <pre ref={nav?.ref} aria-hidden className={cn(TEXT, "pointer-events-none", !lines && "code-plain text-transparent")}>
          <code className="hljs">
            {lines
              ? lines.map((tokens, n) => (
                  <Fragment key={n}>
                    {n > 0 && "\n"}
                    {tokens.map((t, i) => (
                      <Fragment key={i}>
                        {t.classes.reduceRight<ReactNode>((child, cls) => <span className={cls}>{child}</span>, t.text)}
                      </Fragment>
                    ))}
                  </Fragment>
                ))
              : value}
            {"\n"}
          </code>
        </pre>
        <textarea
          ref={nav?.input}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
          wrap="off"
          className={cn(
            TEXT,
            "resize-none overflow-hidden bg-transparent outline-none",
            lines && "text-transparent caret-foreground selection:bg-primary/25 selection:text-transparent"
          )}
        />
      </div>
      {nav?.overlay}
    </div>
  );
}
