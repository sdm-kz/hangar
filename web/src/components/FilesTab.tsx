import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Pencil, Plus, Server, Trash2 } from "lucide-react";
import type { RemoteConnection, SessionRemote } from "@/types";
import { useApi } from "@/lib/node";
import { connectionTarget, forgetLocalRemoteWhere } from "@/lib/sessionRemotes";
import { sessionColor } from "@/lib/sessionColors";
import { useConfirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import { OsIcon } from "./OsIcon";
import { RemoteConnectionDialog } from "./RemoteConnect";
import { RemoteFilesView } from "./RemoteFilesView";
import type { LaunchNode } from "./NodePicker";

/**
 * The live connection behind a saved one, as the server keys it. Fixed per connection, so every browser
 * reaches the same one -- and its password, typed once, for as long as it stays open.
 */
export function savedConnectionTab(c: RemoteConnection): string {
  return `files-${c.id}`;
}

/** A saved connection as the remote view takes it: a tab, under its fixed id. */
function asRemote(c: RemoteConnection): SessionRemote {
  return { id: savedConnectionTab(c), connection: c };
}

/**
 * The sidebar's Files tab: one disk at a time -- this machine's, a paired one's, or a host's over SSH --
 * picked from one dropdown above the tree. The SSH connections are saved here, for every browser, with
 * their parameters only: a password or a passphrase is asked for when connecting and never stored (see
 * SavedConnectionStore). Files of a connection open in the main area, as the machines' files do.
 */
export function FilesTab({
  nodes,
  node,
  onPickNode,
  remoteId,
  onPickRemote,
  machineTree,
  openRemote,
  onOpenRemoteFile,
  onCloseRemoteFile,
}: {
  nodes: LaunchNode[];
  node: string | null;
  onPickNode: (node: string | null) => void;
  /** The saved connection shown instead of a machine's disk, or null. */
  remoteId: string | null;
  onPickRemote: (id: string | null) => void;
  /** The picked machine's tree. */
  machineTree: ReactNode;
  /** The connection's file open in the main area, if one is. */
  openRemote: { tab: string; path: string } | null;
  onOpenRemoteFile: (remote: SessionRemote, path: string) => void;
  /** That file is gone: deleted or moved away in the tree, or its connection forgotten. */
  onCloseRemoteFile: () => void;
}) {
  const api = useApi();
  const confirm = useConfirm();
  // Null until the first answer: a remembered pick isn't dropped for a list that hasn't come yet.
  const [connections, setConnections] = useState<RemoteConnection[] | null>(null);
  const [editing, setEditing] = useState<RemoteConnection | "new" | null>(null);
  // Bumped when a connection is edited, so its view starts over on the new parameters.
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let alive = true;
    api
      .savedConnections()
      .then((list) => alive && setConnections(list))
      // A list that couldn't be read stays unknown, rather than empty: the remembered pick would be
      // dropped for a connection that is still there.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [api]);

  const picked = remoteId ? connections?.find((c) => c.id === remoteId) ?? null : null;
  // A pick whose connection was deleted (in another browser) falls back to the machine.
  useEffect(() => {
    if (remoteId && connections && !connections.some((c) => c.id === remoteId)) onPickRemote(null);
  }, [remoteId, connections, onPickRemote]);

  const save = useCallback(
    async (c: RemoteConnection) => {
      try {
        const before = connections ?? [];
        const list = await api.saveConnection(c);
        setConnections(list);
        if (c.id && list.some((x) => x.id === c.id)) {
          // New parameters: the open connection was made with the old ones, so it goes, and the view
          // reconnects with these.
          await api.remoteDisconnect(savedConnectionTab(c)).catch(() => {});
          setRev((n) => n + 1);
        }
        // A new one -- or an edit of one another browser deleted meanwhile, which the server saves
        // as new -- is what the tab shows next.
        const added = list.find((x) => !before.some((o) => o.id === x.id));
        if (added) onPickRemote(added.id);
        return true;
      } catch {
        return false;
      }
    },
    [api, connections, onPickRemote]
  );

  const remove = useCallback(
    async (c: RemoteConnection) => {
      const ok = await confirm({
        title: `Forget ${c.name || connectionTarget(c)}?`,
        description: `The saved connection to ${connectionTarget(c)} is removed from the Files tab, and closed if it is open. Nothing on the host is touched.`,
        confirmLabel: "Forget",
      });
      if (!ok) return;
      try {
        setConnections(await api.deleteSavedConnection(c.id));
        await api.remoteDisconnect(savedConnectionTab(c)).catch(() => {});
        forgetLocalRemoteWhere(savedConnectionTab(c));
        if (openRemote?.tab === savedConnectionTab(c)) onCloseRemoteFile();
        if (remoteId === c.id) onPickRemote(null);
      } catch {
        /* still listed; nothing changed */
      }
    },
    [api, confirm, remoteId, onPickRemote, openRemote, onCloseRemoteFile]
  );

  const value = picked ? `ssh:${picked.id}` : `node:${node ?? ""}`;
  const pickedNode = nodes.find((n) => n.id === node);
  const tint = sessionColor(pickedNode?.color ?? null);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        {picked ? (
          <Server className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <OsIcon os={pickedNode?.os} className="size-3.5 shrink-0 text-muted-foreground" style={tint ? { color: tint } : undefined} />
        )}
        <select
          aria-label="Whose files"
          title={picked ? `${connectionTarget(picked)} over SSH` : "Whose files"}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("ssh:")) onPickRemote(v.slice(4));
            else {
              onPickRemote(null);
              onPickNode(v.slice(5) || null);
            }
          }}
          className="h-7 min-w-0 flex-1 truncate rounded-md field-edge bg-transparent px-1.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <optgroup label="Machines" className="bg-popover text-popover-foreground">
            {nodes.map((n) => (
              <option
                key={n.id ?? ""}
                value={`node:${n.id ?? ""}`}
                // The picked one stays pickable: it is what the box shows, whatever has become of it since.
                disabled={!!n.unavailable && !picked && n.id !== node}
                className="bg-popover text-popover-foreground"
              >
                {[n.name, n.unavailable].filter(Boolean).join(" — ")}
              </option>
            ))}
          </optgroup>
          {connections && connections.length > 0 && (
            <optgroup label="SSH" className="bg-popover text-popover-foreground">
              {connections.map((c) => (
                <option key={c.id} value={`ssh:${c.id}`} className="bg-popover text-popover-foreground">
                  {c.name && c.name !== c.host ? `${c.name} — ${connectionTarget(c)}` : connectionTarget(c)}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        {picked && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              title="Edit this SSH connection"
              aria-label="Edit this SSH connection"
              onClick={() => setEditing(picked)}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0"
              title="Forget this SSH connection"
              aria-label="Forget this SSH connection"
              onClick={() => void remove(picked)}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          title="New SSH connection"
          aria-label="New SSH connection"
          onClick={() => setEditing("new")}
        >
          <Plus className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {picked ? (
          <RemoteFilesView
            key={`${picked.id}:${rev}`}
            remote={asRemote(picked)}
            onOpenFile={(path) => onOpenRemoteFile(asRemote(picked), path)}
            onCloseFile={() => {
              if (openRemote?.tab === savedConnectionTab(picked)) onCloseRemoteFile();
            }}
            openPath={openRemote?.tab === savedConnectionTab(picked) ? openRemote.path : null}
          />
        ) : (
          machineTree
        )}
      </div>
      {editing && (
        <RemoteConnectionDialog
          connection={editing === "new" ? null : editing}
          description="Listed in the Files tab on every browser. No password or passphrase is saved: those are asked for when connecting, and kept in the server's memory only while the connection is open."
          onSave={save}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
