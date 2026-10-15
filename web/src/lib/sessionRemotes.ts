// The remote files tabs (SSH/SFTP) open in a session. Like the pinned pages these live in the
// session's UI bag, so a tab follows the session to every device and survives a reload; what is NOT
// here is the connection itself, which the server holds in memory under the tab's id — and with it the
// password or passphrase, which is never written anywhere. After a restart of the app the tab is still
// here and the panel simply asks to connect again (or reconnects by itself, for an agent or an
// unencrypted key).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RemoteConnection, SessionRemote } from "@/types";
import { loadSessionUi, saveSessionUi, subscribeSessionUi } from "./sessionUi";

/** As many SSH tabs as a session may hold — the tab bar is the real limit. */
export const MAX_REMOTES = 8;

/** What a remote tab says: the connection's name, or user@host when it has none. */
export function remoteTabLabel(r: SessionRemote): string {
  return r.connection.name?.trim() || connectionTarget(r.connection);
}

/** user@host:port as typed — the config may still turn the host into something else. */
export function connectionTarget(c: Pick<RemoteConnection, "host" | "user" | "port">): string {
  return `${c.user ? `${c.user}@` : ""}${c.host}${c.port && c.port !== 22 ? `:${c.port}` : ""}`;
}

/** Where a remote tab was left: the folder selected in its tree and the file in its preview. */
export function loadRemoteWhere(sessionId: string, id: string): { cwd?: string; file?: string } {
  return loadSessionUi(sessionId).remoteWhere?.[id] ?? {};
}

export function saveRemoteWhere(sessionId: string, id: string, patch: { cwd?: string; file?: string }) {
  const all = loadSessionUi(sessionId).remoteWhere ?? {};
  const cur = all[id] ?? {};
  if (Object.entries(patch).every(([k, v]) => cur[k as "cwd" | "file"] === v)) return;
  saveSessionUi(sessionId, { remoteWhere: { ...all, [id]: { ...cur, ...patch } } });
}

export interface SessionRemotes {
  remotes: SessionRemote[];
  /** Open a tab for a connection — under the id it was connected with, or a fresh one. */
  add: (connection: RemoteConnection, id?: string) => SessionRemote;
  update: (id: string, patch: Partial<Omit<SessionRemote, "id">>) => void;
  remove: (id: string) => void;
}

function restore(sessionId: string): SessionRemote[] {
  const ui = loadSessionUi(sessionId);
  return (Array.isArray(ui.remotes) ? ui.remotes : []).filter(
    (r): r is SessionRemote => !!r && typeof r.id === "string" && !!r.connection && typeof r.connection.host === "string"
  );
}

export function mintRemoteId(): string {
  // randomUUID needs a secure context, which a plain-http LAN address is not. Only letters, digits
  // and dashes either way: the server keys the connection by it and refuses anything else.
  return crypto.randomUUID?.() ?? `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/** Own a session's remote files tabs, persisting them in its UI bag. */
export function useSessionRemotes(sessionId: string): SessionRemotes {
  const [remotes, setRemotes] = useState<SessionRemote[]>(() => restore(sessionId));
  // Mirrored in a ref for the same reason as the links: add-then-show happens within one click.
  const ref = useRef(remotes);

  const apply = useCallback(
    (next: SessionRemote[]) => {
      ref.current = next;
      setRemotes(next);
      saveSessionUi(sessionId, { remotes: next });
    },
    [sessionId]
  );

  const add = useCallback(
    (connection: RemoteConnection, id?: string) => {
      const created: SessionRemote = { id: id ?? mintRemoteId(), connection };
      apply([...ref.current, created].slice(-MAX_REMOTES));
      return created;
    },
    [apply]
  );

  const update = useCallback(
    (id: string, patch: Partial<Omit<SessionRemote, "id">>) => {
      if (!ref.current.some((r) => r.id === id)) return;
      apply(ref.current.map((r) => (r.id === id ? { ...r, ...patch } : r)));
    },
    [apply]
  );

  const remove = useCallback(
    (id: string) => {
      if (!ref.current.some((r) => r.id === id)) return;
      apply(ref.current.filter((r) => r.id !== id));
      const where = { ...(loadSessionUi(sessionId).remoteWhere ?? {}) };
      if (id in where) {
        delete where[id];
        saveSessionUi(sessionId, { remoteWhere: where });
      }
    },
    [apply, sessionId]
  );

  const adopt = useCallback((next: SessionRemote[]) => {
    ref.current = next;
    setRemotes(next);
  }, []);

  const prevSession = useRef(sessionId);
  useEffect(() => {
    if (prevSession.current === sessionId) return;
    prevSession.current = sessionId;
    adopt(restore(sessionId));
  }, [sessionId, adopt]);

  useEffect(() => subscribeSessionUi(sessionId, () => adopt(restore(sessionId))), [sessionId, adopt]);

  return useMemo(() => ({ remotes, add, update, remove }), [remotes, add, update, remove]);
}
