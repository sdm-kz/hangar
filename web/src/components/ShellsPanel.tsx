import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { SessionInfo, ShellInfo } from "@/types";
import { api } from "@/lib/api";
import { dirKey } from "@/lib/sessionOrder";
import { folderName } from "@/lib/recentFolders";
import { shellMark, shellMarkLabel, type ShellActivity } from "@/lib/shellActivity";
import { cn } from "@/lib/utils";
import { useConfirm } from "@/components/ui/confirm";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Bot, Folder, Loader2, Plus, Server, TerminalSquare, X } from "lucide-react";
import { ActivityMark } from "./ActivityMark";
import { FolderPicker } from "./FolderPicker";
import { shellIcon, shellTabLabel, useShellOptions } from "./ShellTabStrip";

/**
 * Every open shell on the server — the sessions', the folders' and the SSH connections — re-read
 * whenever the shell-set revision moves. Null until the first answer; a failed re-read keeps the
 * last list rather than emptying the tab over a blip.
 */
export function useAllShells(shellsRev: number, enabled: boolean): ShellInfo[] | null {
  const [shells, setShells] = useState<ShellInfo[] | null>(null);
  useEffect(() => {
    // Signed out (or not yet known to be signed in), there is nothing to ask for but a 401.
    if (!enabled) return;
    let cancelled = false;
    api
      .listShells()
      .then((list) => !cancelled && setShells(list))
      .catch(() => {
        /* keep what is on screen; the next revision re-reads */
      });
    return () => {
      cancelled = true;
    };
  }, [shellsRev, enabled]);
  return shells;
}

/** What fills the main area, as the Shells tab marks it: a folder's shells, the SSH view, a session. */
export type ShellsShown = { folder: string } | { ssh: true } | { sessionId: string } | null;

// The folder the "New shell" dialog last opened one in, so the next one starts there.
const LAST_FOLDER_KEY = "hangar.lastShellFolder";

function readLastFolder(): string {
  try {
    return localStorage.getItem(LAST_FOLDER_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberFolder(path: string) {
  try {
    localStorage.setItem(LAST_FOLDER_KEY, path);
  } catch {
    /* private window — the session's folder stands in next time */
  }
}

interface Group {
  key: string;
  shells: ShellInfo[];
}

/**
 * The sidebar's Shells tab: every shell there is, in one place. Folder shells and SSH connections
 * belong to nothing that has a row of its own, so without this they are lost the moment something
 * else takes the main area; the sessions' shells are listed too, under their session, so the tab
 * answers "what is running where" in full.
 *
 * A row brings its shell to the front wherever it lives: the folder's shell view, the SSH view, or
 * the session's own tab bar.
 */
export function ShellsPanel({
  shells,
  sessions,
  shellActivity,
  shellsSeen,
  shown,
  defaultFolder,
  onOpen,
  onOpenFolder,
  onSelectSession,
  onNewSsh,
}: {
  shells: ShellInfo[] | null;
  sessions: SessionInfo[];
  shellActivity: Record<string, ShellActivity> | null;
  shellsSeen: Record<string, number>;
  /** What the main area is showing, so its heading can be marked as the one on screen. */
  shown: ShellsShown;
  /** Where a new shell opens: the folder on screen (a folder's shells, or a session's). */
  defaultFolder?: string;
  /** Bring a shell to the front, wherever it lives. */
  onOpen: (shell: ShellInfo) => void;
  onOpenFolder: (folder: string) => void;
  onSelectSession: (id: string) => void;
  onNewSsh: () => void;
}) {
  const confirm = useConfirm();
  const [newOpen, setNewOpen] = useState(false);

  // Folders first (the shells only this tab can get you back to), then SSH, then the sessions'.
  const { folders, ssh, bySession } = useMemo(() => {
    const folders = new Map<string, Group>();
    const bySession = new Map<string, Group>();
    const ssh: ShellInfo[] = [];
    for (const s of shells ?? []) {
      if (s.sessionId) {
        const g = bySession.get(s.sessionId) ?? { key: s.sessionId, shells: [] };
        g.shells.push(s);
        bySession.set(s.sessionId, g);
      } else if (s.kind === "ssh") ssh.push(s);
      else {
        const k = dirKey(s.workingDirectory);
        const g = folders.get(k) ?? { key: s.workingDirectory, shells: [] };
        g.shells.push(s);
        folders.set(k, g);
      }
    }
    const byName = (a: Group, b: Group) => folderName(a.key).localeCompare(folderName(b.key));
    return { folders: [...folders.values()].sort(byName), ssh, bySession: [...bySession.values()] };
  }, [shells]);

  const sessionName = (id: string) => sessions.find((s) => s.id === id)?.name || "Session";
  const sessionGroups = useMemo(
    () =>
      [...bySession].sort((a, b) =>
        (sessions.find((s) => s.id === a.key)?.name ?? "").localeCompare(sessions.find((s) => s.id === b.key)?.name ?? "")
      ),
    [bySession, sessions]
  );

  const close = async (s: ShellInfo) => {
    // A row is easier to hit by mistake than a tab you are looking at, and closing one kills what
    // runs in it: ask when that is something — a command at work, or a connection to another machine.
    const busy = s.running && (shellActivity?.[s.id]?.running || s.kind === "ssh");
    if (
      busy &&
      !(await confirm({
        title: `Close ${shellTabLabel(s)}?`,
        description:
          s.kind === "ssh"
            ? `The connection to ${s.remote ?? "the host"} is closed.`
            : "What is running in it is stopped.",
        confirmLabel: "Close",
      }))
    )
      return;
    await api.closeShell(s.id).catch(() => {
      /* already gone — the list re-reads on the revision either way */
    });
  };

  const isShown = (what: ShellsShown) => JSON.stringify(what) === JSON.stringify(shown);
  const count = shells?.length ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1.5">
        <span className="mr-auto truncate px-1 text-xs text-muted-foreground">
          {shells === null ? "Loading…" : count === 0 ? "No shells open" : `${count} open`}
        </span>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" title="Open a shell in a folder" onClick={() => setNewOpen(true)}>
          <Plus className="size-4" /> Shell
        </Button>
        <Button variant="ghost" size="sm" className="h-7 gap-1 px-2" title="Open an SSH connection" onClick={onNewSsh}>
          <Server className="size-4" /> SSH
        </Button>
      </div>

      <div className="hover-scrollbar min-h-0 flex-1 overflow-y-auto py-1">
        {shells === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : count === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            Shells you open — in a folder, over SSH, or in a session — are listed here, and keep running when
            you look somewhere else.
          </p>
        ) : (
          <>
            {folders.length > 0 && <Section title="Folders" />}
            {folders.map((g) => (
              <div key={g.key}>
                <Heading
                  icon={<Folder className="size-4 shrink-0 text-sky-500" />}
                  title={folderName(g.key)}
                  detail={g.key}
                  current={!!shown && "folder" in shown && dirKey(shown.folder) === dirKey(g.key)}
                  onClick={() => onOpenFolder(g.key)}
                />
                {g.shells.map((s) => (
                  <Row key={s.id} shell={s} activity={shellActivity?.[s.id]} seen={shellsSeen[s.id]} onOpen={onOpen} onClose={close} />
                ))}
              </div>
            ))}

            {ssh.length > 0 && <Section title="SSH" />}
            {ssh.map((s) => (
              <Row
                key={s.id}
                shell={s}
                activity={shellActivity?.[s.id]}
                seen={shellsSeen[s.id]}
                detail={s.remote && s.remote !== s.label ? s.remote : undefined}
                flat
                current={isShown({ ssh: true })}
                onOpen={onOpen}
                onClose={close}
              />
            ))}

            {sessionGroups.length > 0 && <Section title="In sessions" />}
            {sessionGroups.map((g) => (
              <div key={g.key}>
                <Heading
                  icon={<Bot className="size-4 shrink-0 text-muted-foreground" />}
                  title={sessionName(g.key)}
                  detail={sessions.find((s) => s.id === g.key)?.workingDirectory}
                  current={isShown({ sessionId: g.key })}
                  onClick={() => onSelectSession(g.key)}
                />
                {g.shells.map((s) => (
                  <Row key={s.id} shell={s} activity={shellActivity?.[s.id]} seen={shellsSeen[s.id]} onOpen={onOpen} onClose={close} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      {newOpen && (
        <NewShellDialog
          defaultFolder={defaultFolder || readLastFolder()}
          onOpened={(s) => {
            setNewOpen(false);
            onOpen(s);
          }}
          onClose={() => setNewOpen(false)}
        />
      )}
    </div>
  );
}

function Section({ title }: { title: string }) {
  return (
    <div className="px-3 pb-0.5 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
  );
}

function Heading({
  icon,
  title,
  detail,
  current,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  detail?: string;
  current: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={detail}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-1 text-left text-sm hover:bg-accent",
        current && "bg-accent/60 font-medium"
      )}
    >
      {icon}
      <span className="min-w-0 truncate">{title}</span>
    </button>
  );
}

function Row({
  shell: s,
  activity,
  seen,
  detail,
  flat,
  current,
  onOpen,
  onClose,
}: {
  shell: ShellInfo;
  activity?: ShellActivity;
  seen?: number;
  /** A second line: where an SSH connection goes. */
  detail?: string;
  /** Not under a heading (the SSH section), so not indented under one. */
  flat?: boolean;
  current?: boolean;
  onOpen: (s: ShellInfo) => void;
  onClose: (s: ShellInfo) => void;
}) {
  const Icon = shellIcon(s.kind);
  const mark = shellMark(activity, seen);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(s)}
      onKeyDown={(e) => {
        // Not for keys meant for the close button inside the row.
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onOpen(s);
      }}
      onMouseDown={(e) => {
        // Middle-click closes, as it does on a tab.
        if (e.button === 1) {
          e.preventDefault();
          onClose(s);
        }
      }}
      title={`${s.label} — ${s.remote ?? s.workingDirectory}${s.running ? "" : " (exited)"}`}
      className={cn(
        "group/row flex w-full min-w-0 cursor-pointer items-center gap-2 py-1 pr-2 text-left text-sm hover:bg-accent",
        flat ? "pl-3" : "pl-9",
        current && "bg-accent/60"
      )}
    >
      <span className="relative shrink-0">
        <Icon className="size-4 text-muted-foreground" />
        {mark && activity && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 rounded-full bg-background leading-none">
            <ActivityMark activity={mark} label={shellMarkLabel(mark, activity)} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", !s.running && "line-through opacity-60")}>{shellTabLabel(s)}</span>
        {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
      </span>
      {!s.running && <span className="shrink-0 text-xs text-muted-foreground">exited</span>}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClose(s);
        }}
        title="Close shell"
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-0 hover:bg-background hover:text-foreground focus:opacity-100 group-hover/row:opacity-100 max-md:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/**
 * Open a shell in any folder on the server: the folder (the one on screen, else where this browser
 * last opened one) and which shell. It opens as that folder's shell, the same as the Files tree's
 * terminal action, so it is found again under the folder's heading.
 */
function NewShellDialog({
  defaultFolder,
  onOpened,
  onClose,
}: {
  defaultFolder: string;
  onOpened: (shell: ShellInfo) => void;
  onClose: () => void;
}) {
  const [dir, setDir] = useState(defaultFolder);
  const options = useShellOptions(true);
  const [shell, setShell] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picked = shell ?? options.preferred ?? "";

  const submit = async () => {
    if (!dir.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createShell({ workingDirectory: dir.trim(), shell: picked || undefined });
      rememberFolder(dir.trim());
      if (picked) options.remember(picked);
      onOpened(created);
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
            <TerminalSquare className="size-4" /> New shell
          </DialogTitle>
          <DialogDescription>
            A shell in a folder on this machine. It keeps running when you look elsewhere, and is listed in
            the Shells tab under its folder.
          </DialogDescription>
        </DialogHeader>
        {/* Not a form: Enter in the folder picker opens the highlighted folder, and must not open the shell. */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="space-y-1.5">
            <Label>Folder</Label>
            <FolderPicker value={dir} onChange={setDir} />
          </div>
          <div className="space-y-1.5">
            <Label>Shell</Label>
            {options.failed ? (
              <p className="text-sm text-muted-foreground">Could not read the shell list; the default opens.</p>
            ) : options.options === null ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Looking for shells…
              </div>
            ) : (
              <div role="radiogroup" className="flex flex-wrap gap-1.5">
                {options.options.map((o) => {
                  const Icon = shellIcon(o.kind);
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={picked === o.id}
                      title={o.detail}
                      onClick={() => setShell(o.id)}
                      className={cn(
                        "flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent",
                        picked === o.id && "border-primary bg-primary/10"
                      )}
                    >
                      <Icon className="size-3.5" />
                      {o.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="button" onClick={() => void submit()} disabled={!dir.trim() || busy}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              Open
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}
