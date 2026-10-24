//! The tray menu: the server's state and its running sessions (under **Sessions**), the capture
//! modes, and the app's own settings. Rebuilt whenever what it shows changes — never on a keepalive —
//! from the latest [`View`].

use std::collections::HashMap;

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Wry};
use tauri_plugin_autostart::ManagerExt as _;

use crate::capture::Mode;
use crate::config::Hotkeys;
use crate::progress::{self, Key};
use crate::server::{Status, View};
use crate::session_tree::{self, HubSession};

/// How many closed sessions the "Recent" submenu lists before it stops.
const RECENT_LIMIT: usize = 20;

/// What a session item opens: a session, on this server or on one of its peers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub session: String,
    pub node: Option<String>,
}

/// A built menu, and what each of its session items opens (by the item's id).
pub struct Built {
    pub menu: Menu<Wry>,
    pub targets: HashMap<String, Target>,
}

struct Builder<'a> {
    app: &'a AppHandle,
    targets: HashMap<String, Target>,
}

type Item = Box<dyn IsMenuItem<Wry>>;

impl Builder<'_> {
    fn item(&self, id: &str, text: &str) -> tauri::Result<Item> {
        Ok(Box::new(MenuItem::with_id(self.app, id, text, true, None::<&str>)?))
    }

    fn label(&self, text: &str) -> tauri::Result<Item> {
        Ok(Box::new(MenuItem::new(self.app, text, false, None::<&str>)?))
    }

    fn separator(&self) -> tauri::Result<Item> {
        Ok(Box::new(PredefinedMenuItem::separator(self.app)?))
    }

    fn submenu(&self, text: &str, items: Vec<Item>) -> tauri::Result<Item> {
        let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
        Ok(Box::new(Submenu::with_items(self.app, text, true, &refs)?))
    }

    fn session(&mut self, text: &str, session: &str, node: Option<&str>) -> tauri::Result<Item> {
        let id = format!("open:{}", self.targets.len());
        self.targets.insert(id.clone(), Target { session: session.to_string(), node: node.map(String::from) });
        self.item(&id, text)
    }

    /// The rows of the running list: a heading greyed out, a session clickable.
    fn rows(&mut self, rows: &[session_tree::Row], node: Option<&str>) -> tauri::Result<Vec<Item>> {
        rows.iter()
            .map(|row| match &row.session {
                Some(id) => self.session(&row.text, id, node),
                None => self.label(&row.text),
            })
            .collect()
    }

    /// The Activity submenu: the sessions doing anything, grouped by what — the web app's Sessions-tab
    /// fraction and the list it drops down. None while nothing is.
    fn activity(&mut self, view: &View) -> tauri::Result<Option<Item>> {
        let machines = view.machines();
        let (finished, active) = progress::fraction(&machines, &view.done);
        if active == 0 {
            return Ok(None);
        }
        let names: HashMap<&str, &str> = view.peers.iter().map(|p| (p.id.as_str(), p.name.as_str())).collect();
        let mut rows: Vec<(progress::Activity, Key, String)> = Vec::new();
        for m in &machines {
            for s in m.sessions.iter().filter(|s| s.running()) {
                let key = (m.node.map(String::from), s.id.clone());
                let Some(activity) = progress::activity(s, m.ids, view.done.contains(&key)) else { continue };
                let place = match m.node {
                    Some(node) => format!("{} · {}", names.get(node).copied().unwrap_or(node), folder_name(&s.working_directory)),
                    None => folder_name(&s.working_directory),
                };
                rows.push((activity, key, format!("{}   ·  {place}", s.name)));
            }
        }
        let mut items = Vec::new();
        for (title, activities) in progress::GROUPS {
            let group: Vec<_> = rows.iter().filter(|(a, _, _)| activities.contains(a)).collect();
            if group.is_empty() {
                continue;
            }
            if !items.is_empty() {
                items.push(self.separator()?);
            }
            items.push(self.label(&format!("{title} · {}", group.len()))?);
            for (_, (node, id), text) in &group {
                items.push(self.session(&format!("   {text}"), id, node.as_deref())?);
            }
            if title == "Finished" && group.len() > 1 {
                items.push(self.item("seen:all", "   Mark all seen")?);
            }
        }
        Ok(Some(self.submenu(&format!("Activity  {finished}/{active}"), items)?))
    }

    /// The contents of the Sessions submenu: what is running, laid out as the sidebar lays it out;
    /// what closed lately; and what runs on each paired machine.
    fn sessions(&mut self, view: &View) -> tauri::Result<Vec<Item>> {
        let mut items = Vec::new();
        let running: Vec<HubSession> = view.sessions.iter().filter(|s| s.running()).cloned().collect();
        items.push(self.label(&format!("Running — {}", running.len()))?);
        if running.is_empty() {
            items.push(self.label("No running sessions")?);
        }
        for block in session_tree::menu(&running, &view.projects) {
            let rows = self.rows(&block.rows, None)?;
            match &block.heading {
                Some(heading) => items.push(self.submenu(&format!("{heading}  ({})", block.count), rows)?),
                None => items.extend(rows),
            }
        }

        let mut closed: Vec<&HubSession> = view.sessions.iter().filter(|s| !s.running()).collect();
        closed.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        if !closed.is_empty() {
            // Names repeat a lot (one per repo folder), so a path is added only where they collide.
            let mut names: HashMap<String, usize> = HashMap::new();
            for s in &view.sessions {
                *names.entry(s.name.to_lowercase()).or_default() += 1;
            }
            let mut recent = Vec::new();
            for s in closed.iter().take(RECENT_LIMIT) {
                let text = if names.get(&s.name.to_lowercase()).copied().unwrap_or(0) > 1 {
                    format!("○  {}  ·  {}", s.name, short_path(&s.working_directory))
                } else {
                    format!("○  {}", s.name)
                };
                recent.push(self.session(&text, &s.id, None)?);
            }
            if closed.len() > RECENT_LIMIT {
                recent.push(self.separator()?);
                recent.push(self.item("open", &format!("{} more — open Hangar…", closed.len() - RECENT_LIMIT))?);
            }
            items.push(self.submenu(&format!("Recent — {}", closed.len()), recent)?);
        }

        if !view.peers.is_empty() {
            items.push(self.separator()?);
        }
        for peer in &view.peers {
            if peer.status != "online" {
                items.push(self.label(&format!("{} — {}", peer.name, peer.status))?);
                continue;
            }
            let running: Vec<HubSession> = peer.sessions.iter().filter(|s| s.running()).cloned().collect();
            let mut rows = Vec::new();
            if running.is_empty() {
                rows.push(self.label("No running sessions")?);
            }
            // By folder, not by project: a peer's projects are its own, and not fetched from here.
            for block in session_tree::menu(&running, &[]) {
                rows.extend(self.rows(&block.rows, Some(&peer.id))?);
            }
            items.push(self.submenu(&format!("{} — {} running", peer.name, running.len()), rows)?);
        }
        Ok(items)
    }
}

/// A folder's own name, the last segment of its path.
fn folder_name(path: &str) -> String {
    path.split(['/', '\\']).rfind(|p| !p.is_empty()).unwrap_or(path).to_string()
}

/// Last two path segments: enough to tell same-named sessions apart without a long menu.
fn short_path(path: &str) -> String {
    let parts: Vec<&str> = path.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
    if parts.len() <= 2 {
        path.to_string()
    } else {
        parts[parts.len() - 2..].join("/")
    }
}

/// The first line of the menu when there is no session list to show.
fn status_line(view: &View) -> Option<String> {
    match &view.status {
        Status::Connected => None,
        Status::Connecting => Some("Connecting to Hangar…".into()),
        Status::NotRunning => Some("Hangar server is not running".into()),
        Status::NotResponding => Some("Hangar server is not responding".into()),
        Status::SignIn => Some("Sign in to Hangar (Settings…)".into()),
        Status::Unreachable(_) => Some("Can't reach the Hangar server".into()),
    }
}

/// The tooltip over the icon.
pub fn tooltip(view: &View) -> String {
    let state = match &view.status {
        Status::Connected => format!("{} running", view.sessions.iter().filter(|s| s.running()).count()),
        Status::Connecting => "connecting…".into(),
        Status::NotRunning => "server not running".into(),
        Status::NotResponding => "server not responding".into(),
        Status::SignIn => "sign in needed".into(),
        Status::Unreachable(_) => "server unreachable".into(),
    };
    format!("{} — {state}", crate::PRODUCT)
}

pub fn build(app: &AppHandle, hotkeys: &Hotkeys, view: &View) -> tauri::Result<Built> {
    let mut b = Builder { app, targets: HashMap::new() };
    let mut items: Vec<Item> = Vec::new();

    match status_line(view) {
        None => {
            items.push(b.item("open", "Open Hangar")?);
            if let Some(activity) = b.activity(view)? {
                items.push(activity);
            }
            let sessions = b.sessions(view)?;
            let running = view.sessions.iter().filter(|s| s.running()).count();
            items.push(b.submenu(&format!("Sessions  ({running})"), sessions)?);
        }
        Some(line) => {
            items.push(b.label(&line)?);
            if view.local && view.status == Status::NotRunning && crate::host::starter().is_some() {
                items.push(b.item("server:start", "Start server")?);
            }
        }
    }
    items.push(b.separator()?);

    for mode in Mode::ALL {
        let accel = crate::hotkey_for(hotkeys, mode).trim();
        let id = format!("capture:{}", serde_json::to_value(mode).unwrap().as_str().unwrap());
        let label = format!("Capture {}", mode.label().to_lowercase());
        // The accelerator is only shown, not bound, in a tray menu; one the menu can't parse is left off.
        let item = MenuItem::with_id(app, &id, &label, true, (!accel.is_empty()).then_some(accel))
            .or_else(|_| MenuItem::with_id(app, &id, &label, true, None::<&str>))?;
        items.push(Box::new(item));
    }
    items.push(b.separator()?);

    items.push(b.item("settings", "Settings…")?);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);
    items.push(Box::new(CheckMenuItem::with_id(app, "autostart", "Start when I sign in", true, autostart, None::<&str>)?));
    items.push(b.separator()?);

    if view.local && view.connected() {
        if !view.orphans.is_empty() {
            items.push(b.item("orphans:stop", &format!("Stop {} orphaned session(s)…", view.orphans.len()))?);
        }
        items.push(b.item("server:stop", "Stop server…")?);
    }
    items.push(b.item("quit", &format!("Quit {}", crate::PRODUCT))?);

    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|i| i.as_ref()).collect();
    let menu = Menu::with_items(app, &refs)?;
    Ok(Built { menu, targets: b.targets })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_path_keeps_the_last_two_segments() {
        assert_eq!(short_path(r"C:\Git\org\repo"), "org/repo");
        assert_eq!(short_path("/srv/app"), "/srv/app");
    }

    #[test]
    fn folder_name_is_the_last_segment() {
        assert_eq!(folder_name(r"C:\Git\org\repo\"), "repo");
        assert_eq!(folder_name("/srv/app"), "app");
        assert_eq!(folder_name("/"), "/");
    }

    #[test]
    fn the_tooltip_counts_running_sessions_or_says_why_not() {
        let mut view = View { status: Status::NotRunning, ..View::default() };
        assert!(tooltip(&view).ends_with("— server not running"), "{}", tooltip(&view));
        view.status = Status::Connected;
        assert!(tooltip(&view).ends_with("— 0 running"));
    }
}
