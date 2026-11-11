import { Fragment, type CSSProperties, type ReactNode } from "react";
import type { CodeToken } from "@/lib/highlight";

/**
 * A file's lines for inside a `<code>`, each its own block that numbers itself: put `code-lines` on
 * the element around them, and {@link gutterStyle} on it or above it. The numbers are drawn by CSS
 * (see .code-lines in index.css), never as text, and every line but the last keeps its newline, so
 * the text in the DOM is the file's to the character — which is what code navigation counts in, and
 * what a copy takes.
 *
 * `lines` are highlightLines' tokens where the language is colored; null draws the text plain.
 */
export function CodeLines({ text, lines }: { text: string; lines: CodeToken[][] | null }) {
  const rows = lines ?? text.split("\n").map((line) => [{ text: line, classes: [] }]);
  return rows.map((tokens, n) => (
    <span key={n} className="code-line">
      {tokens.map((t, i) => (
        <Fragment key={i}>
          {t.classes.reduceRight<ReactNode>((child, cls) => <span className={cls}>{child}</span>, t.text)}
        </Fragment>
      ))}
      {n < rows.length - 1 && "\n"}
    </span>
  ));
}

/** The gutter's width: as many digits as the last line's number has. */
export function gutterStyle(text: string): CSSProperties {
  let count = 1;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) count++;
  return { "--code-gutter": `${String(count).length}ch` } as CSSProperties;
}
