import { useEffect, useRef, useState } from "react";

/**
 * A counter that advances only when loaded text is *replaced* by different text — used to reload the
 * HTML preview frame, which is addressed by a URL and would otherwise go on showing the document it
 * first loaded.
 *
 * The two transitions it deliberately ignores are what make it worth a hook rather than a line:
 *
 * - **null → text**, the file's first arrival. The frame is not rendered until there is text, so the
 *   first revision it ever sees must be the one it mounts with. Counting this transition sends every
 *   single open through a second load, and a visible re-render of the page.
 * - **identical text**, which a re-fetch produces whenever the file did not really change. The
 *   session's tree poll re-reads the open file every time *anything* in the working directory moves,
 *   which during an active session is constantly; React bails out of an equal string, so this hook
 *   is never even asked — but the rule is stated here because reading `text` as "it changed" is the
 *   mistake this exists to prevent.
 */
export function useContentRev(text: string | null): number {
  const [rev, setRev] = useState(0);
  const previous = useRef<string | null>(null);
  useEffect(() => {
    const had = previous.current;
    previous.current = text;
    if (had !== null && text !== null && had !== text) setRev((r) => r + 1);
  }, [text]);
  return rev;
}
