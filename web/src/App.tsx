import { useCallback, useEffect, useState } from "react";
import { api, getToken, setToken } from "@/lib/api";
import { type RecentSession } from "@/lib/recentSessions";
import { migrateLegacyRecents } from "@/lib/migrateRecents";
import { readUrlState, patchUrlState } from "@/lib/urlState";
import type { SessionInfo } from "@/types";
import { Login } from "@/components/Login";
import { SessionSidebar } from "@/components/SessionSidebar";
import { SessionView } from "@/components/SessionView";
import { NewSessionDialog } from "@/components/NewSessionDialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Bot, Loader2, Menu, PanelLeftOpen, Plus } from "lucide-react";

type AuthStatus = "loading" | "authed" | "anon";

export function App() {
  const [auth, setAuth] = useState<AuthStatus>("loading");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeId, setActiveId] = useState<string | null>(() => readUrlState().session ?? null);
  const [newOpen, setNewOpen] = useState(false);
  const [newPreset, setNewPreset] = useState<RecentSession | null>(null);
  const [recents, setRecents] = useState<RecentSession[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false); // mobile drawer
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("claudeweb.sidebarCollapsed") === "1"
  ); // desktop sidebar collapsed

  const toggleCollapsed = () =>
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem("claudeweb.sidebarCollapsed", next ? "1" : "0");
      return next;
    });

  // Determine whether we're authenticated (or auth is disabled) on load.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await api.authConfig();
        if (!cfg.authRequired) {
          setToken("dev"); // any token passes when auth is disabled
          setAuth("authed");
        } else {
          setAuth(getToken() ? "authed" : "anon");
        }
      } catch {
        setAuth(getToken() ? "authed" : "anon");
      }
    })();
  }, []);

  const loadRecents = useCallback(async () => {
    try {
      const r = await api.getRecents();
      setRecents(r.sessions);
    } catch {
      /* ignore — recents are non-critical */
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
      // Keep a valid current selection (e.g. restored from the URL); otherwise auto-select the
      // first live session, never a Restorable placeholder (it has no terminal yet).
      setActiveId((cur) =>
        cur && list.some((s) => s.id === cur)
          ? cur
          : list.find((s) => s.state !== "Restorable")?.id ?? null
      );
    } catch {
      // 401 handled by api layer clearing token; flip to login.
      if (!getToken()) setAuth("anon");
    }
  }, []);

  // Mirror the active session into the URL so a refresh/shared link restores it.
  useEffect(() => {
    patchUrlState({ session: activeId ?? undefined });
  }, [activeId]);

  // Poll the session list so state badges (running/exited) stay fresh.
  useEffect(() => {
    if (auth !== "authed") return;
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [auth, refresh]);

  // Load the server-backed recents once authed, migrating any left over in this browser's
  // localStorage from older builds first.
  useEffect(() => {
    if (auth !== "authed") return;
    (async () => {
      await migrateLegacyRecents().catch(() => {});
      loadRecents();
    })();
  }, [auth, loadRecents]);

  // A Restorable entry has no live terminal, so never treat it as the active view.
  const active = sessions.find((s) => s.id === activeId && s.state !== "Restorable") ?? null;

  function openNew(preset: RecentSession | null = null) {
    setNewPreset(preset);
    setNewOpen(true);
  }

  function reuseRecent(r: RecentSession) {
    openNew(r);
    setSidebarOpen(false);
  }

  async function removeRecent(r: RecentSession) {
    const next = await api.removeRecentSession(r).catch(() => null);
    if (next) setRecents(next.sessions);
  }

  function onCreated(s: SessionInfo) {
    setSessions((prev) => [...prev, s]);
    setActiveId(s.id);
    setSidebarOpen(false);
    loadRecents(); // the dialog just saved this launch as a recent preset (server-side)
  }

  async function onClose(id: string) {
    await api.deleteSession(id).catch(() => {});
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setActiveId((cur) => (cur === id ? null : cur));
  }

  // Reopen a Restorable session: it relaunches with --continue and returns a fresh live session.
  async function onRestore(id: string) {
    const created = await api.restoreSession(id).catch(() => null);
    if (!created) return;
    setSessions((prev) => [...prev.filter((s) => s.id !== id), created]);
    setActiveId(created.id);
    setSidebarOpen(false);
  }

  async function onLogout() {
    await api.logout();
    setAuth("anon");
    setSessions([]);
    setActiveId(null);
  }

  if (auth === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (auth === "anon") {
    return <Login onSuccess={() => setAuth("authed")} />;
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Sidebar: static column on desktop (collapsible), slide-over drawer on mobile. */}
      <aside className={cn("hidden w-72 shrink-0 border-r md:block", collapsed && "md:hidden")}>
        <SessionSidebar
          sessions={sessions}
          activeId={activeId}
          onSelect={setActiveId}
          onNew={() => openNew()}
          onClose={onClose}
          onRestore={onRestore}
          onLogout={onLogout}
          onCollapse={toggleCollapsed}
          recents={recents}
          onReuse={reuseRecent}
          onRemoveRecent={removeRecent}
        />
      </aside>

      {sidebarOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setSidebarOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-72 border-r shadow-xl">
            <SessionSidebar
              sessions={sessions}
              activeId={activeId}
              onSelect={(id) => {
                setActiveId(id);
                setSidebarOpen(false);
              }}
              onNew={() => {
                openNew();
                setSidebarOpen(false);
              }}
              onClose={onClose}
              onRestore={onRestore}
              onLogout={onLogout}
              recents={recents}
              onReuse={reuseRecent}
              onRemoveRecent={removeRecent}
            />
          </aside>
        </div>
      )}

      <main className="min-w-0 flex-1">
        {active ? (
          <SessionView
            session={active}
            onToggleSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
            onStopped={(id) => setSessions((prev) => prev.filter((s) => s.id !== id))}
          />
        ) : (
          <EmptyState
            onNew={() => openNew()}
            onOpenSidebar={() => setSidebarOpen(true)}
            collapsed={collapsed}
            onToggleCollapsed={toggleCollapsed}
          />
        )}
      </main>

      <NewSessionDialog
        open={newOpen}
        onOpenChange={(o) => {
          setNewOpen(o);
          if (!o) setNewPreset(null); // clear preset so the next plain "New session" starts fresh
        }}
        onCreated={onCreated}
        preset={newPreset}
      />
    </div>
  );
}

function EmptyState({
  onNew,
  onOpenSidebar,
  collapsed,
  onToggleCollapsed,
}: {
  onNew: () => void;
  onOpenSidebar: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  return (
    <div className={cn("flex h-full flex-col")}>
      <header className={cn("flex items-center gap-2 border-b px-3 py-2.5", !collapsed && "md:hidden")}>
        <Button variant="ghost" size="icon" className="md:hidden" onClick={onOpenSidebar}>
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
        <span className="font-semibold">Claude Web</span>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground">
          <Bot className="size-7" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">No session selected</h2>
          <p className="text-sm text-muted-foreground">Start a Claude Code session in a working folder.</p>
        </div>
        <Button onClick={onNew}>
          <Plus className="size-4" /> New session
        </Button>
      </div>
    </div>
  );
}
