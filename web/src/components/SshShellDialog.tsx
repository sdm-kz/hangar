import { useMemo, useState } from "react";
import type { Project, RemoteConnection } from "@/types";
import { connectionTarget } from "@/lib/sessionRemotes";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2, Server } from "lucide-react";
import { blankConnection, RemoteConnectionFields, useSshConfig } from "./RemoteConnect";

/**
 * Open an SSH connection as a terminal: pick a connection saved with any project (or a host from
 * ~/.ssh/config), or type one in. Unlike a remote files tab nothing is negotiated here — ssh runs in
 * the terminal and asks for a host key, a password or a passphrase there, the way it would anywhere.
 */
export function SshShellDialog({
  projects,
  onConnect,
  onClose,
}: {
  /** Every project's saved connections are offered: a terminal belongs to no session, so to no project. */
  projects: Project[];
  /** Open it; a rejection's message is shown here and the dialog stays. */
  onConnect: (connection: RemoteConnection) => Promise<void>;
  onClose: () => void;
}) {
  const cfg = useSshConfig();
  // The same host saved in two projects is one choice, not two.
  const saved = useMemo(() => {
    const seen = new Set<string>();
    const out: { connection: RemoteConnection; project: string }[] = [];
    for (const p of projects)
      for (const c of p.connections ?? []) {
        const k = `${connectionTarget(c)}|${c.auth}|${c.keyPath ?? ""}`.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ connection: c, project: p.name });
      }
    return out;
  }, [projects]);
  const [draft, setDraft] = useState<RemoteConnection>(() =>
    saved[0] ? { ...saved[0].connection } : { ...blankConnection(), auth: "agent" }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!draft.host.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConnect(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4" /> SSH connection
          </DialogTitle>
          <DialogDescription>
            A terminal on another machine, run by ssh on this one. It keeps running when you look elsewhere,
            and is listed in the Shells tab.
          </DialogDescription>
        </DialogHeader>

        {(saved.length > 0 || (cfg?.hosts.length ?? 0) > 0) && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label>Quick pick</Label>
            <div className="flex flex-wrap gap-1.5">
              {saved.map(({ connection: c, project }) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setDraft({ ...c })}
                  title={`${connectionTarget(c)} — saved in ${project}`}
                  className={cn(
                    "max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent",
                    draft.id === c.id && "border-primary bg-primary/10"
                  )}
                >
                  {c.name || connectionTarget(c)}
                </button>
              ))}
              {cfg?.hosts
                .filter((h) => !saved.some((s) => s.connection.host === h.alias))
                .map((h) => (
                  <button
                    key={`cfg:${h.alias}`}
                    type="button"
                    onClick={() => setDraft({ ...blankConnection(), host: h.alias, auth: h.identityFile ? "key" : "agent" })}
                    title={`From ~/.ssh/config: ${h.user ? `${h.user}@` : ""}${h.hostName ?? h.alias}`}
                    className={cn(
                      "max-w-full truncate rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent",
                      !draft.id && draft.host === h.alias && "border-primary bg-primary/10 text-foreground"
                    )}
                  >
                    {h.alias}
                  </button>
                ))}
            </div>
          </div>
        )}

        <RemoteConnectionFields value={draft} onChange={setDraft} idPrefix="ssh-shell" terminal />

        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void submit()} disabled={!draft.host.trim() || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            Connect
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
