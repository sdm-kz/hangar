// The GitHub repos a session can review pull requests from.
//
// A session runs in one folder, but the work rarely stays there: a change in one repo is answered by
// a change in another, and a folder opened a level up over several repos has no remote of its own to
// speak for it. So the list is three things at once — the folder's own remote, the repos linked to
// the folder, and the repos the folder's project names — and the server puts them together
// (SessionRepos in Program.cs), which is why this asks rather than works it out.
//
// Unlike the tabs and the links, none of this lives in the session's UI bag: a linked repo is a fact
// about the folder and the project, not about this browser, so it is the server's to hold. What is
// here is a cache of the answer, shared by every picker on screen — a session split into four groups
// draws four of them, and linking a repo in one has to show in the others.
import { useCallback, useEffect, useState } from "react";
import type { SessionRepo } from "@/types";
import { apiForKey, splitSessionKey, useApi, useSessionKey } from "./node";

interface Entry {
  repos: SessionRepo[];
  /** The fetch is in flight, or has never been made. Distinguishes "no repos" from "not asked". */
  loading: boolean;
  /** Why the list could not be read. A link that was refused says so here too. */
  error: string | null;
}

const PENDING: Entry = { repos: [], loading: true, error: null };

const cache = new Map<string, Entry>();
const watchers = new Map<string, Set<() => void>>();
// How many times each session's list has been written. Every write takes a number and an answer only
// lands if its number is still the latest — so a reload in flight cannot overwrite the repo you
// linked while you waited for it, and a refusal is not wiped by a read that started before it.
const writes = new Map<string, number>();

/** Claim the next write for a session. The answer checks it before landing. */
function claim(sessionId: string): number {
  const next = (writes.get(sessionId) ?? 0) + 1;
  writes.set(sessionId, next);
  return next;
}

function put(sessionId: string, entry: Entry, write = claim(sessionId)) {
  // A write older than one already applied is an answer to a question that has since been asked
  // again, or answered better. Dropping it is what keeps the list and the message on screen in step.
  if (write < (writes.get(sessionId) ?? 0)) return;
  cache.set(sessionId, entry);
  watchers.get(sessionId)?.forEach((fn) => fn());
}

// The fetch each session has in the air, so the pickers sharing a list share the request for it as
// well. A session split into four groups draws four pickers, all mounting in the same commit.
const inFlight = new Map<string, Promise<void>>();

/** Ask the server for a session's repos, unless a good answer is already held or already coming. */
function refresh(sessionId: string, force: boolean) {
  const held = cache.get(sessionId);
  // Asked once per session and then shared: a repo is linked from here, so what is cached only goes
  // out of date when another device links one — which is what the picker's reload button is for.
  if (held && !held.loading && !force) return;
  // Already on its way. A forced reload still waits for it rather than racing it: what would come
  // back is the same list, and two answers to one question is how the newer one gets lost.
  if (inFlight.has(sessionId)) return;

  const write = claim(sessionId);
  put(sessionId, { repos: held?.repos ?? [], loading: true, error: null }, write);
  // Keyed by session KEY (lib/node.tsx), so a peer's session asks its own node.
  const done = apiForKey(sessionId)
    .githubRepos(splitSessionKey(sessionId).id)
    .then((repos) => put(sessionId, { repos, loading: false, error: null }, write))
    .catch((e) =>
      put(
        sessionId,
        {
          repos: [],
          loading: false,
          error: e instanceof Error ? e.message : "Could not reach the server.",
        },
        write
      )
    )
    .finally(() => {
      if (inFlight.get(sessionId) === done) inFlight.delete(sessionId);
    });
  inFlight.set(sessionId, done);
}

/**
 * "owner/name" out of what was typed — a bare name, or the GitHub URL that is usually what is in the
 * clipboard. Null when it is neither. The server does this too, and is the one that decides; this is
 * here so the field can refuse an obvious slip without a round trip, and so the caller knows which
 * repo it just linked without having to guess it out of the list that comes back.
 */
export function cleanRepoName(text: string): string | null {
  let name = text.trim();
  const url = name.match(/github\.com[/:]+([^/]+)\/([^/#?]+)/i);
  if (url) name = `${url[1]}/${url[2].replace(/\.git$/i, "")}`;
  const parts = name.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  if (parts.some((s) => s.length > 100 || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(s))) return null;
  return parts.join("/");
}

export interface SessionRepos extends Entry {
  /**
   * Link a repo to this session's folder. Takes "owner/name" or a pasted GitHub URL, and answers
   * with the name it linked or with why it could not.
   *
   * <p>The refusal is returned rather than stored anywhere here on purpose. A typo is one person's
   * mistake in one popup, not a fact about the session: kept in the shared entry it would appear in
   * every other group's picker and read as though the list itself had failed to load, and kept in
   * this hook it would outlive the popup being closed, since the picker stays mounted behind it.
   * So it goes to the caller, which knows when it stops being true.</p>
   */
  link: (repo: string) => Promise<{ name: string; error?: undefined } | { name?: undefined; error: string }>;
  /** Unlink one. Only a repo the *session* linked can go — see SessionRepo.source. */
  unlink: (repo: string) => Promise<void>;
  reload: () => void;
}

/** The repos a session can review, kept in step across every picker showing them. */
export function useSessionRepos(sessionId: string): SessionRepos {
  const api = useApi();
  // The cache's key: the same id on two nodes is two sessions.
  const key = useSessionKey(sessionId);
  const [entry, setEntry] = useState<Entry>(() => cache.get(key) ?? PENDING);

  useEffect(() => {
    const seen = () => setEntry(cache.get(key) ?? PENDING);
    seen();
    const stop = watch(key, seen);
    refresh(key, false);
    return stop;
  }, [key]);

  const link = useCallback(
    async (repo: string) => {
      const clean = cleanRepoName(repo);
      if (!clean) {
        return { error: "That is not a repository — give it as owner/name, or paste its GitHub URL." };
      }
      try {
        put(key, { repos: await api.githubLinkRepo(sessionId, clean), loading: false, error: null });
        return { name: clean };
      } catch (e) {
        // The list itself is still good — only the attempt failed, so what is shown stays put.
        return { error: e instanceof Error ? e.message : "Could not link that repository." };
      }
    },
    [api, sessionId, key]
  );

  const unlink = useCallback(
    async (repo: string) => {
      try {
        put(key, { repos: await api.githubUnlinkRepo(sessionId, repo), loading: false, error: null });
      } catch {
        refresh(key, true);
      }
    },
    [api, sessionId, key]
  );

  const reload = useCallback(() => refresh(key, true), [key]);

  return { ...entry, link, unlink, reload };
}

function watch(sessionId: string, fn: () => void): () => void {
  let set = watchers.get(sessionId);
  if (!set) watchers.set(sessionId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) watchers.delete(sessionId);
  };
}

/**
 * Re-ask for every session on screen. Called when a project's repos change, since a project's repos
 * are in the list of every session under it and there is no telling from here which those are.
 */
export function invalidateSessionRepos() {
  for (const id of [...watchers.keys()]) refresh(id, true);
  for (const id of [...cache.keys()]) if (!watchers.has(id)) cache.delete(id);
}
