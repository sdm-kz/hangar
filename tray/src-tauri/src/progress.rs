//! What the running sessions are up to, for the menu's **Activity** submenu: the same reading the web
//! app's Sessions-tab fraction gives (finished / everything doing something), and the sessions behind
//! it grouped the way its dropdown groups them — waiting on you, working, finished.
//!
//! Everything but "finished" is in the hub's snapshot. "Finished" is a turn that ended since you last
//! looked, and looking is a fact about wherever you looked: the web app keeps its ticks per browser, and
//! the tray keeps its own here — set when a session leaves the working set, cleared when it is opened
//! from the tray (or marked seen there), starts working again, or stops running.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::session_tree::HubSession;

/// The id sets a session's activity is read from, as a `/hub/events` snapshot carries them.
#[derive(Debug, Clone, PartialEq, Eq, Default, Deserialize)]
#[serde(default)]
pub struct Ids {
    /// Claude is generating.
    pub busy: HashSet<String>,
    /// Claude is blocked on you — a permission prompt, a selection dialog.
    pub waiting: HashSet<String>,
    /// Claude is compacting the conversation: still working, just not on your task.
    pub compacting: HashSet<String>,
    /// The last turn ended on an API error rather than an answer.
    pub failed: HashSet<String>,
    /// Claude's turn is over but shells it started are still running, with how many.
    pub background: HashMap<String, u32>,
}

impl Ids {
    // Shells left running count: the turn is over, but what you are waiting on isn't, and the tick
    // comes when it is.
    fn working(&self, id: &str) -> bool {
        self.busy.contains(id) || self.compacting.contains(id) || self.background.contains_key(id)
    }

    // A turn, as opposed to a compaction alone. Claude compacts an idle conversation on its own, and
    // that ending is housekeeping finishing, not anything you asked for: it neither ticks a session
    // nor takes away the tick of the turn before it. The web app draws the same line (`useDoneSessions`).
    fn ran(&self, id: &str) -> bool {
        self.busy.contains(id) || self.background.contains_key(id)
    }
}

/// A session, wherever it runs: its node (None for the server's own) and its id.
pub type Key = (Option<String>, String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Activity {
    Compacting,
    Busy,
    Waiting,
    Failed,
    Background,
    Done,
}

/// What a session is doing, in the web app's order of precedence (`sessionActivity`): anything it is
/// doing now outranks the past-tense "finished". None for a session doing nothing worth showing.
pub fn activity(s: &HubSession, ids: &Ids, done: bool) -> Option<Activity> {
    if ids.compacting.contains(&s.id) {
        Some(Activity::Compacting)
    } else if ids.busy.contains(&s.id) {
        Some(Activity::Busy)
    } else if ids.waiting.contains(&s.id) {
        Some(Activity::Waiting)
    } else if ids.failed.contains(&s.id) {
        Some(Activity::Failed)
    } else if ids.background.contains_key(&s.id) {
        Some(Activity::Background)
    } else if done {
        Some(Activity::Done)
    } else {
        None
    }
}

/// The dropdown's groups, most urgent first; every activity falls in exactly one.
pub const GROUPS: [(&str, &[Activity]); 3] = [
    ("Waiting on you", &[Activity::Waiting, Activity::Failed]),
    ("Working", &[Activity::Busy, Activity::Compacting, Activity::Background]),
    ("Finished", &[Activity::Done]),
];

/// One machine's sessions and activity, as of the latest frame.
pub struct Machine<'a> {
    pub node: Option<&'a str>,
    pub sessions: &'a [HubSession],
    pub ids: &'a Ids,
}

/// How long after a session is opened from the tray a burst of work in it is disbelieved: the browser
/// attaching repaints its terminal, and on an older pty host a repaint reads as a short turn. The web
/// app holds the same window (`ATTACH_SETTLE_MS`).
const OPEN_SETTLE: Duration = Duration::from_secs(5);

/// Which sessions have finished a turn the tray hasn't shown you since. A turn finishing is a
/// transition — a session dropping out of the working set — so it can't be read off one snapshot;
/// this remembers the last one's working set per machine — each session in it with whether that
/// stretch of work had a turn in it, or was only a compaction.
#[derive(Default)]
pub struct Tracker {
    working: HashMap<Option<String>, HashMap<String, bool>>,
    done: BTreeSet<Key>,
    opened: HashMap<Key, Instant>,
}

impl Tracker {
    /// Forget the working sets, so the first frame after a reconnect seeds them rather than ticking
    /// whatever stopped while the socket was down — a stop that may as well have been a prompt.
    pub fn reset(&mut self) {
        self.working.clear();
    }

    /// Take in one frame, from the machines it lists. A machine missing from it (a peer away) keeps
    /// its ticks: its sessions seeming to stop says nothing about them.
    pub fn observe(&mut self, machines: &[Machine]) -> BTreeSet<Key> {
        // A machine away forgets what it was doing, as a reconnect does: when it is back, its first
        // frame seeds rather than ticking whatever stopped in between.
        self.working.retain(|node, _| machines.iter().any(|m| m.node == node.as_deref()));
        self.opened.retain(|_, at| at.elapsed() < OPEN_SETTLE);
        for m in machines {
            let node = m.node.map(String::from);
            // A paused session never counts as working, so its turns ending tick nothing.
            let prev = self.working.get(&node);
            let working: HashMap<String, bool> = m
                .sessions
                .iter()
                .filter(|s| !s.activity_paused && m.ids.working(&s.id))
                .map(|s| {
                    let ran = m.ids.ran(&s.id) || prev.and_then(|p| p.get(&s.id)).copied().unwrap_or(false);
                    (s.id.clone(), ran)
                })
                .collect();
            if let Some(prev) = prev {
                // Stopping to wait on you, or on an error, isn't finishing: those have marks of their own.
                for (id, &ran) in prev {
                    let key = (node.clone(), id.clone());
                    if ran
                        && !working.contains_key(id)
                        && !m.ids.waiting.contains(id)
                        && !m.ids.failed.contains(id)
                        && !self.opened.contains_key(&key)
                    {
                        self.done.insert(key);
                    }
                }
            }
            // A new turn, a prompt or an error supersedes the last result; a session gone or stopped
            // has nothing left to look at. Judged only against a list there is: a peer whose snapshot
            // didn't read has none, which says nothing about its sessions.
            self.done.retain(|(n, id)| {
                *n != node
                    || (!m.ids.ran(id)
                        && !m.ids.waiting.contains(id)
                        && !m.ids.failed.contains(id)
                        && (m.sessions.is_empty() || m.sessions.iter().any(|s| s.id == *id && s.counts_in_activity())))
            });
            self.working.insert(node, working);
        }
        self.done.clone()
    }

    /// You've seen these: marked seen from the tray.
    pub fn seen<'a>(&mut self, keys: impl IntoIterator<Item = &'a Key>) -> BTreeSet<Key> {
        for key in keys {
            self.done.remove(key);
        }
        self.done.clone()
    }

    /// You've opened this one from the tray: seen, and the repaint of its being opened isn't a turn.
    pub fn opened(&mut self, key: &Key) -> BTreeSet<Key> {
        self.opened.insert(key.clone(), Instant::now());
        self.seen([key])
    }
}

/// The fraction: how many of the sessions doing anything have finished, of how many.
pub fn fraction(machines: &[Machine], done: &BTreeSet<Key>) -> (usize, usize) {
    let mut finished = 0;
    let mut active = 0;
    for m in machines {
        for s in m.sessions.iter().filter(|s| s.counts_in_activity()) {
            let key = (m.node.map(String::from), s.id.clone());
            match activity(s, m.ids, done.contains(&key)) {
                Some(Activity::Done) => {
                    finished += 1;
                    active += 1;
                }
                Some(_) => active += 1,
                None => {}
            }
        }
    }
    (finished, active)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(id: &str) -> HubSession {
        serde_json::from_value(serde_json::json!({ "id": id, "name": id, "workingDirectory": "/w", "state": "Running" })).unwrap()
    }

    fn ids(busy: &[&str], waiting: &[&str]) -> Ids {
        Ids {
            busy: busy.iter().map(|s| s.to_string()).collect(),
            waiting: waiting.iter().map(|s| s.to_string()).collect(),
            ..Ids::default()
        }
    }

    fn own(key: &str) -> Key {
        (None, key.to_string())
    }

    #[test]
    fn a_session_leaving_the_working_set_has_finished() {
        let sessions = [session("a"), session("b"), session("c")];
        let mut t = Tracker::default();
        let first = ids(&["a", "b", "c"], &[]);
        assert!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &first }]).is_empty(), "the first frame only seeds");
        let next = ids(&["c"], &["b"]);
        let done = t.observe(&[Machine { node: None, sessions: &sessions, ids: &next }]);
        assert_eq!(done, BTreeSet::from([own("a")]), "b stopped to wait on you; c is still going");
        assert_eq!(fraction(&[Machine { node: None, sessions: &sessions, ids: &next }], &done), (1, 3));
    }

    #[test]
    fn a_tick_goes_on_a_new_turn_on_being_seen_or_on_the_session_stopping() {
        let mut sessions = vec![session("a"), session("b")];
        let mut t = Tracker::default();
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["a", "b"], &[]) }]);
        assert_eq!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]).len(), 2);
        assert_eq!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["a"], &[]) }]), BTreeSet::from([own("b")]));
        assert!(t.seen(&[own("b")]).is_empty());
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]);
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["a"], &[]) }]);
        assert!(t.opened(&own("a")).is_empty());
        let after_open = t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]);
        assert!(after_open.is_empty(), "the repaint of opening it isn't a turn");
        sessions[0].state = "Restorable".into();
        assert!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]).is_empty());
    }

    #[test]
    fn a_paused_session_is_neither_counted_nor_ticked() {
        let mut sessions = vec![session("a"), session("b")];
        sessions[1].activity_paused = true;
        let mut t = Tracker::default();
        let both = ids(&["a", "b"], &[]);
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &both }]);
        assert_eq!(fraction(&[Machine { node: None, sessions: &sessions, ids: &both }], &BTreeSet::new()), (0, 1), "b works unseen");
        let done = t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]);
        assert_eq!(done, BTreeSet::from([own("a")]), "b finishing is no news");

        // Paused after it finished: its tick goes.
        sessions[0].activity_paused = true;
        assert!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]).is_empty());
    }

    #[test]
    fn shells_left_running_hold_the_tick_until_they_end() {
        let sessions = [session("a")];
        let mut t = Tracker::default();
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["a"], &[]) }]);
        let shells = Ids { background: HashMap::from([("a".into(), 2)]), ..Ids::default() };
        assert!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &shells }]).is_empty(), "the turn ended, the shells didn't");
        assert_eq!(activity(&sessions[0], &shells, false), Some(Activity::Background));
        assert_eq!(fraction(&[Machine { node: None, sessions: &sessions, ids: &shells }], &BTreeSet::new()), (0, 1));
        let done = t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]);
        assert_eq!(done, BTreeSet::from([own("a")]));
    }

    #[test]
    fn compacting_on_its_own_neither_ticks_nor_clears_a_tick() {
        let sessions = [session("a"), session("b")];
        let mut t = Tracker::default();
        let compacting = |id: &str| Ids { compacting: HashSet::from([id.to_string()]), ..Ids::default() };
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["a"], &[]) }]);
        assert_eq!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]), BTreeSet::from([own("a")]));
        // b compacts while idle; a, already ticked, does too.
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &compacting("b") }]);
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &compacting("a") }]);
        let done = t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]);
        assert_eq!(done, BTreeSet::from([own("a")]), "b only compacted; a's turn is still unread");

        // A compaction inside a turn belongs to the turn: its end is the turn's end.
        t.seen(&[own("a")]);
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["b"], &[]) }]);
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &compacting("b") }]);
        let done = t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]);
        assert_eq!(done, BTreeSet::from([own("b")]));
    }

    #[test]
    fn a_peer_away_keeps_its_ticks_and_a_reconnect_ticks_nothing() {
        let sessions = [session("x")];
        let mut t = Tracker::default();
        t.observe(&[Machine { node: Some("nas"), sessions: &sessions, ids: &ids(&["x"], &[]) }]);
        let done = t.observe(&[Machine { node: Some("nas"), sessions: &sessions, ids: &Ids::default() }]);
        assert_eq!(done, BTreeSet::from([(Some("nas".to_string()), "x".to_string())]));
        assert_eq!(t.observe(&[]), done, "nas isn't in this frame");
        assert!(t.seen(&done).is_empty());
        let back = t.observe(&[Machine { node: Some("nas"), sessions: &sessions, ids: &Ids::default() }]);
        assert!(back.is_empty(), "back after being away: the first frame only seeds");
        t.observe(&[Machine { node: Some("nas"), sessions: &sessions, ids: &ids(&["x"], &[]) }]);
        let unread = t.observe(&[Machine { node: Some("nas"), sessions: &[], ids: &Ids::default() }]);
        assert_eq!(unread.len(), 1, "no list, no pruning");

        let mut t = Tracker::default();
        t.observe(&[Machine { node: None, sessions: &sessions, ids: &ids(&["x"], &[]) }]);
        t.reset();
        assert!(t.observe(&[Machine { node: None, sessions: &sessions, ids: &Ids::default() }]).is_empty());
    }

    #[test]
    fn activity_follows_the_web_apps_precedence() {
        let s = session("a");
        let all = Ids {
            busy: HashSet::from(["a".into()]),
            waiting: HashSet::from(["a".into()]),
            compacting: HashSet::from(["a".into()]),
            failed: HashSet::from(["a".into()]),
            background: HashMap::from([("a".into(), 2)]),
        };
        assert_eq!(activity(&s, &all, true), Some(Activity::Compacting));
        assert_eq!(activity(&s, &ids(&[], &[]), true), Some(Activity::Done));
        assert_eq!(activity(&s, &ids(&[], &[]), false), None);
    }
}
