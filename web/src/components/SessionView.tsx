import { useCallback, useEffect, useState } from "react";
import type { GitStatus, SessionInfo } from "@/types";
import { api } from "@/lib/api";
import { FileBrowser } from "./FileBrowser";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink, GitBranch, Loader2, Menu, PanelLeftOpen, Radio, Square } from "lucide-react";

function StateBadge({ state }: { state: SessionInfo["state"] }) {
  if (state === "Running") return <Badge variant="success">running</Badge>;
  if (state === "Exited") return <Badge variant="secondary">exited</Badge>;
  return <Badge variant="destructive">failed</Badge>;
}

export function SessionView({
  session,
  onToggleSidebar,
  collapsed,
  onToggleCollapsed,
  onStopped,
}: {
  session: SessionInfo;
  onToggleSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onStopped: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [git, setGit] = useState<GitStatus | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const bump = useCallback(() => setRefreshToken((t) => t + 1), []);
  const loadGit = useCallback(() => {
    api.gitStatus(session.id).then(setGit).catch(() => setGit(null));
  }, [session.id]);
  const onRefresh = useCallback(() => {
    bump();
    loadGit();
  }, [bump, loadGit]);

  // Auto-refresh: poll the working dir's change counter; when it moves, reload tree + git.
  useEffect(() => {
    setGit(null);
    loadGit();
    let last = -1;
    let stopped = false;
    const tick = async () => {
      try {
        const v = await api.fsVersion(session.id);
        if (stopped) return;
        if (v !== last) {
          if (last !== -1) {
            bump();
            loadGit();
          }
          last = v;
        }
      } catch {
        /* session gone / not ready */
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [session.id, loadGit, bump]);

  const changeCount = git?.isRepo ? Object.keys(git.files).length : 0;

  async function stop() {
    setBusy(true);
    try {
      await api.deleteSession(session.id);
      onStopped(session.id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onToggleSidebar}>
          <Menu className="size-5" />
        </Button>
        {collapsed && (
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            title="Show sidebar"
            onClick={onToggleCollapsed}
          >
            <PanelLeftOpen className="size-5" />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate font-semibold">{session.name}</h2>
            <StateBadge state={session.state} />
            {session.remoteControl && (
              <Badge variant="outline" className="hidden gap-1 sm:inline-flex">
                <Radio className="size-3" /> RC
              </Badge>
            )}
            {git?.isRepo && git.branch && (
              <Badge variant="outline" className="gap-1" title="Current git branch">
                <GitBranch className="size-3" />
                <span className="max-w-[10rem] truncate">{git.branch}</span>
                {changeCount > 0 && <span className="text-amber-500">·{changeCount}</span>}
              </Badge>
            )}
          </div>
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {session.workingDirectory}
            {session.model ? ` · ${session.model}` : ""} · pid {session.processId}
          </p>
        </div>

        {session.remoteControl && session.state === "Running" && (
          <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
            <a href="https://claude.ai/code" target="_blank" rel="noreferrer">
              <ExternalLink className="size-4" /> Open in app
            </a>
          </Button>
        )}
        <Button variant="destructive" size="sm" onClick={stop} disabled={busy}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Square className="size-4" />}
          <span className="hidden sm:inline">{session.state === "Running" ? "Stop" : "Remove"}</span>
        </Button>
      </header>

      {session.remoteControl && session.state === "Running" && (
        <div className="flex items-center gap-1.5 border-b bg-emerald-500/5 px-4 py-1.5 text-xs text-muted-foreground">
          <Radio className="size-3 text-emerald-500" />
          Registered for Remote Control — drive{" "}
          <span className="font-medium text-foreground">{session.name}</span> from the Claude Code app.
        </div>
      )}

      <div className="min-h-0 flex-1">
        <FileBrowser
          sessionId={session.id}
          gitFiles={git?.isRepo ? git.files : undefined}
          onRefresh={onRefresh}
          refreshToken={refreshToken}
        />
      </div>
    </div>
  );
}
