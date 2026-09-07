import { useMemo } from "react";

/**
 * A stable value for the `__html` prop React injects markup through.
 *
 * React compares the *object* it was handed, not the markup inside it, so the `{{ __html }}`
 * literal that every render creates counts as a change and `innerHTML` is written again — even
 * when the markup is byte-identical. That replaces the nodes, and any text selection inside them
 * collapses. The Files panel re-renders a few times a second (session list poll, git status,
 * auto-refresh), which is why a selection in a highlighted file preview died a second after it
 * was made.
 *
 * Memoising the wrapper on the markup keeps the object identical for as long as the markup is, so
 * React leaves the DOM — and the selection — alone. Null markup returns null, so the result also
 * serves as the caller's "is there anything to render" test.
 */
export function useHtml(html: string): { __html: string };
export function useHtml(html: string | null): { __html: string } | null;
export function useHtml(html: string | null): { __html: string } | null {
  return useMemo(() => (html === null ? null : { __html: html }), [html]);
}
