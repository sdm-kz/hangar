//! The running sessions, arranged the way the sidebar's grouped ("tree") view arranges them with its
//! active-only filter on: virtual folders, then folder groups, under the project that holds them, and
//! forks nested under the session they were forked from. The tray menu is built from these rows; the
//! arranging lives here, apart from the menu, because it is the half worth testing.
//!
//! Two things the sidebar has and this doesn't: the hand-arranged order inside a folder and the
//! collapsed headings. Both are per-browser preferences kept in its localStorage, which a menu has no
//! access to — so a folder here is ordered pinned first, then newest, and nothing is folded away.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;

/// A session as `/hub/events` lists it — the fields the menu needs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HubSession {
    pub id: String,
    pub name: String,
    pub working_directory: String,
    pub state: String,
    /// ISO-8601, from one server, so it sorts as a string.
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub remote_control: bool,
    #[serde(default)]
    pub parent_session_id: Option<String>,
    /// The virtual folder it was filed in; applies only inside its own project.
    #[serde(default)]
    pub group_id: Option<String>,
    /// The project whose folders cover its working directory, as the server works it out.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Its activity is paused: left out of the Activity menu, as the web app leaves it out of its
    /// headings and totals. Absent from a server on an older build.
    #[serde(default)]
    pub activity_paused: bool,
}

impl HubSession {
    pub fn running(&self) -> bool {
        self.state.eq_ignore_ascii_case("running")
    }

    /// Whether it counts in the Activity menu: running, and its activity not paused. A paused session
    /// works on a clock — a chat checked every few minutes — and none of its runs is news.
    pub fn counts_in_activity(&self) -> bool {
        self.running() && !self.activity_paused
    }
}

pub use crate::api::ServerProject as Project;

/// One line of the running list: its text, already indented, and — for a session — the session it
/// opens. A row without one is a heading, which names a group rather than pointing at anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub text: String,
    pub session: Option<String>,
}

/// One block of the list: a project, whose rows hang in a submenu under `heading`. No heading means
/// there is no project to open — the rows go straight into the menu.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Block {
    pub heading: Option<String>,
    pub count: usize,
    pub rows: Vec<Row>,
}

/// Bullet in front of a running session, matching the sidebar's activity dot.
const GLYPH: &str = "●";

/// Three spaces a level: enough to read the nesting, little enough that a session three levels in
/// (project, folder, fork) still has room for its name.
fn indent(depth: usize) -> String {
    " ".repeat(depth * 3)
}

/// A folder path folded to a comparison key: separators unified, trailing ones dropped, and case
/// folded for a Windows path — told by its shape rather than by this machine's OS, since the server
/// the tray follows can be another machine.
pub fn dir_key(dir: &str) -> String {
    let key = dir.replace('\\', "/");
    let key = key.trim_end_matches('/');
    let windows = dir.contains('\\') || key.as_bytes().get(1) == Some(&b':');
    if windows {
        key.to_lowercase()
    } else {
        key.to_string()
    }
}

/// The last segment of a working directory: a folder heading's text.
pub fn folder_label(dir: &str) -> String {
    dir.split(['/', '\\']).rfind(|p| !p.is_empty()).unwrap_or(dir).to_string()
}

struct Folder<'a> {
    dir: String,
    label: String,
    sessions: Vec<(&'a HubSession, usize)>,
    is_virtual: bool,
}

struct Section<'a> {
    project: Option<&'a Project>,
    folders: Vec<Folder<'a>>,
}

impl Section<'_> {
    fn count(&self) -> usize {
        self.folders.iter().map(|f| f.sessions.len()).sum()
    }

    /// Whether the project heading already says what this section's folder heading would: the
    /// project links exactly one folder, and that folder is the only one here. The folder heading is
    /// then dropped, as the sidebar drops it (web/src/lib/projects.ts, mergesFolderHeader).
    fn folder_heading_merged(&self) -> bool {
        match (self.project, self.folders.as_slice()) {
            (Some(p), [only]) if p.folders.len() == 1 => !only.is_virtual && dir_key(&only.dir) == dir_key(&p.folders[0]),
            _ => false,
        }
    }
}

/// The running list as the menu draws it: a block per project, opening as a submenu, with its folder
/// groups and their sessions indented inside. Below the project the nesting stays inline, so a
/// session is one hover and one click away rather than three.
pub fn menu(running: &[HubSession], projects: &[Project]) -> Vec<Block> {
    let sections = build(running, projects);
    // With nothing running inside any project, a lone "No project" submenu would only hide the whole
    // list behind a hover: the folder groups go straight into the menu instead.
    let headed = sections.iter().any(|s| s.project.is_some());
    sections
        .iter()
        .map(|section| {
            let mut rows = Vec::new();
            let merged = section.folder_heading_merged();
            for folder in &section.folders {
                let depth = if merged {
                    0
                } else {
                    rows.push(Row { text: format!("{}  ({})", folder.label, folder.sessions.len()), session: None });
                    1
                };
                for (s, fork_depth) in &folder.sessions {
                    rows.push(Row {
                        text: format!("{}{GLYPH}  {}", indent(depth + fork_depth), s.name),
                        session: Some(s.id.clone()),
                    });
                }
            }
            Block {
                heading: headed.then(|| section.project.map_or("No project".to_string(), |p| p.name.clone())),
                count: section.count(),
                rows,
            }
        })
        .collect()
}

/// Group sessions into project sections: projects in name order, only those with something on the
/// list, then one section for whatever is unfiled. A project's virtual folders come first, in the order
/// they were made, then its folder groups. A session filed in a virtual folder is drawn there only.
fn build<'a>(sessions: &'a [HubSession], projects: &'a [Project]) -> Vec<Section<'a>> {
    let project_of = |s: &HubSession| s.project_id.as_ref().and_then(|id| projects.iter().find(|p| &p.id == id));

    // Filed by hand, under the group that holds it — a membership pointing at some other project's
    // group doesn't apply, and the session falls through to the folder grouping.
    let mut by_group: HashMap<&str, Vec<&HubSession>> = HashMap::new();
    let mut unfiled = Vec::new();
    for s in sessions {
        let group = s
            .group_id
            .as_deref()
            .and_then(|g| project_of(s).and_then(|p| p.groups.iter().find(|x| x.id == g)));
        match group {
            Some(g) => by_group.entry(g.id.as_str()).or_default().push(s),
            None => unfiled.push(s),
        }
    }

    let mut by_project: HashMap<&str, Vec<Folder<'a>>> = HashMap::new();
    let mut loose = Vec::new();
    for folder in group_by_folder(&unfiled) {
        // One folder's sessions all fall under one project: the server decides by the folder.
        match folder.sessions.first().and_then(|(s, _)| project_of(s)) {
            Some(p) => by_project.entry(p.id.as_str()).or_default().push(folder),
            None => loose.push(folder),
        }
    }

    let mut sections: Vec<Section<'a>> = projects
        .iter()
        .filter_map(|p| {
            let mut folders: Vec<Folder<'a>> = p
                .groups
                .iter()
                .filter_map(|g| {
                    by_group.remove(g.id.as_str()).map(|items| Folder {
                        dir: String::new(),
                        label: g.name.clone(),
                        sessions: nest(items),
                        is_virtual: true,
                    })
                })
                .collect();
            folders.extend(by_project.remove(p.id.as_str()).unwrap_or_default());
            (!folders.is_empty()).then_some(Section { project: Some(p), folders })
        })
        .collect();
    sections.sort_by_key(|s| s.project.map(|p| p.name.to_lowercase()));
    if !loose.is_empty() {
        sections.push(Section { project: None, folders: loose });
    }
    sections
}

/// One group per working directory, by the heading each shows, keeping the first-seen spelling.
fn group_by_folder<'a>(sessions: &[&'a HubSession]) -> Vec<Folder<'a>> {
    let mut order: Vec<String> = Vec::new();
    let mut by_dir: HashMap<String, (String, Vec<&'a HubSession>)> = HashMap::new();
    for s in sessions {
        let key = dir_key(&s.working_directory);
        by_dir
            .entry(key.clone())
            .or_insert_with(|| {
                order.push(key);
                (s.working_directory.clone(), Vec::new())
            })
            .1
            .push(s);
    }
    let mut folders: Vec<Folder<'a>> = order
        .into_iter()
        .filter_map(|k| by_dir.remove(&k))
        .map(|(dir, items)| Folder { label: folder_label(&dir), dir, sessions: nest(items), is_virtual: false })
        .collect();
    folders.sort_by_key(|f| f.label.to_lowercase());
    folders
}

/// One folder's sessions, pinned first, then newest, each fork following the session it came from. A
/// fork whose parent isn't in this list is drawn as an ordinary session.
fn nest<'a>(mut items: Vec<&'a HubSession>) -> Vec<(&'a HubSession, usize)> {
    items.sort_by(|a, b| b.pinned.cmp(&a.pinned).then_with(|| b.created_at.cmp(&a.created_at)));
    let present: HashSet<&str> = items.iter().map(|s| s.id.as_str()).collect();
    fn parent_in<'a>(s: &'a HubSession, present: &HashSet<&str>) -> Option<&'a str> {
        s.parent_session_id.as_deref().filter(|p| *p != s.id && present.contains(p))
    }
    let parent_here = |s: &'a HubSession| parent_in(s, &present);
    let mut children: HashMap<&str, Vec<&HubSession>> = HashMap::new();
    for s in &items {
        if let Some(p) = parent_here(s) {
            children.entry(p).or_default().push(s);
        }
    }

    let mut out = Vec::with_capacity(items.len());
    let mut emitted = HashSet::new();
    // Depth is capped and every id emitted once: a cycle in the parent links, however it got there,
    // must not take the tray down.
    fn emit<'a>(
        s: &'a HubSession,
        depth: usize,
        children: &HashMap<&str, Vec<&'a HubSession>>,
        emitted: &mut HashSet<&'a str>,
        out: &mut Vec<(&'a HubSession, usize)>,
    ) {
        if !emitted.insert(s.id.as_str()) {
            return;
        }
        out.push((s, depth));
        if depth >= 4 {
            return;
        }
        for kid in children.get(s.id.as_str()).into_iter().flatten() {
            emit(kid, depth + 1, children, emitted, out);
        }
    }
    for s in &items {
        if parent_here(s).is_none() {
            emit(s, 0, &children, &mut emitted, &mut out);
        }
    }
    // Whatever is left is a fork its parent chain never reached (a cycle, or past the depth cap).
    for s in &items {
        emit(s, 0, &children, &mut emitted, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ServerGroup as Group;

    fn session(id: &str, dir: &str, created: &str) -> HubSession {
        HubSession {
            id: id.into(),
            name: format!("s-{id}"),
            working_directory: dir.into(),
            state: "Running".into(),
            created_at: created.into(),
            pinned: false,
            remote_control: true,
            parent_session_id: None,
            group_id: None,
            project_id: None,
            activity_paused: false,
        }
    }

    fn project(id: &str, name: &str, folders: &[&str]) -> Project {
        Project {
            id: id.into(),
            name: name.into(),
            color: None,
            folders: folders.iter().map(|f| f.to_string()).collect(),
            groups: vec![],
        }
    }

    fn texts(block: &Block) -> Vec<&str> {
        block.rows.iter().map(|r| r.text.as_str()).collect()
    }

    #[test]
    fn without_projects_the_folders_go_straight_into_the_menu() {
        let s = [session("a", r"C:\Git\web", "2"), session("b", r"C:\Git\api", "1"), session("c", r"c:\git\WEB\", "3")];
        let blocks = menu(&s, &[]);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].heading, None);
        assert_eq!(
            texts(&blocks[0]),
            ["api  (1)", "   ●  s-b", "web  (2)", "   ●  s-c", "   ●  s-a"],
            "one folder however it is spelled, newest first, folders by name"
        );
    }

    #[test]
    fn projects_head_their_folders_and_the_rest_comes_last() {
        let mut a = session("a", "/w/app/web", "1");
        a.project_id = Some("p".into());
        let mut b = session("b", "/w/app/api", "2");
        b.project_id = Some("p".into());
        let c = session("c", "/tmp/x", "3");
        let blocks = menu(&[a, b, c], &[project("p", "App", &["/w/app"])]);
        assert_eq!(blocks.iter().map(|b| b.heading.as_deref()).collect::<Vec<_>>(), [Some("App"), Some("No project")]);
        assert_eq!(blocks[0].count, 2);
        assert_eq!(texts(&blocks[0]), ["api  (1)", "   ●  s-b", "web  (1)", "   ●  s-a"]);
    }

    #[test]
    fn a_one_folder_project_drops_the_folder_heading() {
        let mut a = session("a", r"C:\Git\App\", "1");
        a.project_id = Some("p".into());
        let blocks = menu(&[a], &[project("p", "App", &[r"c:\git\app"])]);
        assert_eq!(texts(&blocks[0]), ["●  s-a"]);
    }

    #[test]
    fn virtual_folders_come_first_and_only_inside_their_own_project() {
        let mut p = project("p", "App", &["/w/app"]);
        p.groups = vec![Group { id: "g".into(), name: "Release".into() }];
        let mut filed = session("a", "/w/app", "1");
        filed.project_id = Some("p".into());
        filed.group_id = Some("g".into());
        let mut plain = session("b", "/w/app", "2");
        plain.project_id = Some("p".into());
        // Filed in p's group, but its folder now belongs to no project: shown by its folder.
        let mut stray = session("c", "/elsewhere", "3");
        stray.group_id = Some("g".into());
        let blocks = menu(&[filed, plain, stray], &[p]);
        assert_eq!(texts(&blocks[0]), ["Release  (1)", "   ●  s-a", "app  (1)", "   ●  s-b"]);
        assert_eq!(texts(&blocks[1]), ["elsewhere  (1)", "   ●  s-c"]);
    }

    #[test]
    fn forks_nest_under_their_parent_and_pins_lead() {
        let parent = session("p", "/w", "1");
        let mut fork = session("f", "/w", "3");
        fork.parent_session_id = Some("p".into());
        let mut pinned = session("x", "/w", "0");
        pinned.pinned = true;
        let mut orphan = session("o", "/w", "2");
        orphan.parent_session_id = Some("gone".into());
        let blocks = menu(&[parent, fork, pinned, orphan], &[]);
        assert_eq!(texts(&blocks[0]), ["w  (4)", "   ●  s-x", "   ●  s-o", "   ●  s-p", "      ●  s-f"]);
    }

    #[test]
    fn a_cycle_in_the_parent_links_still_lists_everyone_once() {
        let mut a = session("a", "/w", "1");
        a.parent_session_id = Some("b".into());
        let mut b = session("b", "/w", "2");
        b.parent_session_id = Some("a".into());
        let blocks = menu(&[a, b], &[]);
        assert_eq!(blocks[0].rows.iter().filter(|r| r.session.is_some()).count(), 2);
    }

    #[test]
    fn dir_keys_fold_case_only_for_windows_paths() {
        assert_eq!(dir_key(r"C:\Git\App\"), "c:/git/app");
        assert_eq!(dir_key("/home/Me/App/"), "/home/Me/App");
        assert_eq!(folder_label(r"C:\Git\App\"), "App");
    }
}
