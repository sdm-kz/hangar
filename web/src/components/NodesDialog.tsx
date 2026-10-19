import { useCallback, useEffect, useRef, useState } from "react";
import type { AllowedNode, CertificateSeen, NodeInfo, PeerNode, PeerStatus } from "@/types";
import { api, ApiError } from "@/lib/api";
import { age } from "@/lib/age";
import { COLOR_CHOICES, sessionColor } from "@/lib/sessionColors";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Ban, Loader2, Lock, Network, Plus, RefreshCw, ShieldAlert, ShieldQuestion } from "lucide-react";

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

/** " · paired 3h ago" — or nothing, for a time age() can't put a number on (a clock behind the server's). */
const ago = (iso: string, what: string) => {
  const text = age(iso);
  return text ? ` · ${what} ${text} ago` : "";
};

/**
 * Settings → Nodes: this machine's identity, and the other machines running Hangar it is paired with, in
 * both directions — the nodes it reaches (with the token they issued it) and the nodes allowed to reach it
 * (with a token it issued them). See plans/multi-node.md.
 */
export function NodesDialog({ onClose }: { onClose: () => void }) {
  const [self, setSelf] = useState<NodeInfo | null>(null);
  const [peers, setPeers] = useState<PeerNode[]>([]);
  const [allowed, setAllowed] = useState<AllowedNode[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PeerStatus | "checking">>({});
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const confirm = useConfirm();

  // The latest probe per node: an answer to an older one (a slow check overtaken by a newer) is dropped.
  const probeSeq = useRef<Record<string, number>>({});
  const probe = useCallback((id: string) => {
    const seq = (probeSeq.current[id] = (probeSeq.current[id] ?? 0) + 1);
    const settle = (status: PeerStatus) => {
      if (probeSeq.current[id] === seq) setStatuses((s) => ({ ...s, [id]: status }));
    };
    setStatuses((s) => ({ ...s, [id]: "checking" }));
    api.nodeStatus(id).then(settle, (e) => settle({ status: "offline", node: null, error: message(e), certificate: null }));
  }, []);

  const load = useCallback(async () => {
    try {
      const overview = await api.nodes();
      setSelf(overview.self);
      setPeers(overview.peers);
      setAllowed(overview.allowed);
      setError(null);
      return overview;
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void load().then((overview) => overview?.peers.filter((p) => p.enabled).forEach((p) => probe(p.id)));
  }, [load, probe]);

  const forget = async (peer: PeerNode) => {
    const both = allowed.some((a) => a.nodeId === peer.id);
    const ok = await confirm({
      title: `Forget ${peer.name}?`,
      description: both
        ? `This node stops reaching ${peer.name}, and asks it to drop the token it issued (if it can be reached). ${peer.name} can still reach this node until you revoke it under "Allowed in".`
        : `This node stops reaching ${peer.name}, and asks it to drop the token it issued (if it can be reached).`,
      confirmLabel: "Forget",
    });
    if (!ok) return;
    try {
      await api.forgetNode(peer.id);
      await load();
    } catch (e) {
      setError(message(e));
    }
  };

  const revoke = async (node: AllowedNode) => {
    const name = node.name ?? node.nodeId.slice(0, 8);
    const ok = await confirm({
      title: `Revoke ${name}'s access?`,
      description: `${name} can no longer reach this node, from its next request on. To let it back in, pair again.`,
      confirmLabel: "Revoke",
    });
    if (!ok) return;
    try {
      await api.revokeAllowedNode(node.key);
      await load();
    } catch (e) {
      setError(message(e));
    }
  };

  const setEnabled = async (peer: PeerNode, enabled: boolean) => {
    try {
      const updated = await api.updateNode(peer.id, { enabled });
      setPeers((list) => list.map((p) => (p.id === updated.id ? updated : p)));
      if (enabled) probe(peer.id);
    } catch (e) {
      setError(message(e));
    }
  };

  const trust = async (peer: PeerNode, cert: CertificateSeen) => {
    if (!cert.fingerprint) return;
    const ok = await confirm({
      title: `Trust ${peer.name}'s new certificate?`,
      description: (
        <span className="flex flex-col gap-2">
          <span>
            {peer.fingerprint
              ? "The certificate changed since you trusted it."
              : "The node's certificate isn't one this machine trusts any more (expired, or replaced by a self-signed one)."}{" "}
            That happens when a node's certificate is regenerated — or when someone is intercepting the
            connection. Only trust it if you know why.
          </span>
          <span className="break-all font-mono text-xs">{cert.fingerprint}</span>
        </span>
      ),
      confirmLabel: "Trust it",
    });
    if (!ok) return;
    try {
      await api.trustNode(peer.id, cert.fingerprint);
      await load();
      probe(peer.id);
    } catch (e) {
      setError(message(e));
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="grid-rows-[auto_minmax(0,1fr)] max-h-[calc(100dvh-2rem)] max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Network className="size-4 shrink-0" />
            Nodes
          </DialogTitle>
          <DialogDescription>
            Other machines running Hangar. A paired node can do anything on this one that you can — run a
            shell, read and write files — so pair only machines you would give your password to.
          </DialogDescription>
        </DialogHeader>

        {/* -mx-1 px-1: room for the focus rings a scroller would clip (see GroupDialog). */}
        <div className="-mx-1 flex min-h-0 flex-col gap-5 overflow-y-auto overscroll-contain px-1">
          {error && <p className="text-xs text-destructive">{error}</p>}

          {self && <ThisNode node={self} onSaved={setSelf} />}

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Nodes this one reaches</h3>
            {!loaded ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : peers.length === 0 ? (
              <p className="text-xs text-muted-foreground">None yet. Add one below.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {peers.map((peer) => (
                  <PeerRow
                    key={peer.id}
                    peer={peer}
                    status={statuses[peer.id]}
                    onRefresh={() => probe(peer.id)}
                    onEnabled={(on) => void setEnabled(peer, on)}
                    onForget={() => void forget(peer)}
                    onTrust={(cert) => void trust(peer, cert)}
                  />
                ))}
              </ul>
            )}
          </section>

          <AddNode
            onAdded={async (peer) => {
              await load();
              probe(peer.id);
            }}
          />

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Allowed in</h3>
            {!loaded ? null : allowed.length === 0 ? (
              <p className="text-xs text-muted-foreground">No other node can reach this one.</p>
            ) : (
              <ul className="flex flex-col divide-y rounded-md border">
                {allowed.map((node) => (
                  <li key={node.key} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{node.name ?? node.nodeId.slice(0, 8)}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {node.url ?? "address unknown"}
                        {ago(node.issuedAt, "paired")}
                        {node.lastUsedAt ? ago(node.lastUsedAt, "last seen") : " · not used yet"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      aria-label={`Revoke ${node.name ?? node.nodeId.slice(0, 8)}`}
                      onClick={() => void revoke(node)}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** This node's name, colour and the address peers reach it at. */
function ThisNode({ node, onSaved }: { node: NodeInfo; onSaved: (node: NodeInfo) => void }) {
  const [name, setName] = useState(node.name);
  const [url, setUrl] = useState(node.url ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = name.trim() !== node.name || url.trim() !== (node.url ?? "");

  const save = async (patch: { name?: string; color?: string; url?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.updateSelfNode(patch);
      // What the server kept, which is not always what was typed: the address is normalized, the name
      // trimmed and bounded. Otherwise the two never match again and Save stays lit.
      setName(saved.name);
      setUrl(saved.url ?? "");
      onSaved(saved);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">This node</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="node-name">Name</Label>
          <Input id="node-name" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="node-url">Address for other nodes</Label>
          <Input
            id="node-url"
            value={url}
            placeholder="Worked out at pairing"
            title="Where other nodes reach this one. Leave empty to use the address each pairing request comes from. Sent when pairing: nodes already paired keep the address they have."
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {COLOR_CHOICES.map((c) => (
          <button
            key={c.name}
            type="button"
            title={c.name}
            aria-label={c.name}
            aria-pressed={node.color === c.name}
            disabled={busy}
            onClick={() => void save({ color: c.name })}
            className={cn(
              "size-5 rounded-full border-2 transition-transform hover:scale-110",
              node.color === c.name ? "border-foreground" : "border-transparent"
            )}
            style={{ backgroundColor: c.css }}
          />
        ))}
        <button
          type="button"
          title="No colour"
          aria-label="No colour"
          aria-pressed={node.color === null}
          disabled={busy}
          onClick={() => void save({ color: "" })}
          className={cn(
            "flex size-5 items-center justify-center rounded-full border-2 text-muted-foreground transition-transform hover:scale-110",
            node.color === null ? "border-foreground" : "border-border"
          )}
        >
          <Ban className="size-3" />
        </button>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={!dirty || !name.trim() || busy}
          onClick={() => void save({ name: name.trim(), url: url.trim() })}
        >
          {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
          Save
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

const STATUS_LOOK: Record<PeerStatus["status"], { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  online: { label: "online", variant: "success" },
  offline: { label: "offline", variant: "secondary" },
  unauthorized: { label: "not accepted", variant: "destructive" },
  incompatible: { label: "incompatible", variant: "warning" },
  certificate: { label: "certificate changed", variant: "destructive" },
};

function PeerRow({
  peer,
  status,
  onRefresh,
  onEnabled,
  onForget,
  onTrust,
}: {
  peer: PeerNode;
  status: PeerStatus | "checking" | undefined;
  onRefresh: () => void;
  onEnabled: (enabled: boolean) => void;
  onForget: () => void;
  onTrust: (cert: CertificateSeen) => void;
}) {
  const accent = sessionColor(peer.color);
  const look = status && status !== "checking" ? STATUS_LOOK[status.status] : null;
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span
          className="size-2.5 shrink-0 rounded-full border"
          style={accent ? { backgroundColor: accent, borderColor: accent } : undefined}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("truncate", !peer.enabled && "text-muted-foreground line-through")}>{peer.name}</span>
            {peer.enabled && status === "checking" && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            {peer.enabled && look && (
              <Badge variant={look.variant} title={status !== "checking" ? (status?.error ?? undefined) : undefined}>
                {look.label}
              </Badge>
            )}
          </div>
          <div className="flex items-center gap-1 truncate text-xs text-muted-foreground">
            {peer.fingerprint && (
              <span title={`Certificate pinned: ${peer.fingerprint}`}>
                <Lock className="size-3" />
              </span>
            )}
            <span className="truncate">{peer.url}</span>
            {status && status !== "checking" && status.node?.version && <span>· {status.node.version}</span>}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground"
          title="Check again"
          aria-label={`Check ${peer.name} again`}
          onClick={onRefresh}
          disabled={!peer.enabled || status === "checking"}
        >
          <RefreshCw className="size-3.5" />
        </Button>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title="A disabled node is kept, but not reached">
          <Checkbox checked={peer.enabled} aria-label={`Reach ${peer.name}`} onCheckedChange={(v) => onEnabled(v === true)} />
          On
        </label>
        <Button variant="ghost" size="sm" className="text-destructive" aria-label={`Forget ${peer.name}`} onClick={onForget}>
          Forget
        </Button>
      </div>
      {peer.enabled && status && status !== "checking" && status.status !== "online" && status.error && (
        <p className="text-xs text-muted-foreground">{status.error}</p>
      )}
      {peer.enabled && status && status !== "checking" && status.status === "certificate" && status.certificate && (
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 break-all font-mono text-xs">{status.certificate.fingerprint}</span>
          <Button size="sm" variant="outline" onClick={() => onTrust(status.certificate!)}>
            Trust new certificate
          </Button>
        </div>
      )}
    </li>
  );
}

/** Pair with another node: its address and password, once. */
function AddNode({ onAdded }: { onAdded: (peer: PeerNode) => void | Promise<void> }) {
  const [url, setUrl] = useState("");
  const [password, setPassword] = useState("");
  const [mutual, setMutual] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The certificate an https node presented that this machine doesn't trust: shown, and trusted by pairing again.
  const [cert, setCert] = useState<{ seen: CertificateSeen; changed: boolean } | null>(null);

  // A ref, not `busy`: a second Enter lands before the re-render that would disable anything, and two
  // pairings in flight leave this node holding whichever token the other side revoked second.
  const inFlight = useRef(false);
  const add = async (fingerprint?: string) => {
    if (!url.trim() || !password || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.addNode({ url: url.trim(), password, mutual, fingerprint });
      setCert(null);
      setUrl("");
      setPassword("");
      setNotice(
        result.mutual === "ok"
          ? `Paired with ${result.node.name}, both ways.`
          : result.mutual === "unreachable"
            ? `Paired with ${result.node.name} — but it could not reach this node back, so it doesn't list this one. Set "Address for other nodes" above and pair again to fix that.`
            : `Paired with ${result.node.name}, one way.`
      );
      await onAdded(result.node);
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { certificate?: CertificateSeen; changed?: boolean } | undefined) : undefined;
      if (body?.certificate) setCert({ seen: body.certificate, changed: !!body.changed });
      else setError(message(e));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">Add a node</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-node-url">Address</Label>
          <Input
            id="add-node-url"
            value={url}
            placeholder="http://nas.lan:5099"
            onChange={(e) => {
              setUrl(e.target.value);
              setCert(null);
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="add-node-password">Its password</Label>
          <Input
            id="add-node-password"
            type="password"
            value={password}
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              void add();
            }}
          />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={mutual} onCheckedChange={(v) => setMutual(v === true)} />
        Both ways — the other node lists this one too
      </label>

      {cert && (
        <div className="flex flex-col gap-1.5 rounded-md border p-3 text-xs">
          <p className="flex items-start gap-1.5 font-medium">
            {cert.changed ? (
              <ShieldAlert className="mt-px size-3.5 shrink-0 text-destructive" />
            ) : (
              <ShieldQuestion className="mt-px size-3.5 shrink-0" />
            )}
            {cert.changed
              ? "The node presented a different certificate from the one you confirmed."
              : "This machine doesn't trust the node's certificate (self-signed?)."}
          </p>
          <p className="text-muted-foreground">
            {cert.changed
              ? "It changed between one try and the next — which can mean someone is intercepting the connection. Only trust it if you know why."
              : "Check that this fingerprint is the node's before trusting it. It is remembered, and a different certificate later is refused."}
          </p>
          {cert.seen.subject && <p className="break-all text-muted-foreground">{cert.seen.subject}</p>}
          <p className="break-all font-mono">{cert.seen.fingerprint}</p>
          <div>
            <Button
              size="sm"
              variant={cert.changed ? "destructive" : "outline"}
              disabled={busy}
              onClick={() => void add(cert.seen.fingerprint ?? undefined)}
            >
              {busy && <Loader2 className="mr-1.5 size-3.5 animate-spin" />}
              Trust and pair
            </Button>
          </div>
        </div>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}
      {notice && <p className="text-xs text-muted-foreground">{notice}</p>}
      {/* While a certificate waits on a decision, its own button is the way on; this one would only ask again. */}
      <div className={cn(cert && "hidden")}>
        <Button size="sm" disabled={!url.trim() || !password || busy} onClick={() => void add()}>
          {busy ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Plus className="mr-1.5 size-3.5" />}
          Pair
        </Button>
      </div>
    </section>
  );
}
