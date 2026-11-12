import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ClaudeHooksStatus, Project, UpdateStatus } from "@/types";
import { NodeProvider, useApi } from "@/lib/node";
import { sessionColor } from "@/lib/sessionColors";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ProjectGlyph } from "./ProjectGlyph";
import { SetPasswordDialog } from "./PasswordNotice";
import { BuildLine, UpdateButton } from "./UpdateButton";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, LogOut, MinusCircle, Plus } from "lucide-react";

/** The shortest password the server takes from the page (MinPasswordLength in server/Program.cs). */
const MIN_LENGTH = 8;

const message = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

/**
 * Settings → Projects: every project on the picked node, as a list. Editing one is still the project's
 * own dialog, the same the gear on its sidebar heading opens; its tabs inside these would be a maze.
 */
export function ProjectsPanel({ projects, onEdit }: { projects: Project[]; onEdit: (id: string | null) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <section className="flex flex-col gap-2" data-setting="projects.list">
        {projects.length === 0 ? (
          <p className="text-xs text-muted-foreground">No projects here yet.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {projects.map((p) => (
              <li key={p.id} data-setting={`project:${p.id}`}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                  title="Project settings"
                  onClick={() => onEdit(p.id)}
                >
                  <ProjectGlyph project={p} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {count(p.folders.length, "folder")} · {count(p.repos.length, "repository", "repositories")}
                      {p.groups.length > 0 && ` · ${count(p.groups.length, "group")}`}
                    </span>
                  </span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <div data-setting="projects.new">
        <Button size="sm" variant="outline" onClick={() => onEdit(null)}>
          <Plus className="size-3.5" />
          New project
        </Button>
      </div>
    </div>
  );
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Settings → Security: this node's password — set the first, or change the one there is — and signing
 * out. Always this node's: /api/auth is never relayed to another (NodeProxy.LocalOnly), and a peer's
 * password is changed by signing in to that peer.
 */
export function SecurityPanel({ onLogout }: { onLogout: () => void }) {
  // This node's, since Settings draws this tab outside any NodeProvider.
  const api = useApi();
  const [config, setConfig] = useState<{ authRequired: boolean; canSetPassword?: boolean } | null>(null);
  const [setting, setSetting] = useState(false);
  const load = useCallback(() => {
    api.authConfig().then(setConfig, () => setConfig({ authRequired: true }));
  }, [api]);
  useEffect(load, [load]);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2" data-setting="security.password">
        <h3 className="text-sm font-medium">Password</h3>
        {!config ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : config.canSetPassword ? (
          <>
            <p className="text-xs text-muted-foreground">
              None is set. Hangar answers only this computer until it has one, and needs one to be opened from
              your phone or another machine.
            </p>
            <div>
              <Button size="sm" variant="outline" onClick={() => setSetting(true)}>
                Set a password…
              </Button>
            </div>
          </>
        ) : config.authRequired ? (
          <ChangePassword />
        ) : (
          <p className="text-xs text-muted-foreground">None is set. It can be set from a browser on this machine.</p>
        )}
      </section>

      <section className="flex flex-col gap-2" data-setting="security.signout">
        <h3 className="text-sm font-medium">Sign out</h3>
        <p className="text-xs text-muted-foreground">This browser only. Changing the password signs out all the others.</p>
        <div>
          <Button size="sm" variant="outline" onClick={onLogout}>
            <LogOut className="size-3.5" />
            Sign out
          </Button>
        </div>
      </section>

      {setting && <SetPasswordDialog onClose={() => setSetting(false)} onSet={load} />}
    </div>
  );
}

/** Behind a button: three empty boxes are a lot of page for something done once a year. */
function ChangePassword() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length < MIN_LENGTH;
  const mismatch = repeat.length > 0 && repeat !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!current || tooShort || repeat !== password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.changePassword(current, password);
      setCurrent("");
      setPassword("");
      setRepeat("");
      setDone(true);
      setOpen(false);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = () => {
    setCurrent("");
    setPassword("");
    setRepeat("");
    setError(null);
    setOpen(false);
  };

  if (!open)
    return (
      <>
        {done && <p className="text-xs text-muted-foreground">Changed. Other browsers sign in with the new one.</p>}
        <div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDone(false);
              setOpen(true);
            }}
          >
            Change password…
          </Button>
        </div>
      </>
    );

  return (
    <form onSubmit={submit} className="flex max-w-sm flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Every other browser and device is signed out and asks for the new one; this one stays in. Paired nodes
        keep working: they hold a token of their own, not the password.
      </p>
      {/* For password managers: the account the password is for. */}
      <input type="text" name="username" autoComplete="username" value="hangar" readOnly hidden />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="current-password">Current password</Label>
        <Input
          id="current-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="changed-password">New password</Label>
        <Input
          id="changed-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">At least {MIN_LENGTH} characters.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="changed-password-again">Again</Label>
        <Input
          id="changed-password-again"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          aria-invalid={mismatch || undefined}
        />
        {mismatch && <p className="text-xs text-destructive">The two don't match.</p>}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !current || tooShort || repeat !== password}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          Change password
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={cancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const HOOKS_DOCS = "https://github.com/sdm-kz/hangar/blob/main/docs/troubleshooting.md";

/**
 * Settings → Hooks: whether Claude's hooks report to the picked node, whatever the answer — the strip
 * under the sidebar's header shows only the bad ones, and only this node's.
 */
export function HooksPanel() {
  const api = useApi();
  const confirm = useConfirm();
  const [status, setStatus] = useState<ClaudeHooksStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getClaudeHooks().then(setStatus, (e) => setError(message(e)));
  }, [api]);

  const takeOver = async () => {
    if (!status || status.state !== "elsewhere") return;
    const ok = await confirm({
      title: "Take Claude's hooks over?",
      description: `Sessions of the one on port ${status.ownerPort} then stop reporting to it. Sessions already running keep the hooks they started with until they are restarted.`,
      confirmLabel: "Take them over",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.takeOverClaudeHooks();
      setStatus(next);
      if (next.state !== "ours") setError("They could not be moved here; see the server log.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-2" data-setting="hooks.status">
      <p className="text-xs text-muted-foreground">
        Claude Code's hooks tell Hangar what a session is doing — working, waiting on you, asking for a
        permission — and let the chat follow a <code>/clear</code>. Without them, status is read off the
        terminal.{" "}
        <a href={HOOKS_DOCS} target="_blank" rel="noreferrer" className="underline underline-offset-2">
          More
        </a>
      </p>
      {!status ? (
        !error && <Loader2 className="size-4 animate-spin text-muted-foreground" />
      ) : status.state === "ours" ? (
        <p className="flex items-center gap-1.5 text-sm">
          <CheckCircle2 className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
          They report here (port {status.port}).
        </p>
      ) : status.state === "off" ? (
        <p className="flex items-center gap-1.5 text-sm">
          <MinusCircle className="size-4 shrink-0 text-muted-foreground" />
          Switched off here (Hooks:Enabled is false).
        </p>
      ) : status.state === "failed" ? (
        <p className="flex items-center gap-1.5 text-sm">
          <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
          They could not be registered in ~/.claude/settings.json; see the server log.
        </p>
      ) : (
        <>
          <p className="flex items-center gap-1.5 text-sm">
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            They report to {status.ownerIsHangar ? "another Hangar" : "another program"} on port {status.ownerPort}, not
            to this one.
          </p>
          <div>
            <Button size="sm" variant="outline" disabled={busy} onClick={takeOver}>
              {busy && <Loader2 className="size-3.5 animate-spin" />}
              Use this Hangar…
            </Button>
          </div>
        </>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </section>
  );
}

/** A node's line in Settings → Updates. */
export interface NodeUpdate {
  id: string | null;
  name: string;
  color: string | null;
  /** Null while the node can't be reached, or before its first snapshot. */
  status: UpdateStatus | null;
  online: boolean;
}

/**
 * Settings → Updates: every node's running build and what is waiting for it, on one page — the one place
 * a peer that has fallen behind can't hide behind the heading it is folded under. Each Update is that
 * node's own (plans/multi-node.md §8).
 */
export function UpdatesPanel({ nodes, onApplying }: { nodes: NodeUpdate[]; onApplying: (buildId: string) => void }) {
  return (
    <ul className="flex flex-col divide-y rounded-md border" data-setting="updates.list">
      {nodes.map((n) => {
        const accent = sessionColor(n.color);
        const s = n.status;
        return (
          <li key={n.id ?? ""} className="flex items-start gap-3 px-3 py-2.5 text-sm" data-setting={`update:${n.id ?? ""}`}>
            <span
              className="mt-1.5 size-2.5 shrink-0 rounded-full border"
              style={accent ? { backgroundColor: accent, borderColor: accent } : undefined}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{n.name}</div>
              {!n.online ? (
                <p className="text-xs text-muted-foreground">Not reachable right now.</p>
              ) : !s ? (
                <p className="text-xs text-muted-foreground">Not known yet.</p>
              ) : (
                <>
                  <div className="text-muted-foreground">{s.current ? <BuildLine stamp={s.current} /> : "Unknown build"}</div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {s.state === "Applying"
                      ? "Installing…"
                      : s.state === "Failed"
                        ? `The last update failed${s.error ? `: ${s.error}` : ""}.`
                        : s.available
                          ? "A newer build is waiting."
                          : !s.enabled
                            ? "The updater is off here (Update:Enabled)."
                            : "Up to date."}
                  </p>
                </>
              )}
            </div>
            {n.online && s?.available && s.state !== "Applying" && (
              <NodeProvider node={n.id}>
                {n.id ? (
                  <UpdateButton status={s} nodeName={n.name} compact={false} />
                ) : (
                  <UpdateButton status={s} onApplying={onApplying} />
                )}
              </NodeProvider>
            )}
          </li>
        );
      })}
    </ul>
  );
}
