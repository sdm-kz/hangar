import { useCallback, useEffect, useRef, useState } from "react";
import type { Project, RemoteAuth, RemoteConnection, RemoteConnectResult, SshConfigInfo } from "@/types";
import { api } from "@/lib/api";
import { connectionTarget, mintRemoteId } from "@/lib/sessionRemotes";
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
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, KeyRound, Loader2, Server, ShieldAlert, ShieldQuestion } from "lucide-react";

/** A connection with nothing filled in yet. */
export function blankConnection(): RemoteConnection {
  return { id: "", name: "", host: "", port: 0, user: null, auth: "password", keyPath: null, startPath: null };
}

// The server's ~/.ssh/config hosts and key files, fetched once per page: they change about as often
// as someone edits the file, and the dialogs that offer them open many times.
let sshConfigCache: Promise<SshConfigInfo> | null = null;
export function useSshConfig(): SshConfigInfo | null {
  const [info, setInfo] = useState<SshConfigInfo | null>(null);
  useEffect(() => {
    let alive = true;
    sshConfigCache ??= api.sshConfig().catch((e) => {
      sshConfigCache = null; // try again next time
      throw e;
    });
    sshConfigCache.then((i) => alive && setInfo(i)).catch(() => alive && setInfo({ hosts: [], keys: [], sshDir: "" }));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

const AUTHS: { id: RemoteAuth; label: string; hint: string }[] = [
  { id: "password", label: "Password", hint: "Typed when you connect, never saved." },
  { id: "key", label: "Key file", hint: "A private key on the server machine. A passphrase is asked for if it has one." },
  { id: "agent", label: "SSH agent", hint: "Keys held by the OpenSSH agent (or Pageant) on the server machine." },
];

/**
 * The parameters of a connection — everything but the secret. Shared by the connect dialog and the
 * project's Connections tab, so a saved connection is edited with exactly the fields it is made with.
 */
export function RemoteConnectionFields({
  value,
  onChange,
  idPrefix,
}: {
  value: RemoteConnection;
  onChange: (next: RemoteConnection) => void;
  idPrefix: string;
}) {
  const cfg = useSshConfig();
  const set = (patch: Partial<RemoteConnection>) => onChange({ ...value, ...patch });
  // What the config says about the host as typed — shown as the placeholders, since it is what a
  // blank field will turn into.
  const alias = cfg?.hosts.find((h) => h.alias.toLowerCase() === value.host.trim().toLowerCase());
  const hint = AUTHS.find((a) => a.id === value.auth)?.hint;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="grid grid-cols-[1fr_6rem] gap-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${idPrefix}-host`}>Host</Label>
          <Input
            id={`${idPrefix}-host`}
            value={value.host}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            list={`${idPrefix}-hosts`}
            onChange={(e) => set({ host: e.target.value })}
            placeholder="server.example.com or an ssh config alias"
          />
          <datalist id={`${idPrefix}-hosts`}>
            {cfg?.hosts.map((h) => (
              <option key={h.alias} value={h.alias}>
                {[h.user && `${h.user}@`, h.hostName ?? h.alias].filter(Boolean).join("")}
              </option>
            ))}
          </datalist>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-port`}>Port</Label>
          <Input
            id={`${idPrefix}-port`}
            inputMode="numeric"
            value={value.port ? String(value.port) : ""}
            onChange={(e) => {
              const n = Number(e.target.value.replace(/\D/g, ""));
              set({ port: Number.isFinite(n) && n > 0 && n <= 65535 ? n : 0 });
            }}
            placeholder={String(alias?.port ?? 22)}
          />
        </div>
      </div>
      {alias?.hostName && (
        <p className="-mt-1 text-xs text-muted-foreground">
          From ~/.ssh/config: {alias.user ? `${alias.user}@` : ""}
          {alias.hostName}
          {alias.port ? `:${alias.port}` : ""}
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${idPrefix}-user`}>User</Label>
          <Input
            id={`${idPrefix}-user`}
            value={value.user ?? ""}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => set({ user: e.target.value || null })}
            placeholder={alias?.user ?? "the server account's"}
          />
        </div>
        <div className="min-w-0 space-y-1.5">
          <Label htmlFor={`${idPrefix}-name`}>Name</Label>
          <Input
            id={`${idPrefix}-name`}
            value={value.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder={value.host ? connectionTarget(value) : "Shown on the tab"}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Authentication</Label>
        <div role="radiogroup" className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
          {AUTHS.map((a) => (
            <button
              key={a.id}
              type="button"
              role="radio"
              aria-checked={value.auth === a.id}
              onClick={() => set({ auth: a.id })}
              className={cn(
                "rounded px-2 py-1 text-sm transition-colors",
                value.auth === a.id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>

      {value.auth === "key" && (
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-key`}>Key file</Label>
          <Input
            id={`${idPrefix}-key`}
            value={value.keyPath ?? ""}
            spellCheck={false}
            list={`${idPrefix}-keys`}
            onChange={(e) => set({ keyPath: e.target.value || null })}
            placeholder={alias?.identityFile ?? (cfg?.keys[0] ? `${cfg.keys[0]} (default)` : "~/.ssh/id_ed25519")}
          />
          <datalist id={`${idPrefix}-keys`}>
            {cfg?.keys.map((k) => <option key={k} value={k} />)}
          </datalist>
        </div>
      )}

      <div className="space-y-1.5">
        <Label htmlFor={`${idPrefix}-start`}>Start folder</Label>
        <Input
          id={`${idPrefix}-start`}
          value={value.startPath ?? ""}
          spellCheck={false}
          onChange={(e) => set({ startPath: e.target.value || null })}
          placeholder="The remote home"
        />
      </div>
    </div>
  );
}

/**
 * Connect a remote tab, and the conversation that can take: a host key to accept, a password or a
 * passphrase to type (again). One hook for the dialog that opens a new tab and for the panel asking to
 * reconnect one after a restart, so the two can never disagree about what a result means.
 */
export function useRemoteConnector(tabId: string) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RemoteConnectResult | null>(null);

  const connect = useCallback(
    async (
      connection: RemoteConnection,
      secrets: { password?: string; passphrase?: string; trustFingerprint?: string } = {}
    ): Promise<RemoteConnectResult> => {
      setBusy(true);
      try {
        const r = await api.remoteConnect(tabId, { connection, ...secrets });
        setResult(r);
        return r;
      } catch (e) {
        const r: RemoteConnectResult = { status: "error", error: e instanceof Error ? e.message : "Could not connect." };
        setResult(r);
        return r;
      } finally {
        setBusy(false);
      }
    },
    [tabId]
  );

  return { busy, result, connect, reset: () => setResult(null) };
}

/** The host key the server presented, to be looked at and accepted — or, if it changed, refused. */
function HostKeyPanel({ result }: { result: RemoteConnectResult }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5 rounded-md border px-3 py-2 text-xs",
        result.changed ? "border-destructive/60 bg-destructive/10" : "bg-muted/40"
      )}
    >
      <p className="flex items-start gap-1.5 font-medium">
        {result.changed ? (
          <ShieldAlert className="mt-px size-3.5 shrink-0 text-destructive" />
        ) : (
          <ShieldQuestion className="mt-px size-3.5 shrink-0" />
        )}
        {result.changed
          ? "The host key has CHANGED since you last trusted it."
          : result.otherTypeKnown
            ? `${result.target ?? "This host"} offers a key of a type not seen before — a key of another type is already trusted.`
            : `First connection to ${result.target ?? "this host"}.`}
      </p>
      <p className="text-muted-foreground">
        {result.changed
          ? "This can mean the server was reinstalled — or that someone is intercepting the connection. Only trust the new key if you know why it changed."
          : "Check that this fingerprint is the server's before trusting it. It is remembered, and a different key later is refused."}
      </p>
      <p className="break-all font-mono">
        {result.keyType} {result.fingerprint}
      </p>
    </div>
  );
}

/**
 * The secret and host-key half of connecting, with the button: what both the dialog and an
 * unconnected panel show under whatever else they show.
 */
function ConnectControls({
  connection,
  connector,
  onConnected,
  autoFocus,
  footer,
}: {
  connection: RemoteConnection;
  connector: ReturnType<typeof useRemoteConnector>;
  onConnected: (home: string) => void;
  autoFocus?: boolean;
  /** Extra buttons beside Connect (Cancel, in the dialog). */
  footer?: React.ReactNode;
}) {
  const [password, setPassword] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const { busy, result, connect } = connector;
  const askPassphrase = connection.auth === "key" && (result?.secret === "passphrase" || passphrase !== "");

  const go = async (trust?: string) => {
    if (!connection.host.trim()) return;
    const r = await connect(connection, {
      password: connection.auth === "password" ? password : undefined,
      passphrase: connection.auth === "key" && passphrase ? passphrase : undefined,
      trustFingerprint: trust,
    });
    if (r.status === "connected") onConnected(r.home ?? "/");
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void go(result?.status === "hostKey" && !result.changed ? result.fingerprint ?? undefined : undefined);
      }}
      className="flex min-w-0 flex-col gap-3"
    >
      {connection.auth === "password" && (
        <div className="space-y-1.5">
          <Label htmlFor="remote-password">Password</Label>
          <Input
            id="remote-password"
            type="password"
            autoComplete="off"
            autoFocus={autoFocus}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Kept in the server's memory while the tab is open. Never saved.</p>
        </div>
      )}
      {connection.auth === "key" && (
        <div className="space-y-1.5">
          <Label htmlFor="remote-passphrase" className="flex items-center gap-1.5">
            <KeyRound className="size-3.5" /> Key passphrase{" "}
            {!askPassphrase && <span className="font-normal text-muted-foreground">(if the key has one)</span>}
          </Label>
          <Input
            id="remote-passphrase"
            type="password"
            autoComplete="off"
            autoFocus={autoFocus && result?.secret === "passphrase"}
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </div>
      )}

      {result?.status === "hostKey" && <HostKeyPanel result={result} />}
      {(result?.status === "error" || (result?.status === "secret" && result.error)) && (
        <p className="flex items-start gap-1.5 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" /> {result.error}
        </p>
      )}
      {result?.status === "secret" && !result.error && (
        <p className="text-sm text-muted-foreground">
          {result.secret === "passphrase" ? "The key is protected — type its passphrase." : "Type the password."}
        </p>
      )}

      <DialogFooter className="gap-2">
        {footer}
        {result?.status === "hostKey" ? (
          <Button
            type="button"
            variant={result.changed ? "destructive" : "default"}
            disabled={busy}
            onClick={() => void go(result.fingerprint ?? undefined)}
          >
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
            {result.changed ? "Trust the new key" : "Trust and connect"}
          </Button>
        ) : (
          <Button type="submit" disabled={busy || !connection.host.trim()}>
            {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
            Connect
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * Open a remote files tab: pick a connection saved with the project (or one from ~/.ssh/config), or
 * type one in; connect; and optionally save it with the project — without its secret. The tab only
 * appears once the connection is up, so a typo costs a retry here rather than a dead tab.
 */
export function RemoteConnectDialog({
  project,
  onProjectsChange,
  onConnected,
  onClose,
}: {
  /** The session's project, whose saved connections are offered and where a new one can be saved. */
  project: Project | null;
  onProjectsChange?: (projects: Project[]) => void;
  onConnected: (tabId: string, connection: RemoteConnection) => void;
  onClose: () => void;
}) {
  const [tabId] = useState(mintRemoteId);
  const saved = project?.connections ?? [];
  const [draft, setDraft] = useState<RemoteConnection>(() => (saved[0] ? { ...saved[0] } : blankConnection()));
  const [save, setSave] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const connector = useRemoteConnector(tabId);
  const cfg = useSshConfig();
  // Editing a saved connection makes it a different one: offer to save the change.
  const pickedSaved = saved.find((c) => c.id === draft.id);
  const changedFromSaved =
    !!pickedSaved && JSON.stringify({ ...pickedSaved, id: "" }) !== JSON.stringify({ ...draft, id: "" });

  const pick = (c: RemoteConnection) => {
    setDraft({ ...c });
    connector.reset();
  };

  // Set once the connection is up: a second submit must not open a second tab, and a save that
  // failed keeps the dialog open to say so (with the way on).
  const [finished, setFinished] = useState<RemoteConnection | null>(null);
  const finishing = useRef(false);
  const connected = async () => {
    if (finishing.current) return;
    finishing.current = true;
    let connection = draft;
    if (project && save) {
      try {
        // A picked connection is updated in place; anything else is saved as a new one.
        const list = await api.saveProjectConnection(project.id, pickedSaved ? draft : { ...draft, id: "" });
        onProjectsChange?.(list);
        const after = list.find((x) => x.id === project.id)?.connections ?? [];
        const stored = pickedSaved
          ? after.find((c) => c.id === draft.id)
          : after.find((c) => !saved.some((o) => o.id === c.id));
        if (stored) connection = stored;
      } catch (e) {
        setSaveError(`Connected, but the connection was not saved: ${e instanceof Error ? e.message : "unknown error"}`);
        setFinished(connection);
        return;
      }
    }
    onConnected(tabId, connection);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4" /> Remote files over SSH
          </DialogTitle>
          <DialogDescription>
            Browse, preview and edit files on another machine, and copy them to and from this session's
            folder. Opens as a tab of this session.
          </DialogDescription>
        </DialogHeader>

        {(saved.length > 0 || (cfg?.hosts.length ?? 0) > 0) && (
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label>Quick pick</Label>
            <div className="flex flex-wrap gap-1.5">
              {saved.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => pick(c)}
                  title={`${connectionTarget(c)} — saved in ${project?.name}`}
                  className={cn(
                    "max-w-full truncate rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent",
                    draft.id === c.id && "border-primary bg-primary/10"
                  )}
                >
                  {c.name || connectionTarget(c)}
                </button>
              ))}
              {cfg?.hosts
                .filter((h) => !saved.some((c) => c.host === h.alias))
                .map((h) => (
                  <button
                    key={`cfg:${h.alias}`}
                    type="button"
                    onClick={() => pick({ ...blankConnection(), host: h.alias, auth: h.identityFile ? "key" : "agent" })}
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

        <RemoteConnectionFields
          value={draft}
          idPrefix="connect"
          onChange={(next) => {
            setDraft(next);
            if (connector.result?.status === "hostKey") connector.reset();
          }}
        />

        {project && (!pickedSaved || changedFromSaved) && (
          <label className="flex cursor-pointer items-start gap-2.5">
            <Checkbox checked={save} onCheckedChange={(v) => setSave(v === true)} className="mt-0.5" />
            <span className="min-w-0 text-sm">
              {changedFromSaved ? "Update the saved connection" : `Save in ${project.name}`}
              <span className="block text-xs text-muted-foreground">
                Everything above, without the password or passphrase. Listed in the project's settings.
              </span>
            </span>
          </label>
        )}
        {saveError && <p className="text-sm text-destructive">{saveError}</p>}

        {finished ? (
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                onConnected(tabId, finished);
                onClose();
              }}
            >
              Open the tab
            </Button>
          </DialogFooter>
        ) : (
        <ConnectControls
          connection={draft}
          connector={connector}
          onConnected={() => void connected()}
          footer={
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
          }
        />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add or edit a connection saved with a project — the parameters only, from the project's settings.
 * Nothing connects from here; the connection is offered the next time a session in the project opens
 * a remote files tab.
 */
export function RemoteConnectionDialog({
  connection,
  onSave,
  onClose,
}: {
  /** The connection to edit, or null for a new one. */
  connection: RemoteConnection | null;
  onSave: (connection: RemoteConnection) => Promise<boolean>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<RemoteConnection>(() => connection ?? blankConnection());
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Server className="size-4" /> {connection ? "Edit SSH connection" : "New SSH connection"}
          </DialogTitle>
          <DialogDescription>
            Offered when a session in this project opens a remote files tab. No password or passphrase
            is saved — those are asked for when connecting.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex min-w-0 flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!draft.host.trim()) return;
            setBusy(true);
            const ok = await onSave(draft);
            setBusy(false);
            if (ok) onClose();
          }}
        >
          <RemoteConnectionFields value={draft} onChange={setDraft} idPrefix="saved" />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !draft.host.trim()}>
              {busy && <Loader2 className="mr-1 size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What a remote tab shows while it has no connection — after a restart of the app, or once the host
 * has refused it. Tries once by itself (an agent or an unencrypted key needs nothing typed) and then
 * asks for what is missing.
 */
export function RemoteReconnect({
  tabId,
  connection,
  error,
  auto = true,
  onConnected,
}: {
  tabId: string;
  connection: RemoteConnection;
  error?: string | null;
  /** Try once without asking. Off after the person disconnected on purpose. */
  auto?: boolean;
  onConnected: (home: string) => void;
}) {
  const connector = useRemoteConnector(tabId);
  const [tried, setTried] = useState(false);
  // A ref as well as the state: StrictMode runs the effect twice before the state update lands, and
  // two connects at once would open two connections for one tab.
  const triedRef = useRef(false);
  const { connect } = connector;

  useEffect(() => {
    if (triedRef.current) return;
    triedRef.current = true;
    setTried(true);
    if (!auto || connection.auth === "password") return; // nothing to try without the password
    void connect(connection).then((r) => r.status === "connected" && onConnected(r.home ?? "/"));
  }, [auto, connection, connect, onConnected]);

  return (
    <div className="flex h-full items-start justify-center overflow-auto p-6">
      <div className="flex w-full max-w-sm flex-col gap-4 rounded-lg border bg-card p-5 shadow-sm">
        <div className="flex min-w-0 items-center gap-2">
          <Server className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="truncate font-medium">{connection.name || connectionTarget(connection)}</div>
            <div className="truncate text-xs text-muted-foreground">{connectionTarget(connection)}</div>
          </div>
        </div>
        {!tried || (connector.busy && !connector.result) ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Connecting…
          </p>
        ) : (
          <>
            {error && !connector.result && <p className="text-sm text-muted-foreground">{error}</p>}
            <ConnectControls connection={connection} connector={connector} onConnected={onConnected} autoFocus />
          </>
        )}
      </div>
    </div>
  );
}
