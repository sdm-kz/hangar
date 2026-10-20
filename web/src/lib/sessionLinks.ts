// The web pages pinned to a session — the Jira issue it is working from, the PR it is answering, the
// doc it is following — and the small amount of URL reading the tabs need to name themselves.
//
// The links live in the session's UI bag (lib/sessionUi.ts), keyed by conversation, so they are the
// same on every device and survive a reopen. Nothing here talks to the server: what a link IS is
// something the browser already knows. Only the question "will this page render in a frame?" needs
// the server, and that is api.probeLink.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SessionLink } from "@/types";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "./sessionUi";

/** A session can pin this many pages. The tab bar is the real limit; this just stops a runaway. */
export const MAX_LINKS = 12;

/**
 * Turn what someone typed or pasted into a URL we can open, or null if it is not one. A bare
 * "acme.atlassian.net/browse/AB-1" is a URL as far as the person typing is concerned, so a missing
 * scheme is filled in rather than rejected — https, since a site that only speaks http will
 * redirect and the probe follows it.
 */
export function normalizeLinkUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** The host a link points at, without the "www." nobody reads. Empty for anything unparseable. */
export function linkHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

/**
 * A name for a link the site did not give us one for. The last path segment is almost always the
 * identifying part — "AB-123" out of `/browse/AB-123`, "1842" out of `/pulls/1842` — and it is what
 * someone scanning a row of tabs is looking for. A URL that is just a host falls back to the host.
 */
export function defaultLinkTitle(url: string): string {
  try {
    const u = new URL(url);
    const segments = u.pathname.split("/").filter(Boolean);
    const last = segments.length ? decodeURIComponent(segments[segments.length - 1]) : "";
    const cleaned = deslug(last.replace(/\.(html?|php|aspx?)$/i, ""));
    return cleaned || linkHost(url) || url;
  } catch {
    return url;
  }
}

/**
 * Read a path segment as words where it plainly is some — "Kanban_board" is a title, "my-blog-post"
 * is a title — and leave it alone where the punctuation is part of the name. Hyphens only count as
 * separators from the third piece on, which is what keeps an issue key ("AB-123", "JRACLOUD-1")
 * intact: those are the links this feature exists for, and a tab reading "JRACLOUD 1" is wrong.
 */
function deslug(segment: string): string {
  const text = segment.replace(/_+/g, " ").trim();
  return text.split(/-+/).filter(Boolean).length >= 3 ? text.replace(/-+/g, " ").trim() : text;
}

/**
 * A title an app serves before its own script has run. Taking one is worse than taking nothing: the
 * tab would be called "Loading…" for the rest of its life, and a single-page Jira or dashboard is
 * exactly the kind of link this is used on.
 */
const PLACEHOLDER_TITLE = /^(loading|please wait|redirecting|just a moment|untitled)\b/i;

/** The name to offer for a page, given whatever its own title turned out to be. */
export function suggestLinkTitle(url: string, pageTitle?: string | null): string {
  const title = pageTitle?.trim() ?? "";
  return title && !PLACEHOLDER_TITLE.test(title) ? title : defaultLinkTitle(url);
}

/** Short label for the tab itself — the full title is in its tooltip, where there is room. */
export function linkTabLabel(link: SessionLink): string {
  return link.title.trim() || defaultLinkTitle(link.url);
}

/** Everything the tab strip and the frame need in order to work with a session's linked pages. */
export interface SessionLinks {
  links: SessionLink[];
  /** The link filling the pane, or null when there are none. */
  activeId: string | null;
  /** The link `activeId` names, resolved. */
  active: SessionLink | null;
  /** Pin a page and give it the pane. Returns the stored link (with its minted id). */
  add: (link: Omit<SessionLink, "id">) => SessionLink;
  /** Change a pinned page — renamed, re-pointed, or switched between frame and browser tab. */
  update: (id: string, patch: Partial<Omit<SessionLink, "id">>) => void;
  remove: (id: string) => void;
  /** Show a link, as a user click — persisted, because choosing one is a choice worth keeping. */
  activate: (id: string) => void;
}

/** Read a session's links out of the saved bag, dropping anything that isn't one. */
function restore(sessionId: string): { links: SessionLink[]; active: string | null } {
  const ui = loadSessionUi(sessionId);
  const links = (Array.isArray(ui.links) ? ui.links : []).filter(
    (l): l is SessionLink =>
      !!l &&
      typeof l.id === "string" &&
      typeof l.url === "string" &&
      // The bag is written by whoever holds the session — a peer, for one of its own — so what is opened
      // and framed from it is held to what a typed link is: http(s), nothing that runs here.
      /^https?:\/\//i.test(l.url) &&
      normalizeLinkUrl(l.url) !== null
  );
  const active = ui.link && links.some((l) => l.id === ui.link) ? ui.link : links[0]?.id ?? null;
  return { links, active };
}

function mintId(): string {
  // randomUUID needs a secure context, which a plain-http LAN address is not.
  return crypto.randomUUID?.() ?? `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Own a session's linked web pages: the list, which one is showing, and persisting both. */
export function useSessionLinks(sessionId: string): SessionLinks {
  const [links, setLinks] = useState<SessionLink[]>(() => restore(sessionId).links);
  const [activeId, setActiveId] = useState<string | null>(() => restore(sessionId).active);

  // The state, mirrored where the callbacks below can both read and write it. They are used in
  // sequence within one click — add a link, then show it — and a ref that only caught up on the next
  // render would have the second call persisting the list as it was before the first. State updates
  // are batched; this is not, which is the point.
  const linksRef = useRef(links);
  const activeRef = useRef(activeId);

  const apply = useCallback(
    (nextLinks: SessionLink[], nextActive: string | null) => {
      linksRef.current = nextLinks;
      activeRef.current = nextActive;
      setLinks(nextLinks);
      setActiveId(nextActive);
      // Empty string, not undefined: the bag merges field by field and only a value can clear one.
      saveSessionUi(sessionId, { links: nextLinks, link: nextActive ?? "" });
    },
    [sessionId]
  );

  const add = useCallback(
    (link: Omit<SessionLink, "id">) => {
      const created: SessionLink = { ...link, id: mintId() };
      // Re-pinning a page already on the bar moves to it instead of stacking a duplicate tab.
      const existing = linksRef.current.find((l) => l.url === created.url);
      if (existing) {
        apply(linksRef.current, existing.id);
        return existing;
      }
      // The dialog refuses to add past the cap, so the slice is only a backstop against a list that
      // arrived over-long from another device — it keeps the newest, which is where the tab just
      // added is.
      apply([...linksRef.current, created].slice(-MAX_LINKS), created.id);
      return created;
    },
    [apply]
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<SessionLink, "id">>) => {
      apply(
        linksRef.current.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        activeRef.current
      );
    },
    [apply]
  );

  // Closing a tab falls back to its neighbour, the way a file tab does.
  const remove = useCallback(
    (id: string) => {
      const idx = linksRef.current.findIndex((l) => l.id === id);
      if (idx === -1) return;
      const next = linksRef.current.filter((l) => l.id !== id);
      const nextActive =
        activeRef.current === id
          ? next[Math.min(idx, next.length - 1)]?.id ?? null
          : activeRef.current;
      apply(next, nextActive);
    },
    [apply]
  );

  const activate = useCallback((id: string) => apply(linksRef.current, id), [apply]);

  /**
   * Take a list that came from somewhere else — the saved bag on a session switch, or another
   * device's write — without saving it back. The refs move with the state for the same reason
   * `apply` moves them: the next click reads them, not the render.
   */
  const adopt = useCallback((next: { links: SessionLink[]; active: string | null }) => {
    linksRef.current = next.links;
    setLinks(next.links);
    // A remote change only moves the tab being looked at if that tab has gone.
    const keep = activeRef.current && next.links.some((l) => l.id === activeRef.current);
    activeRef.current = keep ? activeRef.current : next.active;
    setActiveId(activeRef.current);
  }, []);

  // Switching session: take that session's links. Skips the first run (and StrictMode's doubled
  // mount) so the state the initializers already restored is not thrown away and re-saved.
  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    adopt(restore(sessionId));
  }, [sessionId, adopt]);

  // Adopt a change from another browser. Unlike the view mode, the list itself is shared state worth
  // following live — a link added on the phone should turn up here — so this takes both the seed and
  // later writes. The active tab moves only when the one being looked at has gone.
  useEffect(
    () => subscribeSessionUi(sessionId, () => adopt(restore(sessionId))),
    [sessionId, adopt]
  );

  const active = useMemo(() => links.find((l) => l.id === activeId) ?? null, [links, activeId]);

  return useMemo(
    () => ({ links, activeId, active, add, update, remove, activate }),
    [links, activeId, active, add, update, remove, activate]
  );
}
