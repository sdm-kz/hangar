import { createContext, useContext } from "react";

/**
 * Settings: the tabs, the index its search box looks through, and the way anything opens it on a tab
 * (docs/design/settings.md).
 */

export type SettingsTab =
  | "appearance"
  | "notifications"
  | "nodes"
  | "projects"
  | "schedules"
  | "security"
  | "hooks"
  | "updates";

/**
 * Where a tab's settings live, said on its heading: this browser's storage, this node's (the one the page
 * came from — pairing and the password are never another node's, see NodeProxy.LocalOnly), the node picked
 * at the top of the tab, or every node at once.
 */
export type SettingsScope = "browser" | "self" | "node" | "all";

/**
 * One thing the search box can find. `id` is what the panel marks the element with (`data-setting`), so
 * opening a hit can scroll to it. Live entries — a project, a node, a schedule — carry the node they are on.
 */
export interface SettingsEntry {
  id: string;
  tab: SettingsTab;
  title: string;
  keywords?: string[];
  /** A second line in the results: where it is, or what it belongs to. */
  detail?: string;
  /** The node a live entry is on; undefined for a static one, which is wherever the tab is. */
  node?: string | null;
  /** A project hit opens that project's own dialog rather than only scrolling to its row. */
  project?: string;
}

/** The settings a person might look for by name. Panels mark each with `data-setting={id}`. */
export const SETTINGS_INDEX: SettingsEntry[] = [
  { id: "appearance.mode", tab: "appearance", title: "Light, dark or system", keywords: ["theme", "mode", "dark mode", "light mode"] },
  { id: "appearance.light", tab: "appearance", title: "Light theme", keywords: ["theme", "colors", "colours"] },
  { id: "appearance.dark", tab: "appearance", title: "Dark theme", keywords: ["theme", "colors", "colours"] },
  {
    id: "appearance.customize",
    tab: "appearance",
    title: "Custom theme colors",
    keywords: ["customize", "customise", "edit", "colours", "palette", "terminal", "code", "syntax"],
  },
  { id: "notifications.push", tab: "notifications", title: "Push notifications", keywords: ["bell", "alert", "phone", "notify"] },
  { id: "nodes.self", tab: "nodes", title: "This node", keywords: ["machine", "identity"] },
  { id: "nodes.name", tab: "nodes", title: "Node name", keywords: ["rename", "machine"] },
  { id: "nodes.url", tab: "nodes", title: "Address for other nodes", keywords: ["url", "host", "pairing"] },
  { id: "nodes.color", tab: "nodes", title: "Node colour", keywords: ["color"] },
  {
    id: "nodes.peers",
    tab: "nodes",
    title: "Nodes this one reaches",
    keywords: ["peers", "machines", "paired", "forget", "disable", "certificate", "trust"],
  },
  { id: "nodes.add", tab: "nodes", title: "Add a node", keywords: ["pair", "connect", "machine", "peer"] },
  { id: "nodes.allowed", tab: "nodes", title: "Allowed in", keywords: ["revoke", "access", "inbound", "token"] },
  {
    id: "projects.list",
    tab: "projects",
    title: "Projects",
    keywords: ["folders", "repositories", "repos", "groups", "templates", "connections", "ssh"],
  },
  { id: "projects.new", tab: "projects", title: "New project", keywords: ["create", "add"] },
  { id: "schedules.list", tab: "schedules", title: "Schedules", keywords: ["cron", "clock", "timer", "run", "template"] },
  { id: "security.password", tab: "security", title: "Password", keywords: ["change", "set", "login", "sign in"] },
  { id: "security.signout", tab: "security", title: "Sign out", keywords: ["log out", "logout"] },
  { id: "hooks.status", tab: "hooks", title: "Claude's hooks", keywords: ["take over", "port", "settings.json", "status"] },
  { id: "updates.list", tab: "updates", title: "Updates", keywords: ["version", "build", "release", "upgrade", "restart"] },
];

export interface SettingsHit {
  entry: SettingsEntry;
  /** The query's words, for highlighting. */
  words: string[];
}

const words = (q: string) => q.toLowerCase().split(/\s+/).filter(Boolean);

/**
 * The entries every typed word appears in — in the title, a keyword, the detail or the tab's name — best
 * first: a title match above a keyword one, and a match at the start of a word above one inside it.
 */
export function searchSettings(query: string, entries: SettingsEntry[], tabLabel: (t: SettingsTab) => string): SettingsHit[] {
  const ws = words(query);
  if (ws.length === 0) return [];
  const scored: { entry: SettingsEntry; score: number; order: number }[] = [];
  entries.forEach((entry, order) => {
    const title = entry.title.toLowerCase();
    const rest = [...(entry.keywords ?? []), entry.detail ?? "", tabLabel(entry.tab)].join(" ").toLowerCase();
    let score = 0;
    for (const w of ws) {
      const inTitle = title.indexOf(w);
      if (inTitle >= 0) score += atWordStart(title, inTitle) ? 4 : 3;
      else {
        const inRest = rest.indexOf(w);
        if (inRest < 0) return; // every word has to be somewhere
        score += atWordStart(rest, inRest) ? 2 : 1;
      }
    }
    scored.push({ entry, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map(({ entry }) => ({ entry, words: ws }));
}

const atWordStart = (text: string, i: number) => i === 0 || /[\s\-_.:/'(]/.test(text[i - 1]);

/**
 * Opens Settings, on a tab and scrolled to one setting when asked. Provided once, by App, so the footer's
 * gear and the shortcut open the same dialog. `closes` counts the times it has closed, so what sits behind
 * it (the footer's bell, the strips) can read its state again afterwards.
 */
export interface SettingsOpener {
  open: (tab?: SettingsTab, setting?: string) => void;
  closes: number;
}

export const SettingsContext = createContext<SettingsOpener>({ open: () => {}, closes: 0 });

export const useSettings = () => useContext(SettingsContext);
