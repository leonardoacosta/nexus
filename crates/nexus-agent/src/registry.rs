use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use nexus_core::proto::{self, session_event::Payload};
use nexus_core::session::Session;
use tokio::sync::RwLock;

use crate::events::EventBroadcaster;
use crate::grpc::{datetime_to_timestamp, session_status_to_proto, session_to_proto};

/// In-memory store of active Claude Code sessions on this machine.
/// Populated by watching sessions.json (MVP) or receiving direct hook events (target).
pub struct SessionRegistry {
    sessions: RwLock<HashMap<String, Session>>,
    events: Arc<EventBroadcaster>,
}

impl SessionRegistry {
    pub fn new(events: Arc<EventBroadcaster>) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            events,
        }
    }

    /// Bulk-replace all sessions from a file watcher parse.
    ///
    /// Diffs the incoming set against the existing map and emits:
    /// - `SessionStarted` for new session IDs
    /// - `StatusChanged` when a session's status differs
    /// - `HeartbeatReceived` for sessions that still exist (heartbeat updated)
    /// - `SessionStopped` for session IDs that disappeared
    pub async fn upsert_sessions(&self, sessions: Vec<Session>) {
        let mut map = self.sessions.write().await;

        let new_ids: HashMap<String, &Session> =
            sessions.iter().map(|s| (s.id.clone(), s)).collect();

        // Detect removed sessions (present in old map but absent from new set).
        let removed: Vec<(String, Session)> = map
            .iter()
            .filter(|(id, _)| !new_ids.contains_key(*id))
            .map(|(id, s)| (id.clone(), s.clone()))
            .collect();

        for (id, _old) in &removed {
            map.remove(id);
            self.events.emit(make_event(
                id,
                Payload::Stopped(proto::SessionStopped {
                    reason: "session disappeared".into(),
                }),
            ));
        }

        // Process new and updated sessions.
        for session in sessions {
            let id = session.id.clone();
            match map.get(&id) {
                None => {
                    // New session.
                    self.events.emit(make_event(
                        &id,
                        Payload::Started(proto::SessionStarted {
                            session: Some(session_to_proto(&session)),
                        }),
                    ));
                }
                Some(existing) => {
                    // Existing session — check for status transition.
                    if existing.status != session.status {
                        self.events.emit(make_event(
                            &id,
                            Payload::StatusChanged(proto::StatusChanged {
                                old_status: session_status_to_proto(&existing.status),
                                new_status: session_status_to_proto(&session.status),
                            }),
                        ));
                    }

                    // Emit heartbeat for every update (heartbeat timestamp changed).
                    self.events.emit(make_event(
                        &id,
                        Payload::Heartbeat(proto::HeartbeatReceived {
                            last_heartbeat: datetime_to_timestamp(&session.last_heartbeat),
                        }),
                    ));
                }
            }

            map.insert(id, session);
        }
    }

    /// Return all tracked sessions.
    pub async fn get_all(&self) -> Vec<Session> {
        let map = self.sessions.read().await;
        map.values().cloned().collect()
    }

    /// Single session lookup by ID.
    pub async fn get_by_id(&self, id: &str) -> Option<Session> {
        let map = self.sessions.read().await;
        map.get(id).cloned()
    }

    /// Register a managed session (spawned via StartSession RPC).
    ///
    /// The session has its `tmux_session` field set, which distinguishes
    /// managed sessions from ad-hoc ones discovered via file watcher.
    pub async fn register_managed(&self, session: Session) {
        let id = session.id.clone();
        self.events.emit(make_event(
            &id,
            Payload::Started(proto::SessionStarted {
                session: Some(session_to_proto(&session)),
            }),
        ));

        let mut map = self.sessions.write().await;
        map.insert(id, session);
    }

    /// Remove a session by ID. Returns the removed session if it existed.
    pub async fn remove(&self, id: &str) -> Option<Session> {
        let mut map = self.sessions.write().await;
        let removed = map.remove(id);

        if removed.is_some() {
            self.events.emit(make_event(
                id,
                Payload::Stopped(proto::SessionStopped {
                    reason: "session stopped via RPC".into(),
                }),
            ));
        }

        removed
    }

    /// Prune sessions whose last heartbeat is older than `max_age`.
    /// Used by future health/ops spec for periodic stale-session cleanup.
    #[allow(dead_code)]
    pub async fn remove_stale(&self, max_age: Duration) {
        let mut map = self.sessions.write().await;
        let max_age_secs = max_age.as_secs() as i64;
        map.retain(|_, session| session.idle_seconds() < max_age_secs);
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a `SessionEvent` with the current timestamp and given payload.
fn make_event(session_id: &str, payload: Payload) -> proto::SessionEvent {
    let now = chrono::Utc::now();
    proto::SessionEvent {
        session_id: session_id.to_string(),
        ts: Some(prost_types::Timestamp {
            seconds: now.timestamp(),
            nanos: now.timestamp_subsec_nanos() as i32,
        }),
        payload: Some(payload),
    }
}
