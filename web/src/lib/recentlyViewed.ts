// Which sessions this browser looked at last, most recent first — what the Alt+` switcher orders its
// list by, so a single tap goes back to the session you were just in, the way Alt+Tab does.
//
// Per browser rather than on the server: "the one I was just in" is a fact about the device in front
// of you. The phone has its own order, and a session opened there shouldn't jump to the top of the
// desk's switcher. Every tab of this browser shares the one list, though — each write re-reads it
// first, so two tabs add to it rather than overwrite each other.
//
// Held as session keys (lib/node.tsx: sessionKey), so a peer's session and one of this node's never
// share an entry.
import { useEffect, useState } from "react";

const KEY = "hangar.sessionsViewed";
// Far more than the switcher shows: a session drops off the end only after this many others have
// been opened since, and the ones that no longer exist are skipped when the list is read.
const MAX = 100;

function read(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

function write(keys: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(keys));
  } catch {
    /* storage full or unavailable — the order just isn't remembered past this tab */
  }
}

/**
 * The session keys most recently shown, newest first. `shownKey` is the session on screen now; each
 * time it changes it moves to the front. Kept in step with the other tabs through the `storage` event.
 */
export function useRecentlyViewed(shownKey: string | null): string[] {
  const [keys, setKeys] = useState<string[]>(read);

  useEffect(() => {
    if (!shownKey) return;
    const next = [shownKey, ...read().filter((k) => k !== shownKey)].slice(0, MAX);
    write(next);
    setKeys(next);
  }, [shownKey]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setKeys(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  return keys;
}
