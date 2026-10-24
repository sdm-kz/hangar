//! The tray's live link to the Hangar server: the `/hub/events` socket held open for the session list,
//! and the two things that stream doesn't carry — the projects and the orphaned pty hosts — fetched
//! beside it when they may have changed. Runs on the async runtime; the tray reads [`View`] and is told
//! when it changes.
//!
//! Nothing here ever starts a server. At sign-in the server and the tray are launched side by side and
//! the server takes a few seconds to bind; a tray that "helpfully" started one in that window would
//! race it. Starting is a menu item ([`crate::host::start_server`]).

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Deserialize;
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};
use url::Url;

use crate::api::{self, Client, Credentials, Instance, Orphan};
use crate::progress::{Ids, Key, Machine, Tracker};
use crate::session_tree::{HubSession, Project};

/// The hub re-sends its snapshot every few seconds even when nothing changed; this long without one is
/// a dead socket.
const SILENCE: Duration = Duration::from_secs(15);
const RETRY: Duration = Duration::from_secs(2);
/// The orphaned hosts are refetched when the session list changes (a detach makes one) — but no more
/// often than the first, since a busy list changes every second — and at least every second.
const ORPHANS_MIN: Duration = Duration::from_secs(5);
const ORPHANS_MAX: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum Status {
    #[default]
    Connecting,
    Connected,
    /// A server on this machine: no instance file, or its process is gone.
    NotRunning,
    /// A server on this machine whose process is alive but isn't answering.
    NotResponding,
    /// The server wants a password (Settings → sign in).
    SignIn,
    /// Another machine's server that can't be reached; why.
    Unreachable(String),
}

/// Another machine the server is paired with, as its `/hub/events` passes it on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Peer {
    pub id: String,
    pub name: String,
    /// `online`, or why not: `offline`, `connecting`, `unauthorized`…
    pub status: String,
    pub sessions: Vec<HubSession>,
    pub ids: Ids,
}

/// What the tray knows about the server at one moment. Replaced whole, and only when it differs, so a
/// keepalive that changes nothing doesn't rebuild the menu.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct View {
    pub status: Status,
    /// The server is on this machine (reached through its instance file): it can be stopped and
    /// started from here, and its orphans are this machine's to clean up.
    pub local: bool,
    pub instance: Option<Instance>,
    pub sessions: Vec<HubSession>,
    pub projects: Vec<Project>,
    pub orphans: Vec<Orphan>,
    pub peers: Vec<Peer>,
    /// What the server's own sessions are doing.
    pub ids: Ids,
    /// The sessions, here or on a peer, that finished a turn you haven't opened from the tray since.
    pub done: BTreeSet<Key>,
}

impl View {
    pub fn connected(&self) -> bool {
        self.status == Status::Connected
    }

    /// Every machine whose sessions are listed: this server, then each peer that is online.
    pub fn machines(&self) -> Vec<Machine<'_>> {
        let own = Machine { node: None, sessions: &self.sessions, ids: &self.ids };
        let peers = self.peers.iter().filter(|p| p.status == "online");
        std::iter::once(own).chain(peers.map(|p| Machine { node: Some(&p.id), sessions: &p.sessions, ids: &p.ids })).collect()
    }
}

/// The parts of a `/hub/events` snapshot the tray uses; the rest is ignored.
#[derive(Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
struct Snapshot {
    sessions: Vec<serde_json::Value>,
    update: Option<Update>,
    nodes: Vec<Node>,
    /// Moves whenever the projects do; the tray re-reads `/api/projects` when it sees it move.
    projects_rev: Option<serde_json::Value>,
    #[serde(flatten)]
    ids: Ids,
}

#[derive(Deserialize)]
struct Update {
    state: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Node {
    id: Option<String>,
    name: Option<String>,
    status: Option<String>,
    snapshot: Option<serde_json::Value>,
}

/// The sessions in a snapshot's list, skipping any that don't read — a peer's build may differ from
/// this one, and one odd row must not empty the menu.
fn sessions_of(rows: Vec<serde_json::Value>) -> Vec<HubSession> {
    rows.into_iter().filter_map(|v| serde_json::from_value::<HubSession>(v).ok()).filter(|s| !s.id.is_empty()).collect()
}

fn peers_of(nodes: Vec<Node>) -> Vec<Peer> {
    nodes
        .into_iter()
        .filter_map(|n| {
            let id = n.id.filter(|i| !i.is_empty())?;
            let (sessions, ids) = n
                .snapshot
                .and_then(|s| serde_json::from_value::<Snapshot>(s).ok())
                .map(|s| (sessions_of(s.sessions), s.ids))
                .unwrap_or_default();
            Some(Peer { name: n.name.unwrap_or_else(|| id.clone()), id, status: n.status.unwrap_or_else(|| "offline".into()), sessions, ids })
        })
        .collect()
}

/// What about the session list can change which orphans there are.
fn signature(sessions: &[HubSession]) -> String {
    let mut keys: Vec<String> = sessions.iter().map(|s| format!("{}:{}", s.id, s.state)).collect();
    keys.sort();
    keys.join("|")
}

/// The handle the rest of the app holds: the latest view, and a way to make the loop drop its socket
/// and start again (the server address or the sign-in changed).
pub struct Connection {
    view: std::sync::Mutex<View>,
    reconnect: Notify,
    finished: std::sync::Mutex<Tracker>,
}

impl Connection {
    pub fn new() -> Arc<Self> {
        Arc::new(Self { view: std::sync::Mutex::new(View::default()), reconnect: Notify::new(), finished: Default::default() })
    }

    pub fn view(&self) -> View {
        self.view.lock().unwrap().clone()
    }

    /// Drop the socket and connect again. `notify_one`, not `notify_waiters`: the loop isn't always
    /// waiting (it may be mid-connect or mid-fetch), and only `notify_one` keeps the request for it.
    pub fn reconnect(&self) {
        self.reconnect.notify_one();
    }
}

/// You've seen how these sessions' last turns ended: their ticks go, here and in the menu.
pub fn mark_seen(app: &AppHandle, keys: &[Key]) {
    update_done(app, |t| t.seen(keys));
}

/// You've opened this session from the tray: seen, as [`mark_seen`], and its being opened isn't a turn.
pub fn opened(app: &AppHandle, key: &Key) {
    update_done(app, |t| t.opened(key));
}

/// Change the ticks and put them in the view as it is now. The tracker is locked first and held while
/// the view is written, as [`follow`] does, so neither can put back what the other just changed.
fn update_done(app: &AppHandle, change: impl FnOnce(&mut Tracker) -> BTreeSet<Key>) {
    let conn = connection(app);
    let mut finished = conn.finished.lock().unwrap();
    let done = change(&mut finished);
    let mut view = conn.view();
    if view.done != done {
        view.done = done;
        publish(app, &conn, view);
    }
}

/// Follow the server the settings name, for as long as the app runs.
pub fn start(app: &AppHandle, conn: Arc<Connection>) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut last_failure = String::new();
        loop {
            let outcome = follow_once(&app, &conn).await;
            if let Err(failure) = outcome {
                // Once per distinct failure: a server that stays down shouldn't fill the log.
                if failure != last_failure {
                    log::info!("{failure}");
                    last_failure = failure;
                }
            } else {
                last_failure.clear();
            }
            // A socket that just ended leaves a view of a server that may be gone: say so now, not after
            // the next attempt to connect has run its course.
            let view = conn.view();
            if view.connected() {
                publish(&app, &conn, View { status: Status::Connecting, local: view.local, instance: view.instance, ..View::default() });
            }
            tokio::select! {
                _ = tokio::time::sleep(RETRY) => {}
                _ = conn.reconnect.notified() => {}
            }
        }
    });
}

fn publish(app: &AppHandle, conn: &Connection, view: View) {
    {
        let mut current = conn.view.lock().unwrap();
        if *current == view {
            return;
        }
        if current.status != view.status {
            let running = view.sessions.iter().filter(|s| s.running()).count();
            log::info!("Server: {:?} ({running} running, {} peer(s))", view.status, view.peers.len());
        }
        *current = view;
    }
    crate::refresh_tray(app);
}

/// Connect once and follow the stream until it ends. Publishes the view as it goes; an `Err` is a
/// line for the log.
async fn follow_once(app: &AppHandle, conn: &Connection) -> Result<(), String> {
    let (server_url, token) = {
        let st = crate::state(app);
        let settings = st.settings.lock().unwrap();
        (settings.server_url.clone(), settings.token.clone())
    };
    let dirs = api::default_instances_dirs();
    let instance = api::local_instance(&server_url, &dirs);
    let creds = match api::resolve_credentials(&server_url, token.as_deref(), &dirs) {
        Ok(c) => c,
        Err(e) => {
            publish(app, conn, View { status: Status::Unreachable(e.clone()), ..View::default() });
            return Err(e);
        }
    };
    let loopback = creds.local || is_loopback_url(&server_url);
    let offline = |status: Status| View { status, local: loopback, instance: instance.clone(), ..View::default() };

    let ws = match connect(&creds).await {
        Ok(ws) => ws,
        Err(ConnectError::Unauthorized) => {
            publish(app, conn, offline(Status::SignIn));
            return Err(format!("{} wants a sign-in", creds.base));
        }
        Err(ConnectError::Failed(e)) => {
            let status = match &instance {
                Some(i) if crate::host::process_alive(i.pid) => Status::NotResponding,
                _ if loopback => Status::NotRunning,
                _ => Status::Unreachable(e.clone()),
            };
            publish(app, conn, offline(status));
            return Err(format!("No connection to {}: {e}", creds.base));
        }
    };
    log::info!("Connected to {}", creds.base);
    crate::host::relaunch_if_replaced(app);
    follow(app, conn, &creds, instance, ws).await
}

fn is_loopback_url(url: &str) -> bool {
    Url::parse(url.trim())
        .ok()
        .and_then(|u| u.host_str().map(|h| h.eq_ignore_ascii_case("localhost") || h == "127.0.0.1" || h == "[::1]"))
        .unwrap_or(false)
}

type Socket = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

enum ConnectError {
    Unauthorized,
    Failed(String),
}

async fn connect(creds: &Credentials) -> Result<Socket, ConnectError> {
    let mut url = creds.base.join("/hub/events").map_err(|e| ConnectError::Failed(e.to_string()))?;
    let scheme = if url.scheme() == "https" { "wss" } else { "ws" };
    url.set_scheme(scheme).map_err(|_| ConnectError::Failed("Not a web address".into()))?;
    // client=tray: the hub keeps its fast tick for browsers and takes a slower one for this menu.
    url.set_query(Some("client=tray"));
    let mut request = url.as_str().into_client_request().map_err(|e| ConnectError::Failed(e.to_string()))?;
    if let Some(token) = &creds.token {
        let value = format!("Bearer {token}").parse().map_err(|_| ConnectError::Failed("The token can't be sent".into()))?;
        request.headers_mut().insert("Authorization", value);
    }
    match tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request)).await {
        Err(_) => Err(ConnectError::Failed("timed out".into())),
        Ok(Ok((ws, _))) => Ok(ws),
        Ok(Err(tungstenite::Error::Http(res))) if res.status() == 401 => Err(ConnectError::Unauthorized),
        Ok(Err(e)) => Err(ConnectError::Failed(e.to_string())),
    }
}

/// Read snapshots until the socket closes, goes silent, or the settings change.
async fn follow(
    app: &AppHandle,
    conn: &Connection,
    creds: &Credentials,
    instance: Option<Instance>,
    mut ws: Socket,
) -> Result<(), String> {
    let client = Client::new(creds.clone());
    let mut projects: Vec<Project> = Vec::new();
    let mut projects_rev: Option<Option<serde_json::Value>> = None;
    let mut orphans: Vec<Orphan> = Vec::new();
    let mut orphans_for: Option<String> = None;
    let mut orphans_at = Instant::now() - ORPHANS_MAX;
    let mut last_frame = String::new();
    conn.finished.lock().unwrap().reset();

    loop {
        let frame = tokio::select! {
            _ = conn.reconnect.notified() => return Ok(()),
            next = tokio::time::timeout(SILENCE, ws.next()) => match next {
                Err(_) => return Err(format!("{} went silent", creds.base)),
                Ok(None) | Ok(Some(Ok(Message::Close(_)))) => return Ok(()),
                Ok(Some(Err(e))) => return Err(format!("Lost {}: {e}", creds.base)),
                Ok(Some(Ok(Message::Text(text)))) => text.to_string(),
                Ok(Some(Ok(_))) => continue,
            },
        };
        let orphans_due = creds.local && orphans_at.elapsed() >= ORPHANS_MAX;
        // Most frames are the hub repeating an unchanged snapshot as a keepalive; receiving it has
        // already done everything a keepalive is for.
        if frame == last_frame && !orphans_due {
            continue;
        }
        let Ok(snapshot) = serde_json::from_str::<Snapshot>(&frame) else { continue };
        last_frame = frame;

        // A tray that doesn't step aside (elsewhere than Windows, or not part of this install) just goes
        // on following until the server goes down for the update.
        if snapshot.update.as_ref().and_then(|u| u.state.as_deref()).is_some_and(|s| s.eq_ignore_ascii_case("applying")) {
            if let Some(instance) = &instance {
                crate::host::step_aside_for_update(app, instance);
            }
        }

        let sessions = sessions_of(snapshot.sessions);
        if projects_rev.as_ref() != Some(&snapshot.projects_rev) {
            // A failed fetch keeps the last good list: slightly stale projects beat a menu that briefly
            // forgets them.
            if let Ok(p) = client.projects().await {
                projects = p;
                projects_rev = Some(snapshot.projects_rev.clone());
            }
        }
        let sig = signature(&sessions);
        if creds.local && (orphans_due || (orphans_for.as_deref() != Some(&sig) && orphans_at.elapsed() >= ORPHANS_MIN)) {
            if let Ok(o) = client.orphans().await {
                orphans = o;
            }
            orphans_for = Some(sig);
            orphans_at = Instant::now();
        }

        let mut view = View {
            status: Status::Connected,
            local: creds.local,
            instance: instance.clone(),
            sessions,
            projects: projects.clone(),
            orphans: orphans.clone(),
            peers: peers_of(snapshot.nodes),
            ids: snapshot.ids,
            done: BTreeSet::new(),
        };
        // Held through the publish: see update_done.
        let mut finished = conn.finished.lock().unwrap();
        view.done = finished.observe(&view.machines());
        publish(app, conn, view);
        drop(finished);
    }
}

pub fn connection(app: &AppHandle) -> Arc<Connection> {
    app.state::<Arc<Connection>>().inner().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_sessions_and_peers_of_a_snapshot() {
        let frame = r#"{
            "sessions": [
                {"id":"a","name":"one","workingDirectory":"C:\\w","state":"Running","createdAt":"2026-10-01T00:00:00Z","projectId":"p"},
                {"id":"b","name":null,"workingDirectory":"C:\\w","state":"Running"}
            ],
            "update": {"state":"Idle"},
            "projectsRev": 7,
            "busy": ["a"],
            "waiting": [],
            "nodes": [
                {"id":"nas","name":"NAS","status":"online","snapshot":{"sessions":[{"id":"x","name":"far","workingDirectory":"/srv","state":"Running"}]}},
                {"id":"mac","status":"offline","snapshot":null},
                {"name":"no id"}
            ]
        }"#;
        let s: Snapshot = serde_json::from_str(frame).unwrap();
        assert_eq!(s.projects_rev, Some(serde_json::json!(7)));
        assert!(s.ids.busy.contains("a") && s.ids.waiting.is_empty());
        let sessions = sessions_of(s.sessions);
        assert_eq!(sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["a"], "a row that doesn't read is skipped");
        assert_eq!(sessions[0].project_id.as_deref(), Some("p"));
        let peers = peers_of(s.nodes);
        assert_eq!(peers.len(), 2);
        assert_eq!((peers[0].name.as_str(), peers[0].sessions.len()), ("NAS", 1));
        assert_eq!((peers[1].name.as_str(), peers[1].status.as_str(), peers[1].sessions.len()), ("mac", "offline", 0));
    }

    #[test]
    fn a_snapshot_with_nothing_the_tray_needs_still_reads() {
        let s: Snapshot = serde_json::from_str(r#"{"busy":[],"shells":{}}"#).unwrap();
        assert!(s.sessions.is_empty() && s.update.is_none() && s.nodes.is_empty());
    }

    #[test]
    fn loopback_addresses_are_recognised() {
        assert!(is_loopback_url("http://127.0.0.1:5099"));
        assert!(is_loopback_url("http://LOCALHOST:5099/"));
        assert!(!is_loopback_url("https://nas-hangar.example"));
    }
}
