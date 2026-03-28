use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use nexus_core::proto::{self, session_event::Payload};
use nexus_core::session::Session;
use tokio::sync::RwLock;

use crate::events::EventBroadcaster;
use crate::grpc::{datetime_to_timestamp, session_status_to_proto, session_to_proto};
use crate::parser::TelemetryUpdate;

/// A question that is waiting for a user answer, associated with a session.
#[derive(Debug, Clone)]
pub struct PendingQuestion {
    /// The session that posed the question.
    pub session_id: String,
    /// Question text extracted from the notification.
    pub question: String,
    /// Wall-clock time the question was received (for auto-target ordering).
    pub received_at: chrono::DateTime<chrono::Utc>,
}

/// In-memory store of active Claude Code sessions on this machine.
/// Populated by watching sessions.json (MVP) or receiving direct hook events (target).
pub struct SessionRegistry {
    sessions: RwLock<HashMap<String, Session>>,
    events: Arc<EventBroadcaster>,
    /// Pending questions indexed by session ID. A question is present here
    /// when the session has emitted an AskUserQuestion-style notification and
    /// no answer has been dispatched yet.
    pending_questions: RwLock<HashMap<String, PendingQuestion>>,
}

impl SessionRegistry {
    pub fn new(events: Arc<EventBroadcaster>) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            events,
            pending_questions: RwLock::new(HashMap::new()),
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
                is_snapshot: false,
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

    /// Register an ad-hoc session (discovered via CC hook, not managed by tmux).
    ///
    /// `tmux_target` is the pane identifier captured from `$TMUX_PANE` at hook
    /// time (e.g. `"main:0.1"`). It is stored on the session for bidirectional
    /// routing — sending answers back into the CC session pane.
    ///
    /// Insert-if-absent: if a session with the same ID already exists, it is
    /// left untouched (no field overwrites, no event). Returns `true` if the
    /// session was newly created, `false` if it already existed.
    pub async fn register_adhoc(&self, mut session: Session, tmux_target: Option<String>) -> bool {
        // Ad-hoc sessions never have a tmux_session (managed tmux session name).
        session.tmux_session = None;
        // But they may have a tmux_target pane identifier for routing.
        session.tmux_target = tmux_target;

        let id = session.id.clone();
        let mut map = self.sessions.write().await;

        use std::collections::hash_map::Entry;
        match map.entry(id) {
            Entry::Occupied(_) => {
                // Session already registered — leave it untouched.
                false
            }
            Entry::Vacant(entry) => {
                self.events.emit(make_event(
                    entry.key(),
                    Payload::Started(proto::SessionStarted {
                        session: Some(session_to_proto(&session)),
                        is_snapshot: false,
                    }),
                ));
                entry.insert(session);
                true
            }
        }
    }

    /// Remove a session by ID without killing the process.
    ///
    /// Idempotent: returns `true` if the session was found and removed,
    /// `false` if it did not exist. Emits `SessionStopped` only when a
    /// session was actually removed.
    pub async fn unregister(&self, id: &str) -> bool {
        let mut map = self.sessions.write().await;
        let removed = map.remove(id);

        if removed.is_some() {
            self.events.emit(make_event(
                id,
                Payload::Stopped(proto::SessionStopped {
                    reason: "session ended".into(),
                }),
            ));
            true
        } else {
            false
        }
    }

    /// Update the heartbeat timestamp for a session.
    ///
    /// If the session is currently `Stale`, revives it to `Active` and emits
    /// a `StatusChanged` event. A `HeartbeatReceived` event is always emitted
    /// for known sessions. Returns `true` if the session was found.
    pub async fn heartbeat(&self, id: &str) -> bool {
        let mut map = self.sessions.write().await;

        let Some(session) = map.get_mut(id) else {
            return false;
        };

        let now = chrono::Utc::now();
        session.last_heartbeat = now;

        // Revive stale sessions.
        if session.status == nexus_core::session::SessionStatus::Stale {
            let old_status = session_status_to_proto(&session.status);
            session.status = nexus_core::session::SessionStatus::Active;
            let new_status = session_status_to_proto(&session.status);

            self.events.emit(make_event(
                id,
                Payload::StatusChanged(proto::StatusChanged {
                    old_status,
                    new_status,
                }),
            ));
        }

        self.events.emit(make_event(
            id,
            Payload::Heartbeat(proto::HeartbeatReceived {
                last_heartbeat: datetime_to_timestamp(&session.last_heartbeat),
            }),
        ));

        true
    }

    /// Update telemetry fields on a session.
    ///
    /// Only overwrites fields that are `Some` in the update — existing values
    /// are preserved for fields not included in this update.
    pub async fn update_telemetry(&self, id: &str, telemetry: &TelemetryUpdate) {
        let mut map = self.sessions.write().await;

        let Some(session) = map.get_mut(id) else {
            return;
        };

        if let Some(ref rl) = telemetry.rate_limit {
            session.rate_limit_utilization = Some(rl.utilization);
            session.rate_limit_type = Some(rl.rate_limit_type.clone());
        }

        if let Some(cost) = telemetry.cost_usd {
            session.total_cost_usd = Some(cost);
        }

        if let Some(ref model) = telemetry.model {
            session.model = Some(model.clone());
        }
    }

    /// Record a pending question for a session.
    ///
    /// Called when a `Notification` event with a `question` field is received.
    /// Overwrites any previous pending question for the same session.
    pub async fn set_pending_question(&self, session_id: &str, question: String) {
        let mut pending = self.pending_questions.write().await;
        pending.insert(
            session_id.to_string(),
            PendingQuestion {
                session_id: session_id.to_string(),
                question,
                received_at: chrono::Utc::now(),
            },
        );
        tracing::debug!(session_id = %session_id, "pending question recorded");
    }

    /// Clear the pending question for a session (called after answer dispatch).
    pub async fn clear_pending_question(&self, session_id: &str) {
        let mut pending = self.pending_questions.write().await;
        pending.remove(session_id);
    }

    /// Return the session with the most recent pending question, along with
    /// the question text. Used for auto-targeting when no session ID is given.
    pub async fn get_session_with_pending_question(&self) -> Option<(Session, PendingQuestion)> {
        let pending = self.pending_questions.read().await;

        // Find the most recently asked pending question.
        let newest = pending
            .values()
            .max_by_key(|pq| pq.received_at)?
            .clone();
        drop(pending);

        let sessions = self.sessions.read().await;
        let session = sessions.get(&newest.session_id)?.clone();
        Some((session, newest))
    }

    /// Look up the tmux target pane for a session by ID.
    pub async fn get_tmux_target(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.read().await;
        sessions
            .get(session_id)
            .and_then(|s| s.tmux_target.clone())
    }

    /// Periodic stale detection for ad-hoc sessions.
    ///
    /// - Sessions idle longer than `remove_threshold` are removed with a
    ///   `SessionStopped` event.
    /// - Sessions idle longer than `stale_threshold` (but below remove) are
    ///   marked `Stale` with a `StatusChanged` event.
    /// - Managed sessions (those with `tmux_session` set) are skipped.
    pub async fn detect_stale(&self, stale_threshold: Duration, remove_threshold: Duration) {
        let stale_secs = stale_threshold.as_secs() as i64;
        let remove_secs = remove_threshold.as_secs() as i64;

        let mut map = self.sessions.write().await;

        // Collect IDs to remove first to avoid borrow issues.
        let to_remove: Vec<String> = map
            .iter()
            .filter(|(_, s)| s.tmux_session.is_none() && s.idle_seconds() > remove_secs)
            .map(|(id, _)| id.clone())
            .collect();

        for id in &to_remove {
            map.remove(id);
            self.events.emit(make_event(
                id,
                Payload::Stopped(proto::SessionStopped {
                    reason: "stale session removed".into(),
                }),
            ));
        }

        // Mark remaining ad-hoc sessions as stale if over threshold.
        for (id, session) in map.iter_mut() {
            if session.tmux_session.is_some() {
                continue;
            }
            if session.idle_seconds() > stale_secs
                && session.status != nexus_core::session::SessionStatus::Stale
            {
                let old_status = session_status_to_proto(&session.status);
                session.status = nexus_core::session::SessionStatus::Stale;
                let new_status = session_status_to_proto(&session.status);

                self.events.emit(make_event(
                    id,
                    Payload::StatusChanged(proto::StatusChanged {
                        old_status,
                        new_status,
                    }),
                ));
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build a `SessionEvent` with the current timestamp and given payload.
///
/// `agent_name` is left empty here — it is stamped at the gRPC transport
/// level by `stream_events` before forwarding to the client.
fn make_event(session_id: &str, payload: Payload) -> proto::SessionEvent {
    let now = chrono::Utc::now();
    proto::SessionEvent {
        session_id: session_id.to_string(),
        ts: Some(prost_types::Timestamp {
            seconds: now.timestamp(),
            nanos: now.timestamp_subsec_nanos() as i32,
        }),
        payload: Some(payload),
        agent_name: String::new(),
    }
}
