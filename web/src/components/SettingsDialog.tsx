import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Project, ScheduleEntry, SessionInfo } from "@/types";
import { apiFor } from "@/lib/api";
import { NodeProvider } from "@/lib/node";
import {
  SETTINGS_INDEX,
  searchSettings,
  type SettingsEntry,
  type SettingsScope,
  type SettingsTab,
} from "@/lib/settings";
import { listThemes } from "@/lib/theme";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NodePicker, type LaunchNode } from "./NodePicker";
import { NodesPanel } from "./NodesPanel";
import { NotificationsPanel } from "./NotificationToggle";
import { ProjectDialog } from "./ProjectDialog";
import { SchedulesPanel } from "./ScheduleDialog";
import { HooksPanel, ProjectsPanel, SecurityPanel, UpdatesPanel, type NodeUpdate } from "./SettingsPanels";
import { ThemePanel } from "./ThemePanel";
import {
  ArrowUpCircle,
  Bell,
  Boxes,
  CalendarClock,
  KeyRound,
  Network,
  Palette,
  Search,
  Settings,
  Webhook,
  type LucideIcon,
} from "lucide-react";

interface TabInfo {
  id: SettingsTab;
  label: string;
  Icon: LucideIcon;
  scope: SettingsScope;
  /** Under the tab's heading; a panel that says it better itself has none. */
  description?: string;
}

const TABS: TabInfo[] = [
  { id: "appearance", label: "Appearance", Icon: Palette, scope: "browser" },
  { id: "notifications", label: "Notifications", Icon: Bell, scope: "browser" },
  {
    id: "nodes",
    label: "Nodes",
    Icon: Network,
    scope: "self",
    description:
      "Other machines running Hangar. A paired node can do anything on this one that you can — run a shell, read and write files — so pair only machines you would give your password to.",
  },
  {
    id: "projects",
    label: "Projects",
    Icon: Boxes,
    scope: "node",
    description: "Folders, repositories, groups and templates under one name. Each opens its own settings.",
  },
  { id: "schedules", label: "Schedules", Icon: CalendarClock, scope: "node" },
  { id: "security", label: "Security", Icon: KeyRound, scope: "self", description: "Who can sign in to this node." },
  { id: "hooks", label: "Hooks", Icon: Webhook, scope: "node" },
  {
    id: "updates",
    label: "Updates",
    Icon: ArrowUpCircle,
    scope: "all",
    description: "What each node runs, and what is waiting to be installed.",
  },
];

const tabInfo = (id: SettingsTab) => TABS.find((t) => t.id === id)!;
const tabLabel = (id: SettingsTab) => tabInfo(id).label;

/** Tailwind's `sm`: where the tabs become a column, and the search box takes focus on opening. */
const WIDE_QUERY = "(min-width: 640px)";

// What a setting found by search wears for a moment once it is scrolled to. Spelled out in full so
// Tailwind generates them.
const FLASH = ["ring-2", "ring-primary", "ring-offset-2", "ring-offset-background", "rounded-md"];

/**
 * Settings: one place for everything global — how it looks, notifications, the nodes, projects, schedules,
 * the password, Claude's hooks and updates — with a search box over all of it (docs/design/settings.md).
 * The controls used in passing stay where they were (the project gear, Schedules, the light/dark switch,
 * the bell, Update, the strips under the header); this is the place to administer the lot in one sitting.
 *
 * Laid out as the project dialog is: tabs down the left, a strip across the top on a phone, and changes
 * saved as they are made. Tabs about a node (Projects, Schedules, Hooks) pick which one at the top and draw
 * inside its NodeProvider; Nodes and Security are always this node's, and Updates lists every node.
 */
export function SettingsDialog({
  initialTab = "appearance",
  initialSetting,
  onClose,
  selfName,
  nodes,
  projectsOf,
  onProjectsChange,
  sessionsOf,
  updates,
  onApplying,
  onLogout,
}: {
  initialTab?: SettingsTab;
  /** Scrolled to and flashed once the tab shows it — a `data-setting` id. */
  initialSetting?: string;
  onClose: () => void;
  selfName: string;
  /** The machines, this one first, as the schedule picker offers them. */
  nodes: LaunchNode[];
  projectsOf: (node: string | null) => Project[];
  onProjectsChange: (node: string | null, projects: Project[]) => void;
  sessionsOf: (node: string | null) => SessionInfo[];
  updates: NodeUpdate[];
  onApplying: (buildId: string) => void;
  onLogout: () => void;
}) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  // The node the node-scoped tabs show, kept as you move between them.
  const [node, setNode] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // The setting to bring into view once its tab (and node) has drawn it.
  const [target, setTarget] = useState<string | null>(initialSetting ?? null);
  // The project whose own dialog is open over this one; id null for a new one.
  const [editing, setEditing] = useState<{ node: string | null; id: string | null } | null>(null);
  const [tabsVertical, setTabsVertical] = useState(() => window.matchMedia(WIDE_QUERY).matches);
  const searchRef = useRef<HTMLInputElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mq = window.matchMedia(WIDE_QUERY);
    const on = () => setTabsVertical(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const multi = nodes.length > 1;
  const nodeName = (id: string | null) => nodes.find((n) => n.id === id)?.name ?? selfName;

  // Schedules are the one live thing not already in hand: asked of every reachable node the first time
  // something is typed, so a schedule can be found by name from any tab.
  const [schedules, setSchedules] = useState<{ node: string | null; entry: ScheduleEntry }[] | null>(null);
  const searching = query.trim() !== "";
  const searchingRef = useRef(searching);
  searchingRef.current = searching;
  const reachable = nodes.filter((n) => !n.unavailable).map((n) => n.id);
  const reachableKey = reachable.join(",");
  // Asked afresh for each search, and when a node comes or goes: a schedule made, renamed or deleted on
  // the Schedules tab since the last one should be found as it is now.
  useEffect(() => {
    if (!searching) setSchedules(null);
  }, [searching, reachableKey]);
  useEffect(() => {
    if (!searching || schedules) return;
    let gone = false;
    void Promise.all(
      reachable.map((id) =>
        apiFor(id)
          .getSchedules()
          .then(
            (list) => list.map((entry) => ({ node: id, entry })),
            () => []
          )
      )
    ).then((found) => !gone && setSchedules(found.flat()));
    return () => {
      gone = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, schedules, reachableKey]);

  // The index: the settings themselves, then what is live — projects, nodes, themes, schedules.
  const entries = useMemo<SettingsEntry[]>(() => {
    const live: SettingsEntry[] = [];
    for (const n of nodes)
      for (const p of projectsOf(n.id))
        live.push({
          id: `project:${p.id}`,
          tab: "projects",
          title: p.name,
          detail: multi ? `Project on ${n.name}` : undefined,
          keywords: ["project"],
          node: n.id,
          project: p.id,
        });
    live.push({ id: "nodes.self", tab: "nodes", title: selfName, detail: "This node", keywords: ["node", "machine"] });
    for (const n of nodes)
      if (n.id) live.push({ id: `node:${n.id}`, tab: "nodes", title: n.name, detail: "Paired node", keywords: ["node", "machine"] });
    for (const t of listThemes())
      live.push({
        id: `theme:${t.id}`,
        tab: "appearance",
        title: t.name,
        detail: t.kind === "light" ? "Light theme" : "Dark theme",
        keywords: ["theme"],
      });
    for (const { node: on, entry } of schedules ?? [])
      live.push({
        id: `schedule:${entry.schedule.id}`,
        tab: "schedules",
        title: entry.schedule.name,
        detail: multi ? `Schedule on ${nodeName(on)}` : undefined,
        keywords: ["schedule"],
        node: on,
      });
    return [...SETTINGS_INDEX, ...live];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, projectsOf, schedules, selfName, multi]);

  const hits = useMemo(() => searchSettings(query, entries, tabLabel), [query, entries]);
  useEffect(() => setActive(0), [query]);
  // On a phone the tabs are a strip that scrolls sideways: keep the one showing in view, wherever it
  // was picked from (a search hit, a deep link).
  useEffect(() => {
    tabsRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab, searching]);

  const pick = (entry: SettingsEntry) => {
    setQuery("");
    setTab(entry.tab);
    if (entry.node !== undefined && tabInfo(entry.tab).scope === "node") setNode(entry.node);
    if (entry.project) setEditing({ node: entry.node ?? null, id: entry.project });
    setTarget(entry.id);
  };

  // Bring the target into view once it is there: a panel can still be loading what it marks (the
  // node list, the schedules), so look again for a moment before giving up.
  useEffect(() => {
    if (!target || searching) return;
    let timer = 0;
    let tries = 0;
    const find = () => {
      const el = panelRef.current?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(target)}"]`);
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
        el.classList.add(...FLASH);
        window.setTimeout(() => el.classList.remove(...FLASH), 1600);
        setTarget(null);
      } else if (++tries < 60) timer = window.setTimeout(find, 50);
      else setTarget(null);
    };
    find();
    return () => window.clearTimeout(timer);
  }, [target, tab, node, searching]);

  // Up/Down (Left/Right on a phone, where the list runs across the top) move between tabs; Home/End
  // jump to the ends — as in the project dialog.
  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const step =
      e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" || e.key === "ArrowLeft" ? -1 : 0;
    let next = i;
    if (step) next = (i + step + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[next].id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searching) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (hits.length) setActive((a) => (a + (e.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = hits[active];
      if (hit) pick(hit.entry);
    }
  };

  const info = tabInfo(tab);
  const scopeLine =
    info.scope === "browser"
      ? "This browser"
      : info.scope === "self"
        ? `This node · ${selfName}`
        : info.scope === "node"
          ? `${node === null ? "This node" : "Node"} · ${nodeName(node)}`
          : "Every node";

  const editingList = editing ? projectsOf(editing.node) : [];
  const editingProject = editing?.id ? (editingList.find((p) => p.id === editing.id) ?? null) : null;

  return (
    <>
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        {/* One fixed height whichever tab shows, as the project dialog: a dialog that resizes as you go
            down its tabs moves them out from under the pointer. */}
        <DialogContent
          className="h-[min(42rem,calc(100dvh-2rem))] max-w-4xl grid-rows-[auto_auto_minmax(0,1fr)] gap-3 p-4 sm:p-6"
          // On a phone the keyboard would cover the panel, so focus starts on the tab instead.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (window.matchMedia(WIDE_QUERY).matches) searchRef.current?.focus();
            else tabsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
          }}
          // Esc clears the search first, and closes Settings only once it is empty. Read through a ref:
          // Radix keeps calling the handler it was first given, which saw an empty box.
          onEscapeKeyDown={(e) => {
            if (!searchingRef.current) return;
            e.preventDefault();
            setQuery("");
          }}
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Settings className="size-4 shrink-0" />
              Settings
            </DialogTitle>
            <DialogDescription className="sr-only">Everything global, in one place.</DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              placeholder="Search settings…"
              aria-label="Search settings"
              aria-controls="settings-results"
              aria-activedescendant={searching && hits[active] ? `settings-hit-${active}` : undefined}
              className="pl-8"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
            />
          </div>

          {searching && <Results hits={hits} active={active} onActive={setActive} onPick={pick} />}
          {/* Hidden rather than unmounted while the results show: a half-made schedule, a node name
              not yet saved or a password half typed survive a look at the search. */}
          <div className={cn("flex min-h-0 flex-col gap-3 sm:flex-row sm:gap-4", searching && "hidden")}>
            <div
              ref={tabsRef}
              role="tablist"
              aria-orientation={tabsVertical ? "vertical" : "horizontal"}
              aria-label="Settings"
              onKeyDown={onTabKey}
              className="-m-1 flex shrink-0 gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:m-0 sm:w-44 sm:flex-col sm:overflow-visible sm:border-r sm:p-0 sm:pr-3"
            >
              {TABS.map((t) => {
                const on = t.id === tab;
                return (
                  <button
                    key={t.id}
                    type="button"
                    role="tab"
                    id={`settings-tab-${t.id}`}
                    aria-selected={on}
                    aria-controls={`settings-panel-${t.id}`}
                    tabIndex={on ? 0 : -1}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
                      on ? "bg-accent font-medium text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                    )}
                  >
                    <t.Icon className="size-4 shrink-0" />
                    <span className="truncate sm:flex-1">{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* The panel is what scrolls. -mx-1 px-1 gives the focus rings of controls flush with
                its edge a gutter the scroller would otherwise clip (see ProjectDialog). */}
            <div
              ref={panelRef}
              role="tabpanel"
              id={`settings-panel-${tab}`}
              aria-labelledby={`settings-tab-${tab}`}
              className="-mx-1 flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-1 pb-1"
            >
              <div className="flex flex-col gap-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <h3 className="font-medium">{info.label}</h3>
                  <span className="text-xs text-muted-foreground">{scopeLine}</span>
                </div>
                {info.description && <p className="text-xs text-muted-foreground">{info.description}</p>}
              </div>

              {info.scope === "node" && tab !== "schedules" && multi && (
                <NodePicker nodes={nodes} value={node} onChange={setNode} />
              )}

              <Panel
                tab={tab}
                node={node}
                onNodeChange={setNode}
                nodes={nodes}
                projectsOf={projectsOf}
                sessionsOf={sessionsOf}
                onEditProject={(id) => setEditing({ node, id })}
                updates={updates}
                onApplying={onApplying}
                onLogout={onLogout}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Over Settings, in the project's node — the very dialog the gear on its heading opens. Resolved
          from the live list, so a project deleted meanwhile just closes it. */}
      {editing && (editing.id === null || editingProject) && (
        <NodeProvider node={editing.node}>
          <ProjectDialog
            project={editingProject}
            projects={editingList}
            onSaved={(list) => onProjectsChange(editing.node, list)}
            onClose={() => setEditing(null)}
          />
        </NodeProvider>
      )}
    </>
  );
}

function Panel({
  tab,
  node,
  onNodeChange,
  nodes,
  projectsOf,
  sessionsOf,
  onEditProject,
  updates,
  onApplying,
  onLogout,
}: {
  tab: SettingsTab;
  node: string | null;
  onNodeChange: (node: string | null) => void;
  nodes: LaunchNode[];
  projectsOf: (node: string | null) => Project[];
  sessionsOf: (node: string | null) => SessionInfo[];
  onEditProject: (id: string | null) => void;
  updates: NodeUpdate[];
  onApplying: (buildId: string) => void;
  onLogout: () => void;
}) {
  switch (tab) {
    case "appearance":
      return <ThemePanel />;
    case "notifications":
      return <NotificationsPanel />;
    case "nodes":
      return <NodesPanel />;
    case "projects":
      return <ProjectsPanel key={node ?? ""} projects={projectsOf(node)} onEdit={onEditProject} />;
    case "schedules":
      return (
        // Keyed by the node: nothing of one machine's list stays on screen while the next one's loads.
        <NodeProvider node={node}>
          <div className="flex min-h-0 flex-col gap-3" data-setting="schedules.list">
            <SchedulesPanel
              key={node ?? ""}
              sessions={sessionsOf(node)}
              nodes={nodes}
              node={node}
              onNodeChange={onNodeChange}
              heading={(title, description) => (
                <div className="flex flex-col gap-0.5">
                  {title !== "Schedules" && <h4 className="text-sm font-medium">{title}</h4>}
                  <p className="text-xs text-muted-foreground">{description}</p>
                </div>
              )}
            />
          </div>
        </NodeProvider>
      );
    case "security":
      return <SecurityPanel onLogout={onLogout} />;
    case "hooks":
      return (
        <NodeProvider node={node}>
          <HooksPanel key={node ?? ""} />
        </NodeProvider>
      );
    case "updates":
      return <UpdatesPanel nodes={updates} onApplying={onApplying} />;
  }
}

/** The search's hits, in place of the tabs and the panel while there is something typed. */
function Results({
  hits,
  active,
  onActive,
  onPick,
}: {
  hits: ReturnType<typeof searchSettings>;
  active: number;
  onActive: (i: number) => void;
  onPick: (entry: SettingsEntry) => void;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`#settings-hit-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (hits.length === 0)
    return (
      <div className="flex flex-col items-center gap-1 py-10 text-center text-sm text-muted-foreground">
        <p>Nothing matches.</p>
        <p className="text-xs">
          Some settings live only in a file:{" "}
          <a
            href="https://github.com/sdm-kz/hangar/blob/main/docs/configuration.md"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            configuration
          </a>
          .
        </p>
      </div>
    );

  return (
    <ul ref={listRef} id="settings-results" role="listbox" aria-label="Results" className="-mx-1 min-h-0 overflow-y-auto px-1">
      {hits.map(({ entry, words }, i) => {
        const tab = tabInfo(entry.tab);
        const where = [entry.detail, tab.label].filter((s, j, all) => s && all.indexOf(s) === j).join(" · ");
        return (
          <li
            key={`${entry.tab}:${entry.id}:${entry.node ?? ""}:${entry.title}`}
            id={`settings-hit-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseMove={() => i !== active && onActive(i)}
            onClick={() => onPick(entry)}
            className={cn(
              "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm",
              i === active ? "bg-accent text-foreground" : "text-foreground/90"
            )}
          >
            <tab.Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">
                <Highlight text={entry.title} words={words} />
              </span>
              <span className="block truncate text-xs text-muted-foreground">{where}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The text with the typed words marked where they occur in it. */
function Highlight({ text, words }: { text: string; words: string[] }) {
  const lower = text.toLowerCase();
  const marks: boolean[] = new Array(text.length).fill(false);
  for (const w of words) {
    let at = lower.indexOf(w);
    while (at >= 0) {
      for (let k = at; k < at + w.length; k++) marks[k] = true;
      at = lower.indexOf(w, at + w.length);
    }
  }
  const parts: ReactNode[] = [];
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && marks[j] === marks[i]) j++;
    const piece = text.slice(i, j);
    parts.push(
      marks[i] ? (
        <mark key={i} className="rounded-sm bg-primary/20 text-inherit">
          {piece}
        </mark>
      ) : (
        <Fragment key={i}>{piece}</Fragment>
      )
    );
    i = j;
  }
  return <>{parts}</>;
}
