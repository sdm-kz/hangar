//! The Hangar server, as this app uses it: who's running, and "send this image with this text to
//! that session". Everything here is a client of the same HTTP API the web UI and the tray speak.

use std::path::PathBuf;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::config::Recent;

/// How to reach the server and what to show it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Credentials {
    pub base: Url,
    pub token: Option<String>,
    /// True when the token came from the server's own instance file — this machine runs the server,
    /// and no sign-in is needed.
    pub local: bool,
}

/// The fields of a server's instance file (`Hangar.Contract.DaemonInstance`) this app reads: written by
/// a server on this machine once it listens, and removed when it stops.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    #[serde(default)]
    pub pid: u32,
    pub local_url: String,
    /// Where to send a person: the server's public URL when it has one, else the loopback.
    #[serde(default)]
    pub open_url: String,
    pub token: String,
    /// The server's executable, which says which install it is.
    #[serde(default)]
    pub exe_path: Option<String>,
}

/// Where a server on this machine writes its instance files: .NET's LocalApplicationData, which is
/// `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS and `~/.local/share` on Linux
/// — the same folders `dirs::data_local_dir` answers with — under `Hangar`.
pub fn default_instances_dirs() -> Vec<PathBuf> {
    dirs::data_local_dir().map(|d| vec![d.join("Hangar").join("instances")]).unwrap_or_default()
}

fn is_loopback(url: &Url) -> bool {
    match url.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

/// The instance file of the server `server_url` names, when that is a loopback address and a server
/// on this machine has written one for its port. One whose own address is off this machine wasn't
/// written by the server — it never writes anything but a loopback address — and is ignored, since it
/// would otherwise be told where to send the token.
pub fn local_instance(server_url: &str, instances_dirs: &[PathBuf]) -> Option<Instance> {
    let base = Url::parse(server_url.trim()).ok()?;
    if !is_loopback(&base) {
        return None;
    }
    let port = base.port_or_known_default()?;
    let instance = instances_dirs.iter().find_map(|dir| {
        std::fs::read_to_string(dir.join(format!("{port}.json")))
            .ok()
            .and_then(|t| serde_json::from_str::<Instance>(&t).ok())
    })?;
    Url::parse(&instance.local_url).ok().filter(is_loopback).map(|_| instance)
}

/// Work out how to talk to `server_url`. A server on this machine is spoken to with the token from
/// its instance file (see [`local_instance`]), so a local install works with no password at all.
/// Anything else uses the token saved from signing in.
pub fn resolve_credentials(
    server_url: &str,
    saved_token: Option<&str>,
    instances_dirs: &[PathBuf],
) -> Result<Credentials, String> {
    let base = Url::parse(server_url.trim()).map_err(|e| format!("Not a valid server URL: {e}"))?;
    if !matches!(base.scheme(), "http" | "https") {
        return Err("The server URL must start with http:// or https://".into());
    }
    if let Some(instance) = local_instance(server_url, instances_dirs) {
        if let Ok(local) = Url::parse(&instance.local_url) {
            return Ok(Credentials { base: local, token: Some(instance.token), local: true });
        }
    }
    Ok(Credentials { base, token: saved_token.map(Into::into), local: false })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ApiError {
    /// The server wants a (new) sign-in.
    Unauthorized,
    /// The session is gone or no longer running.
    NotFound(String),
    /// The server couldn't be reached at all.
    Unreachable(String),
    Failed(String),
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Unauthorized => write!(f, "Sign in to the server first"),
            ApiError::NotFound(m) | ApiError::Unreachable(m) | ApiError::Failed(m) => write!(f, "{m}"),
        }
    }
}

/// A session as `/api/sessions` describes it — the fields this app shows or needs.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerSession {
    pub id: String,
    pub name: String,
    pub working_directory: String,
    pub state: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    /// The project the server files it under (by its folder; the server's own rule).
    #[serde(default)]
    pub project_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    /// The folders linked to it; a session belongs to the project whose folder it runs in.
    #[serde(default)]
    pub folders: Vec<String>,
    /// Its virtual folders, to file a session in.
    #[serde(default)]
    pub groups: Vec<ServerGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerGroup {
    pub id: String,
    pub name: String,
}

/// A session just launched, as `POST /api/sessions` answers.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedSession {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// The group it was filed in. Missing from a Hangar that predates filing on launch.
    #[serde(default)]
    pub group_id: Option<String>,
}

/// Where a new session is to run and be filed, and what it is told first.
pub struct NewSession<'a> {
    pub folder: &'a str,
    pub project_id: Option<&'a str>,
    pub group_id: Option<&'a str>,
    pub prompt: &'a str,
}

/// A row of the session picker.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionItem {
    /// Tells the row apart from every other: the id, after the node's for a paired machine's session.
    pub key: String,
    pub id: String,
    /// The paired machine it runs on, reached through the server; None for the server's own.
    pub node: Option<String>,
    pub node_name: Option<String>,
    pub name: String,
    pub folder: String,
    pub color: Option<String>,
    pub project: Option<String>,
    pub project_color: Option<String>,
    pub busy: bool,
    pub claude_session_id: Option<String>,
    /// When a capture was last sent here (Unix ms), if ever.
    pub last_sent: Option<i64>,
}

pub struct Client {
    http: reqwest::Client,
    creds: Credentials,
    /// A paired machine whose API this client reaches through the server (`/n/{node}/…`), as the web
    /// UI does: one sign-in, and only the server has to be reachable from here.
    node: Option<String>,
}

impl Client {
    pub fn new(creds: Credentials) -> Self {
        let mut builder = reqwest::Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(60));
        if creds.local {
            // The instance file's token is only ever to go to this machine; an HTTP_PROXY in the
            // environment would otherwise carry it, in the clear, through the proxy.
            builder = builder.no_proxy();
        }
        let http = builder.build().expect("an HTTP client with timeouts always builds");
        Self { http, creds, node: None }
    }

    /// The same server's client for one of its paired machines. The server swaps its own token for the
    /// peer's on the way through.
    pub fn at_node(&self, node: &str) -> Self {
        Self { http: self.http.clone(), creds: self.creds.clone(), node: Some(node.to_string()) }
    }

    /// `url` moved under the paired machine's prefix, when this client is for one. The node is encoded
    /// whole, so whatever it holds stays one segment; a dot segment, which would step out of `/n/` even
    /// encoded, is refused.
    fn routed(&self, mut url: Url) -> Result<Url, ApiError> {
        if let Some(node) = &self.node {
            if matches!(node.as_str(), "" | "." | "..") {
                return Err(ApiError::Failed(format!("There is no machine \"{node}\" to reach")));
            }
            let node = percent_encoding::utf8_percent_encode(node, percent_encoding::NON_ALPHANUMERIC);
            let path = format!("/n/{node}{}", url.path());
            url.set_path(&path);
        }
        Ok(url)
    }

    pub fn credentials(&self) -> &Credentials {
        &self.creds
    }

    fn url(&self, path: &str) -> Result<Url, ApiError> {
        self.routed(self.creds.base.join(path).map_err(|e| ApiError::Failed(e.to_string()))?)
    }

    /// A URL under the session's own path, each segment percent-encoded.
    fn session_url(&self, session_id: &str, rest: &[&str]) -> Result<Url, ApiError> {
        let mut url = self.creds.base.join("/").map_err(|e| ApiError::Failed(e.to_string()))?;
        url.path_segments_mut()
            .map_err(|_| ApiError::Failed("The server URL can't take a path".into()))?
            .clear()
            .extend(["api", "sessions", session_id])
            .extend(rest);
        self.routed(url)
    }

    fn request(&self, method: reqwest::Method, path: &str) -> Result<reqwest::RequestBuilder, ApiError> {
        self.request_url(method, self.url(path)?)
    }

    fn request_url(&self, method: reqwest::Method, url: Url) -> Result<reqwest::RequestBuilder, ApiError> {
        let mut req = self.http.request(method, url);
        if let Some(token) = &self.creds.token {
            req = req.bearer_auth(token);
        }
        Ok(req)
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<reqwest::Response, ApiError> {
        let res = req.send().await.map_err(|e| {
            ApiError::Unreachable(format!("Could not reach {}: {}", self.creds.base, root_cause(&e)))
        })?;
        let status = res.status();
        if status.is_success() {
            return Ok(res);
        }
        let body = res.text().await.unwrap_or_default();
        let message = serde_json::from_str::<serde_json::Value>(&body)
            .ok()
            .and_then(|v| v.get("error").and_then(|e| e.as_str()).map(String::from))
            .unwrap_or_else(|| format!("The server answered {status}"));
        Err(match status.as_u16() {
            401 => ApiError::Unauthorized,
            404 => ApiError::NotFound(message),
            413 => ApiError::Failed("The picture is too big for the server to take (25 MB at most). Crop it, or send part of the screen.".into()),
            // A route the server doesn't have for this method: a Hangar from before the feature.
            405 => ApiError::Failed("This Hangar can't do that yet. Update it, then try again.".into()),
            _ => ApiError::Failed(message),
        })
    }

    /// Whether the server wants a password at all.
    pub async fn auth_required(&self) -> Result<bool, ApiError> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AuthConfig {
            auth_required: bool,
        }
        let res = self.send(self.request(reqwest::Method::GET, "/api/auth/config")?).await?;
        Ok(res.json::<AuthConfig>().await.map_err(|e| ApiError::Failed(e.to_string()))?.auth_required)
    }

    /// Trade the server's password for a bearer token.
    pub async fn login(&self, password: &str) -> Result<String, ApiError> {
        #[derive(Deserialize)]
        struct Token {
            token: String,
        }
        let req = self.http.post(self.url("/api/auth/login")?).json(&serde_json::json!({ "password": password }));
        match self.send(req).await {
            Ok(res) => Ok(res.json::<Token>().await.map_err(|e| ApiError::Failed(e.to_string()))?.token),
            Err(ApiError::Unauthorized) => Err(ApiError::Failed("Wrong password".into())),
            Err(e) => Err(e),
        }
    }

    pub async fn sessions(&self) -> Result<Vec<ServerSession>, ApiError> {
        let res = self.send(self.request(reqwest::Method::GET, "/api/sessions")?).await?;
        res.json().await.map_err(|e| ApiError::Failed(e.to_string()))
    }

    pub async fn busy(&self) -> Result<Vec<String>, ApiError> {
        let res = self.send(self.request(reqwest::Method::GET, "/api/sessions/activity")?).await?;
        res.json().await.map_err(|e| ApiError::Failed(e.to_string()))
    }

    pub async fn projects(&self) -> Result<Vec<ServerProject>, ApiError> {
        let res = self.send(self.request(reqwest::Method::GET, "/api/projects")?).await?;
        res.json().await.map_err(|e| ApiError::Failed(e.to_string()))
    }

    /// The folders sessions were started in lately, newest first.
    pub async fn recent_folders(&self) -> Result<Vec<String>, ApiError> {
        #[derive(Deserialize)]
        struct Recents {
            #[serde(default)]
            folders: Vec<String>,
        }
        let res = self.send(self.request(reqwest::Method::GET, "/api/recents")?).await?;
        Ok(res.json::<Recents>().await.map_err(|e| ApiError::Failed(e.to_string()))?.folders)
    }

    /// Remember a folder among the recent ones, as the browser does after a launch.
    pub async fn add_recent_folder(&self, path: &str) -> Result<(), ApiError> {
        let body = serde_json::json!({ "path": path });
        self.send(self.request(reqwest::Method::POST, "/api/recents/folders")?.json(&body)).await?;
        Ok(())
    }

    /// The folder `path` names on the server, written out in full (quotes, `~` and a relative path
    /// resolved the way the server's own folder field does) — or why it isn't one.
    pub async fn resolve_folder(&self, path: &str) -> Result<String, ApiError> {
        #[derive(Deserialize)]
        struct Resolved {
            found: bool,
            dir: Option<String>,
            file: Option<String>,
            error: Option<String>,
        }
        let mut url = self.url("/api/fs/resolve")?;
        url.query_pairs_mut().append_pair("path", path);
        let res = self.send(self.request_url(reqwest::Method::GET, url)?).await?;
        let r = res.json::<Resolved>().await.map_err(|e| ApiError::Failed(e.to_string()))?;
        match r {
            Resolved { found: true, dir: Some(dir), file: None, .. } => Ok(dir),
            Resolved { file: Some(_), .. } => Err(ApiError::Failed(format!("{path} is a file, not a folder."))),
            Resolved { error, .. } => Err(ApiError::Failed(error.unwrap_or_else(|| format!("There is no folder {path} on the server.")))),
        }
    }

    /// Put `bytes` into `folder` on the server's disk as `name` (creating the folder first), for a
    /// session that doesn't exist yet to be pointed at. Answers the file's full path.
    pub async fn upload_to_folder(&self, folder: &str, name: &str, bytes: &[u8]) -> Result<String, ApiError> {
        #[derive(Deserialize)]
        struct Uploaded {
            paths: Vec<String>,
        }
        let mkdir = serde_json::json!({ "path": folder });
        self.send(self.request(reqwest::Method::POST, "/api/fs/mkdir")?.json(&mkdir)).await?;
        let part = reqwest::multipart::Part::bytes(bytes.to_vec())
            .file_name(name.to_string())
            .mime_str("image/png")
            .map_err(|e| ApiError::Failed(e.to_string()))?;
        let form = reqwest::multipart::Form::new().text("path", folder.to_string()).part("file", part);
        let res = self.send(self.request(reqwest::Method::POST, "/api/fs/upload")?.multipart(form)).await?;
        let uploaded = res.json::<Uploaded>().await.map_err(|e| ApiError::Failed(e.to_string()))?;
        uploaded.paths.into_iter().next().ok_or_else(|| ApiError::Failed("The server kept no file".into()))
    }

    /// Launch a session. A request the server can't honour (no such folder, a folder in another
    /// project) comes back as `Failed` with its reason.
    pub async fn create_session(&self, s: &NewSession<'_>) -> Result<CreatedSession, ApiError> {
        let body = serde_json::json!({
            "workingDirectory": s.folder,
            "initialPrompt": s.prompt,
            "projectId": s.project_id,
            "groupId": s.group_id,
        });
        let res = self.send(self.request(reqwest::Method::POST, "/api/sessions")?.json(&body)).await?;
        res.json().await.map_err(|e| ApiError::Failed(e.to_string()))
    }

    /// Put a PNG into the session's uploads folder; answers the path to name it by in a message.
    pub async fn upload_image(&self, session_id: &str, png: &[u8]) -> Result<String, ApiError> {
        #[derive(Deserialize)]
        struct Uploaded {
            path: String,
        }
        let url = self.session_url(session_id, &["fs", "upload-image"])?;
        let body = serde_json::json!({
            "dataBase64": base64::engine::general_purpose::STANDARD.encode(png),
            "ext": "png",
        });
        let res = self.send(self.request_url(reqwest::Method::POST, url)?.json(&body)).await?;
        Ok(res.json::<Uploaded>().await.map_err(|e| ApiError::Failed(e.to_string()))?.path)
    }

    /// Stash `text` and the uploaded `images` in the session's postponed messages, to be sent later
    /// from Hangar (or by its auto-send) instead of now.
    pub async fn postpone(&self, session_id: &str, text: &str, images: &[String]) -> Result<(), ApiError> {
        let url = self.session_url(session_id, &["postponed", "items"])?;
        let body = serde_json::json!({ "text": text, "images": images });
        self.send(self.request_url(reqwest::Method::POST, url)?.json(&body)).await?;
        Ok(())
    }

    /// Type `text` into the session's Claude, with the uploaded `images` pasted after it, and submit.
    pub async fn message(&self, session_id: &str, text: &str, images: &[String]) -> Result<(), ApiError> {
        let url = self.session_url(session_id, &["message"])?;
        let body = serde_json::json!({ "text": text, "images": images });
        self.send(self.request_url(reqwest::Method::POST, url)?.json(&body)).await?;
        Ok(())
    }

    /// The pty hosts still running for sessions the server no longer knows about.
    pub async fn orphans(&self) -> Result<Vec<Orphan>, ApiError> {
        let res = self.send(self.request(reqwest::Method::GET, "/api/pty/orphans")?).await?;
        res.json().await.map_err(|e| ApiError::Failed(e.to_string()))
    }

    /// Stop every orphaned pty host, and the claude under each. Answers how many stopped.
    pub async fn stop_orphans(&self) -> Result<u32, ApiError> {
        #[derive(Deserialize)]
        struct Stopped {
            #[serde(default)]
            stopped: u32,
        }
        // No id: all of them.
        let req = self.request(reqwest::Method::POST, "/api/pty/orphans/stop")?.json(&serde_json::json!({}));
        let res = self.send(req).await?;
        Ok(res.json::<Stopped>().await.map_err(|e| ApiError::Failed(e.to_string()))?.stopped)
    }

    /// Ask the server to shut down. Its sessions keep running in their pty hosts, and the next server
    /// to start picks them up again.
    pub async fn stop_daemon(&self) -> Result<(), ApiError> {
        self.send(self.request(reqwest::Method::POST, "/api/daemon/stop")?).await?;
        Ok(())
    }
}

/// A pty host still running for a session the server no longer tracks (`PtyOrphanInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Orphan {
    #[serde(default)]
    pub child_pid: u32,
    #[serde(default)]
    pub working_directory: String,
}

/// reqwest's own message for a refused connection is "error sending request"; the reason is further
/// down the chain.
fn root_cause(e: &dyn std::error::Error) -> String {
    let mut cur = e;
    while let Some(next) = cur.source() {
        cur = next;
    }
    cur.to_string()
}

/// One machine's sessions for the picker: the server's own (`node` None), or a paired machine's.
pub struct PickerSource {
    /// The paired machine's id and name.
    pub node: Option<(String, String)>,
    pub sessions: Vec<ServerSession>,
    pub busy: Vec<String>,
    pub projects: Vec<ServerProject>,
}

/// Where a session's recents are kept: under the server, or under the server's way to its peer.
pub fn recents_key(server: &str, node: Option<&str>) -> String {
    match node {
        Some(node) => format!("{}/n/{node}", server.trim_end_matches('/')),
        None => server.to_string(),
    }
}

/// The picker's rows: running sessions only, the ones sent to most recently first, then the rest —
/// the server's own before its paired machines', each newest first.
pub fn picker_items(sources: Vec<PickerSource>, recents: &[Recent], server: &str) -> Vec<SessionItem> {
    let mut rows: Vec<(SessionItem, Option<String>)> = Vec::new();
    for source in sources {
        rows.extend(source_rows(source, recents, server));
    }
    rows.sort_by(|(a, a_created), (b, b_created)| match (a.last_sent, b.last_sent) {
        (Some(x), Some(y)) => y.cmp(&x),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        // ISO-8601 timestamps sort as strings.
        (None, None) => a.node.is_some().cmp(&b.node.is_some()).then_with(|| b_created.cmp(a_created)),
    });
    rows.into_iter().map(|(item, _)| item).collect()
}

fn source_rows(source: PickerSource, recents: &[Recent], server: &str) -> Vec<(SessionItem, Option<String>)> {
    let PickerSource { node, sessions, busy, projects } = source;
    let place = recents_key(server, node.as_ref().map(|(id, _)| id.as_str()));
    let last_sent = |s: &ServerSession| {
        recents
            .iter()
            .filter(|r| r.server == place)
            .find(|r| {
                r.session_id == s.id
                    || (s.claude_session_id.is_some() && r.claude_session_id == s.claude_session_id)
            })
            .map(|r| r.last_sent)
    };
    sessions
        .into_iter()
        .filter(|s| s.state.eq_ignore_ascii_case("running"))
        .map(|s| {
            let project = s.project_id.as_ref().and_then(|id| projects.iter().find(|p| &p.id == id));
            let folder = s
                .working_directory
                .replace('\\', "/")
                .trim_end_matches('/')
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            let item = SessionItem {
                key: match &node {
                    Some((node, _)) => format!("{node}/{}", s.id),
                    None => s.id.clone(),
                },
                node: node.as_ref().map(|(id, _)| id.clone()),
                node_name: node.as_ref().map(|(_, name)| name.clone()),
                busy: busy.contains(&s.id),
                last_sent: last_sent(&s),
                project: project.map(|p| p.name.clone()),
                project_color: project.and_then(|p| p.color.clone()),
                id: s.id,
                name: s.name,
                folder,
                color: s.color,
                claude_session_id: s.claude_session_id,
            };
            (item, s.created_at)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str, dir: &str, state: &str, created: &str) -> ServerSession {
        ServerSession {
            id: id.into(),
            name: format!("name-{id}"),
            working_directory: dir.into(),
            state: state.into(),
            color: None,
            claude_session_id: Some(format!("conv-{id}")),
            created_at: Some(created.into()),
            project_id: None,
        }
    }

    fn own(sessions: Vec<ServerSession>, busy: &[&str], projects: Vec<ServerProject>) -> PickerSource {
        PickerSource { node: None, sessions, busy: busy.iter().map(|s| s.to_string()).collect(), projects }
    }

    fn recent(server: &str, id: &str, conv: Option<&str>, at: i64) -> Recent {
        Recent { server: server.into(), session_id: id.into(), claude_session_id: conv.map(Into::into), last_sent: at }
    }

    #[test]
    fn picker_puts_recent_targets_first_then_newest() {
        let sessions = vec![
            session("old", "C:\\Git\\a", "Running", "2026-10-01T10:00:00+00:00"),
            session("new", "C:\\Git\\b", "Running", "2026-10-05T10:00:00+00:00"),
            session("sent-long-ago", "C:\\Git\\c", "Running", "2026-09-01T10:00:00+00:00"),
            session("sent-just-now", "C:\\Git\\d", "Running", "2026-09-02T10:00:00+00:00"),
            session("exited", "C:\\Git\\e", "Exited", "2026-10-06T10:00:00+00:00"),
        ];
        let recents = vec![
            recent("srv", "sent-just-now", None, 200),
            recent("srv", "sent-long-ago", None, 100),
            recent("other-srv", "old", None, 999),
        ];
        let ids: Vec<_> =
            picker_items(vec![own(sessions, &[], vec![])], &recents, "srv").into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["sent-just-now", "sent-long-ago", "new", "old"]);
    }

    #[test]
    fn picker_recognises_a_reopened_conversation() {
        let sessions = vec![session("reopened", "/home/me/x", "Running", "2026-10-01T00:00:00Z")];
        let recents = vec![recent("srv", "gone-id", Some("conv-reopened"), 50)];
        let items = picker_items(vec![own(sessions, &[], vec![])], &recents, "srv");
        assert_eq!(items[0].last_sent, Some(50));
    }

    #[test]
    fn picker_fills_in_project_folder_and_busy() {
        let projects = vec![
            ServerProject { id: "p-git".into(), name: "Git".into(), color: Some("blue".into()), folders: vec![], groups: vec![] },
            ServerProject { id: "p-home".into(), name: "Home".into(), color: None, folders: vec![], groups: vec![] },
        ];
        let mut a = session("a", "C:\\Git\\myproject\\", "Running", "1");
        a.project_id = Some("p-home".into());
        let mut b = session("b", "/home/me/other", "Running", "2");
        b.project_id = Some("p-git".into());
        let mut c = session("c", "C:\\Gitlab", "Running", "3");
        c.project_id = Some("p-deleted".into());
        let items = picker_items(vec![own(vec![a, b, c], &["a"], projects)], &[], "srv");
        let a = items.iter().find(|i| i.id == "a").unwrap();
        assert_eq!((a.project.as_deref(), a.folder.as_str(), a.busy), (Some("Home"), "myproject", true));
        let b = items.iter().find(|i| i.id == "b").unwrap();
        assert_eq!((b.project.as_deref(), b.project_color.as_deref(), b.folder.as_str()), (Some("Git"), Some("blue"), "other"));
        assert_eq!(items.iter().find(|i| i.id == "c").unwrap().project, None, "a project that's gone names nothing");
    }

    #[test]
    fn picker_lists_paired_machines_after_the_servers_own_and_by_their_own_recents() {
        let nas = |sessions| PickerSource {
            node: Some(("nas-id".into(), "NAS".into())),
            sessions,
            busy: vec!["x".into()],
            projects: vec![],
        };
        let sources = vec![
            own(vec![session("here", "C:\\a", "Running", "2026-10-01T00:00:00Z")], &[], vec![]),
            nas(vec![
                session("x", "/srv/x", "Running", "2026-10-09T00:00:00Z"),
                session("y", "/srv/y", "Running", "2026-10-08T00:00:00Z"),
            ]),
        ];
        // Sent to y on the NAS; a recent under the server itself for "x" is another machine's.
        let recents = vec![recent("http://srv:5099/n/nas-id", "y", None, 10), recent("http://srv:5099/", "x", None, 20)];
        let items = picker_items(sources, &recents, "http://srv:5099/");
        let keys: Vec<_> = items.iter().map(|i| i.key.as_str()).collect();
        assert_eq!(keys, ["nas-id/y", "here", "nas-id/x"]);
        let x = &items[2];
        assert_eq!((x.id.as_str(), x.node.as_deref(), x.node_name.as_deref(), x.busy, x.last_sent), ("x", Some("nas-id"), Some("NAS"), true, None));
        assert_eq!(items[1].node, None);
    }

    #[test]
    fn a_node_stays_one_segment_under_n() {
        let client = Client::new(Credentials { base: Url::parse("http://srv:5099/").unwrap(), token: None, local: false });
        for node in ["a/../..", "%2e%2e", ".x"] {
            let url = client.at_node(node).url("/api/sessions").unwrap();
            let segments: Vec<_> = url.path_segments().unwrap().collect();
            assert_eq!((segments.len(), segments[0], &segments[2..]), (4, "n", &["api", "sessions"][..]), "{node} -> {url}");
        }
        for node in ["", ".", ".."] {
            assert!(client.at_node(node).url("/api/sessions").is_err(), "{node:?}");
            assert!(client.at_node(node).session_url("s", &["message"]).is_err(), "{node:?}");
        }
    }

    #[tokio::test]
    async fn a_paired_machines_client_goes_through_the_server() {
        let mut server = mockito::Server::new_async().await;
        let sessions = server.mock("GET", "/n/nas%2Fid/api/sessions").with_body("[]").create_async().await;
        let message = server.mock("POST", "/n/nas%2Fid/api/sessions/s%201/message").create_async().await;
        let client = Client::new(Credentials { base: Url::parse(&server.url()).unwrap(), token: Some("tok".into()), local: false });
        let nas = client.at_node("nas/id");
        assert!(nas.sessions().await.unwrap().is_empty());
        nas.message("s 1", "look", &[]).await.unwrap();
        sessions.assert_async().await;
        message.assert_async().await;
    }

    fn instances_dir_with(port: u16, body: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hangar-tray-inst-{port}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{port}.json")), body).unwrap();
        dir
    }

    #[test]
    fn local_server_uses_its_instance_token() {
        let dir = instances_dir_with(
            5099,
            r#"{"pid":1,"port":5099,"localUrl":"http://127.0.0.1:5099","openUrl":"x","token":"local-tok","startedAt":"2026-01-01T00:00:00Z"}"#,
        );
        let c = resolve_credentials("http://localhost:5099", Some("saved"), std::slice::from_ref(&dir)).unwrap();
        assert_eq!((c.base.as_str(), c.token.as_deref(), c.local), ("http://127.0.0.1:5099/", Some("local-tok"), true));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn instance_file_pointing_off_machine_is_ignored() {
        let dir = instances_dir_with(5098, r#"{"localUrl":"http://evil.example:5098","token":"t"}"#);
        let c = resolve_credentials("http://127.0.0.1:5098", Some("saved"), std::slice::from_ref(&dir)).unwrap();
        assert_eq!((c.token.as_deref(), c.local), (Some("saved"), false));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn remote_server_uses_the_saved_token() {
        let dir = instances_dir_with(5097, r#"{"localUrl":"http://127.0.0.1:5097","token":"t"}"#);
        let c = resolve_credentials("http://nas.lan:5097", Some("saved"), std::slice::from_ref(&dir)).unwrap();
        assert_eq!((c.token.as_deref(), c.local), (Some("saved"), false));
        assert!(resolve_credentials("ftp://x", None, &[]).is_err());
        assert!(resolve_credentials("not a url", None, &[]).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn sends_an_image_then_the_message_naming_it() {
        let mut server = mockito::Server::new_async().await;
        let upload = server
            .mock("POST", "/api/sessions/s%201/fs/upload-image")
            .match_header("authorization", "Bearer tok")
            .match_body(mockito::Matcher::PartialJson(serde_json::json!({ "ext": "png", "dataBase64": "iVBORw==" })))
            .with_body(r#"{"path":".hangar/uploads/pasted-1.png","fullPath":"C:\\x\\pasted-1.png"}"#)
            .create_async()
            .await;
        let message = server
            .mock("POST", "/api/sessions/s%201/message")
            .match_body(mockito::Matcher::Json(serde_json::json!({
                "text": "look", "images": [".hangar/uploads/pasted-1.png"]
            })))
            .create_async()
            .await;
        let client = Client::new(Credentials { base: Url::parse(&server.url()).unwrap(), token: Some("tok".into()), local: false });
        let path = client.upload_image("s 1", &[0x89, b'P', b'N', b'G']).await.unwrap();
        client.message("s 1", "look", &[path]).await.unwrap();
        upload.assert_async().await;
        message.assert_async().await;
    }

    #[tokio::test]
    async fn starts_a_session_with_its_picture_uploaded_first() {
        let mut server = mockito::Server::new_async().await;
        let mkdir = server
            .mock("POST", "/api/fs/mkdir")
            .match_body(mockito::Matcher::Json(serde_json::json!({ "path": "C:/work/.hangar/uploads" })))
            .with_body(r#"{"path":"C:/work/.hangar/uploads"}"#)
            .create_async()
            .await;
        let upload = server
            .mock("POST", "/api/fs/upload")
            .match_body(mockito::Matcher::AllOf(vec![
                mockito::Matcher::Regex("name=\"path\"".into()),
                mockito::Matcher::Regex("filename=\"pasted.png\"".into()),
            ]))
            .with_body(r#"{"paths":["C:/work/.hangar/uploads/pasted.png"]}"#)
            .create_async()
            .await;
        let create = server
            .mock("POST", "/api/sessions")
            .match_body(mockito::Matcher::Json(serde_json::json!({
                "workingDirectory": "C:/work",
                "initialPrompt": "look",
                "projectId": "p1",
                "groupId": null,
            })))
            .with_status(201)
            .with_body(r#"{"id":"s1","name":"work","state":"Running","groupId":null}"#)
            .create_async()
            .await;
        let client = Client::new(Credentials { base: Url::parse(&server.url()).unwrap(), token: None, local: false });
        let path = client.upload_to_folder("C:/work/.hangar/uploads", "pasted.png", b"png").await.unwrap();
        assert_eq!(path, "C:/work/.hangar/uploads/pasted.png");
        let created = client
            .create_session(&NewSession { folder: "C:/work", project_id: Some("p1"), group_id: None, prompt: "look" })
            .await
            .unwrap();
        assert_eq!((created.id.as_str(), created.name.as_str(), created.group_id), ("s1", "work", None));
        mkdir.assert_async().await;
        upload.assert_async().await;
        create.assert_async().await;
    }

    #[tokio::test]
    async fn a_folder_must_be_there_to_start_in() {
        let mut server = mockito::Server::new_async().await;
        let _ok = server
            .mock("GET", "/api/fs/resolve")
            .match_query(mockito::Matcher::UrlEncoded("path".into(), "~/work".into()))
            .with_body(r#"{"found":true,"dir":"/home/me/work","file":null}"#)
            .create_async()
            .await;
        let _missing = server
            .mock("GET", "/api/fs/resolve")
            .match_query(mockito::Matcher::UrlEncoded("path".into(), "/nope".into()))
            .with_body(r#"{"found":false,"dir":null,"file":null,"error":"No such folder"}"#)
            .create_async()
            .await;
        let _file = server
            .mock("GET", "/api/fs/resolve")
            .match_query(mockito::Matcher::UrlEncoded("path".into(), "/a.txt".into()))
            .with_body(r#"{"found":true,"dir":"/","file":"/a.txt"}"#)
            .create_async()
            .await;
        let client = Client::new(Credentials { base: Url::parse(&server.url()).unwrap(), token: None, local: false });
        assert_eq!(client.resolve_folder("~/work").await, Ok("/home/me/work".to_string()));
        assert_eq!(client.resolve_folder("/nope").await, Err(ApiError::Failed("No such folder".into())));
        assert_eq!(client.resolve_folder("/a.txt").await, Err(ApiError::Failed("/a.txt is a file, not a folder.".into())));
    }

    #[tokio::test]
    async fn maps_server_errors() {
        let mut server = mockito::Server::new_async().await;
        let _a = server.mock("GET", "/api/sessions").with_status(401).create_async().await;
        let _b = server
            .mock("POST", "/api/sessions/x/message")
            .with_status(404)
            .with_body(r#"{"error":"No running session with that id."}"#)
            .create_async()
            .await;
        let _c = server.mock("POST", "/api/auth/login").with_status(401).create_async().await;
        let _d = server.mock("POST", "/api/sessions/x/postponed/items").with_status(405).create_async().await;
        let client = Client::new(Credentials { base: Url::parse(&server.url()).unwrap(), token: None, local: false });
        assert_eq!(client.sessions().await, Err(ApiError::Unauthorized));
        assert_eq!(client.message("x", "t", &[]).await, Err(ApiError::NotFound("No running session with that id.".into())));
        assert_eq!(client.login("nope").await, Err(ApiError::Failed("Wrong password".into())));
        assert_eq!(
            client.postpone("x", "t", &[]).await,
            Err(ApiError::Failed("This Hangar can't do that yet. Update it, then try again.".into()))
        );

        let dead = Client::new(Credentials { base: Url::parse("http://127.0.0.1:9").unwrap(), token: None, local: false });
        assert!(matches!(dead.sessions().await, Err(ApiError::Unreachable(_))));
    }
}
