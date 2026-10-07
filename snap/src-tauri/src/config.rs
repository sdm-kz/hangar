//! What the app remembers between runs: where the server is and how to sign in to it, the hotkeys,
//! and which sessions captures were sent to (so the picker can put the latest first). Plain JSON files
//! in the platform's config folder; a file that is missing or unreadable reads as the defaults.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_SERVER_URL: &str = "http://127.0.0.1:5099";
/// How many sent-to sessions are remembered. The picker only ever shows the running ones, so this is
/// just a bound on the file.
const MAX_RECENTS: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Hotkeys {
    pub region: String,
    pub window: String,
    pub fullscreen: String,
    pub freeform: String,
}

impl Default for Hotkeys {
    // Ctrl+Shift+digit is free on all three desktops — macOS keeps Cmd+Shift+3/4/5 for itself, but
    // leaves Control alone — and the digits read in the order the tray menu lists the modes. An empty
    // string means "no hotkey".
    fn default() -> Self {
        Self {
            region: "Ctrl+Shift+1".into(),
            window: "Ctrl+Shift+2".into(),
            fullscreen: "Ctrl+Shift+3".into(),
            freeform: "Ctrl+Shift+4".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Base URL of the Homeport server.
    pub server_url: String,
    /// Bearer token from signing in with the server's password. Not needed when the server is on this
    /// machine: its instance file carries a token of its own (see `api::Credentials`).
    pub token: Option<String>,
    pub hotkeys: Hotkeys,
}

impl Default for Settings {
    fn default() -> Self {
        Self { server_url: DEFAULT_SERVER_URL.into(), token: None, hotkeys: Hotkeys::default() }
    }
}

/// One session a capture was sent to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Recent {
    /// The server it lives on, as `Settings::server_url` named it — so pointing the app at another
    /// server doesn't float that server's sessions by the ids of this one's.
    pub server: String,
    pub session_id: String,
    /// The conversation behind it, which outlives the session id when a session is reopened.
    #[serde(default)]
    pub claude_session_id: Option<String>,
    /// Unix milliseconds.
    pub last_sent: i64,
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn load_settings(&self) -> Settings {
        read_json(&self.dir.join("settings.json")).unwrap_or_default()
    }

    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        write_json(&self.dir.join("settings.json"), settings)
    }

    pub fn load_recents(&self) -> Vec<Recent> {
        read_json(&self.dir.join("recents.json")).unwrap_or_default()
    }

    /// Note that a capture went to `session_id` just now, and save.
    pub fn touch_recent(
        &self,
        server: &str,
        session_id: &str,
        claude_session_id: Option<&str>,
        now: i64,
    ) -> Result<Vec<Recent>, String> {
        let recents = touched(self.load_recents(), server, session_id, claude_session_id, now);
        write_json(&self.dir.join("recents.json"), &recents)?;
        Ok(recents)
    }
}

/// `recents` with `session_id` moved to the front, stamped `now`. An entry for the same conversation
/// under an older session id is the same target, and is replaced rather than kept beside it.
pub fn touched(
    mut recents: Vec<Recent>,
    server: &str,
    session_id: &str,
    claude_session_id: Option<&str>,
    now: i64,
) -> Vec<Recent> {
    recents.retain(|r| {
        r.server != server
            || (r.session_id != session_id
                && !(claude_session_id.is_some() && r.claude_session_id.as_deref() == claude_session_id))
    });
    recents.insert(
        0,
        Recent {
            server: server.into(),
            session_id: session_id.into(),
            claude_session_id: claude_session_id.map(Into::into),
            last_sent: now,
        },
    );
    recents.truncate(MAX_RECENTS);
    recents
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    match serde_json::from_str(&text) {
        Ok(v) => Some(v),
        Err(e) => {
            log::warn!("Ignoring unreadable {}: {e}", path.display());
            None
        }
    }
}

/// Write via a temporary file and a rename, so a crash mid-write leaves the old file, not half a new
/// one. Readable by this user only on Unix: the settings carry a bearer token, so the file is created
/// 0600 rather than narrowed after it has been written (a leftover temp file is removed first, so it
/// can't hand its own, wider, permissions to the new content).
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    use std::io::Write;
    let dir = path.parent().ok_or("no parent folder")?;
    fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(&tmp)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("Could not replace {}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("homeport-snap-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn missing_files_read_as_defaults() {
        let store = Store::new(temp_dir("missing"));
        assert_eq!(store.load_settings(), Settings::default());
        assert!(store.load_recents().is_empty());
    }

    #[test]
    fn settings_round_trip_and_tolerate_partial_files() {
        let dir = temp_dir("roundtrip");
        let store = Store::new(dir.clone());
        let s = Settings {
            server_url: "http://nas:5099".into(),
            token: Some("abc".into()),
            hotkeys: Hotkeys { window: String::new(), ..Hotkeys::default() },
        };
        store.save_settings(&s).unwrap();
        assert_eq!(store.load_settings(), s);

        fs::write(dir.join("settings.json"), r#"{"serverUrl":"http://x:1"}"#).unwrap();
        let partial = store.load_settings();
        assert_eq!(partial.server_url, "http://x:1");
        assert_eq!(partial.hotkeys, Hotkeys::default(), "absent fields take their defaults");

        fs::write(dir.join("settings.json"), "{ not json").unwrap();
        assert_eq!(store.load_settings(), Settings::default());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn touching_moves_to_front_and_dedupes_by_session_and_conversation() {
        let r = touched(vec![], "s", "a", Some("conv-a"), 1);
        let r = touched(r, "s", "b", None, 2);
        let r = touched(r, "other", "a", None, 3);
        assert_eq!(r.iter().map(|x| (x.server.as_str(), x.session_id.as_str())).collect::<Vec<_>>(),
            vec![("other", "a"), ("s", "b"), ("s", "a")]);

        // The conversation behind "a" reopened as "a2": one entry, at the front.
        let r = touched(r, "s", "a2", Some("conv-a"), 4);
        let ids: Vec<_> = r.iter().filter(|x| x.server == "s").map(|x| x.session_id.as_str()).collect();
        assert_eq!(ids, vec!["a2", "b"]);
        assert_eq!(r[0].last_sent, 4);
    }

    #[test]
    fn recents_are_bounded() {
        let mut r = vec![];
        for i in 0..(MAX_RECENTS + 10) {
            r = touched(r, "s", &format!("id{i}"), None, i as i64);
        }
        assert_eq!(r.len(), MAX_RECENTS);
        assert_eq!(r[0].session_id, format!("id{}", MAX_RECENTS + 9));
    }

    #[test]
    fn touch_recent_persists() {
        let dir = temp_dir("recents");
        let store = Store::new(dir.clone());
        store.touch_recent("s", "a", None, 10).unwrap();
        store.touch_recent("s", "b", None, 20).unwrap();
        let loaded = store.load_recents();
        assert_eq!(loaded.iter().map(|r| r.session_id.as_str()).collect::<Vec<_>>(), vec!["b", "a"]);
        let _ = fs::remove_dir_all(dir);
    }
}
