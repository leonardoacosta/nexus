use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use chrono::{DateTime, Utc};
use nexus_core::db::{NexusDb, SessionRecord, SessionUpdate};
use nexus_core::proto::{self, session_event::Payload};
use nexus_core::session::Session;
use serde::{Deserialize, Serialize};
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

/// Aggregated summary data for a completed session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummaryData {
    pub tool_counts: HashMap<String, u32>,
    pub failure_count: u32,
    pub compaction_count: u32,
    pub agent_spawns: u32,
    pub duration_ms: u64,
    pub model: Option<String>,
    pub session_id: String,
    pub project: Option<String>,
    pub received_at: DateTime<Utc>,
}

/// A pending summary for a session that hasn't been registered yet.
struct PendingSummary {
    data: SessionSummaryData,
    expires_at: DateTime<Utc>,
}

/// In-memory store of active Claude Code sessions on this machine.
/// Populated by watching sessions.json (MVP) or receiving direct hook events (target).
pub struct SessionRegistry {
    sessions: RwLock<HashMap<String, Session>>,
    events: Arc<EventBroadcaster>,
    /// Optional SQLite backing store for write-through persistence.
    db: Option<Arc<NexusDb>>,
    /// Pending questions indexed by session ID. A question is present here
    /// when the session has emitted an AskUserQuestion-style notification and
    /// no answer has been dispatched yet.
    pending_questions: RwLock<HashMap<String, PendingQuestion>>,
    /// Session summaries indexed by session ID.
    session_summaries: RwLock<HashMap<String, SessionSummaryData>>,
    /// Pending summaries for sessions not yet registered (5-min TTL).
    pending_summaries: RwLock<HashMap<String, PendingSummary>>,
}

impl SessionRegistry {
    pub fn new(events: Arc<EventBroadcaster>) -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
            events,
            db: None,
            pending_questions: RwLock::new(HashMap::new()),
            session_summaries: RwLock::new(HashMap::new()),
            pending_summaries: RwLock::new(HashMap::new()),
        }
    }

    /// Set the DB backing store and load any previously active sessions.
    pub async fn with_db(mut self, db: Arc<NexusDb>) -> Self {
        // Load sessions that were active when the agent last shut down.
        match db.load_active_sessions() {
            Ok(records) => {
                let mut map = self.sessions.write().await;
                for record in &records {
                    if let Some(session) = session_from_record(record) {
                        map.insert(session.id.clone(), session);
                    }
                }
                if !records.is_empty() {
                    tracing::info!(count = records.len(), "recovered active sessions from DB");
                }
            }
            Err(e) => {
                tracing::warn!(error = %e, "failed to load sessions from DB");
            }
        }
        self.db = Some(db);
        self
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

        // Write-through to DB.
        self.db_insert_session(&session);

        let mut map = self.sessions.write().await;
        map.insert(id.clone(), session);
        drop(map);

        // Check for pending summaries that arrived before registration.
        self.apply_pending_summary(&id).await;
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
            // Write-through: mark session ended in DB.
            self.db_end_session(id);
        }

        removed
    }

    /// Prune sessions whose last heartbeat is older than `max_age`.
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
                let key = entry.key().clone();
                self.events.emit(make_event(
                    &key,
                    Payload::Started(proto::SessionStarted {
                        session: Some(session_to_proto(&session)),
                        is_snapshot: false,
                    }),
                ));
                // Write-through to DB.
                self.db_insert_session(&session);
                entry.insert(session);
                drop(map);

                // Check for pending summaries that arrived before registration.
                self.apply_pending_summary(&key).await;
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
            // Write-through: mark session ended in DB.
            self.db_end_session(id);
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

        // Write-through heartbeat to DB.
        self.db_update_session(
            id,
            &SessionUpdate {
                last_heartbeat: Some(now.to_rfc3339()),
                status: Some(session.status.to_string()),
                ..Default::default()
            },
        );

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

        let mut db_update = SessionUpdate::default();

        if let Some(ref rl) = telemetry.rate_limit {
            session.rate_limit_utilization = Some(rl.utilization);
            session.rate_limit_type = Some(rl.rate_limit_type.clone());
            db_update.rate_limit_utilization = Some(rl.utilization);
            db_update.rate_limit_type = Some(rl.rate_limit_type.clone());
        }

        if let Some(cost) = telemetry.cost_usd {
            session.total_cost_usd = Some(cost);
            db_update.total_cost_usd = Some(cost);
        }

        if let Some(ref model) = telemetry.model {
            session.model = Some(model.clone());
            db_update.model = Some(model.clone());
        }

        // Write-through telemetry to DB.
        self.db_update_session(id, &db_update);
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
        let newest = pending.values().max_by_key(|pq| pq.received_at)?.clone();
        drop(pending);

        let sessions = self.sessions.read().await;
        let session = sessions.get(&newest.session_id)?.clone();
        Some((session, newest))
    }

    /// Look up the tmux target pane for a session by ID.
    pub async fn get_tmux_target(&self, session_id: &str) -> Option<String> {
        let sessions = self.sessions.read().await;
        sessions.get(session_id).and_then(|s| s.tmux_target.clone())
    }

    /// Store a session summary. If the session is known, stores immediately.
    /// If not, stores as pending with a 5-minute TTL for late-arriving sessions.
    pub async fn store_session_summary(&self, summary: SessionSummaryData) {
        let session_id = summary.session_id.clone();
        let sessions = self.sessions.read().await;

        if sessions.contains_key(&session_id) {
            drop(sessions);
            let mut summaries = self.session_summaries.write().await;
            summaries.insert(session_id.clone(), summary);
            tracing::debug!(session_id = %session_id, "stored session summary");
        } else {
            drop(sessions);
            let mut pending = self.pending_summaries.write().await;
            let expires_at = Utc::now() + chrono::Duration::minutes(5);
            pending.insert(
                session_id.clone(),
                PendingSummary {
                    data: summary,
                    expires_at,
                },
            );
            tracing::debug!(
                session_id = %session_id,
                "stored pending session summary (session not yet registered)"
            );
        }
    }

    /// Retrieve a session summary by ID.
    pub async fn get_session_summary(&self, session_id: &str) -> Option<SessionSummaryData> {
        let summaries = self.session_summaries.read().await;
        summaries.get(session_id).cloned()
    }

    /// Cleanup expired pending summaries. Called periodically.
    pub async fn cleanup_pending_summaries(&self) {
        let now = Utc::now();
        let mut pending = self.pending_summaries.write().await;
        let before = pending.len();
        pending.retain(|_, ps| ps.expires_at > now);
        let removed = before - pending.len();
        if removed > 0 {
            tracing::debug!(removed, "cleaned up expired pending summaries");
        }
    }

    /// Check for and apply any pending summary when a session is registered.
    async fn apply_pending_summary(&self, session_id: &str) {
        let mut pending = self.pending_summaries.write().await;
        if let Some(ps) = pending.remove(session_id) {
            drop(pending);
            let mut summaries = self.session_summaries.write().await;
            summaries.insert(session_id.to_string(), ps.data);
            tracing::debug!(session_id = %session_id, "applied pending summary to newly registered session");
        }
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

        // Mark sessions as stale if over threshold.
        // Managed sessions (tmux_session.is_some()) are also eligible — a dead tmux target
        // is not proof of liveness. Only skip sessions already Ended.
        for (id, session) in map.iter_mut() {
            if session.status == nexus_core::session::SessionStatus::Ended {
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

impl SessionRegistry {
    // -------------------------------------------------------------------
    // Private DB write-through helpers
    // -------------------------------------------------------------------

    /// Write-through: insert a session into the DB. Best-effort — logs warning on failure.
    fn db_insert_session(&self, session: &Session) {
        if let Some(ref db) = self.db {
            let record = session_to_record(session);
            if let Err(e) = db.insert_session(&record) {
                tracing::warn!(session_id = %session.id, error = %e, "DB write-through: insert_session failed");
            }
            // Audit event: session start (best-effort).
            if let Err(e) = db.log_event(
                "session_start",
                "registry",
                &session.id,
                session.project.as_deref(),
            ) {
                tracing::warn!(error = %e, "audit: failed to log session_start event");
            }
        }
    }

    /// Write-through: update a session in the DB. Best-effort.
    fn db_update_session(&self, id: &str, update: &SessionUpdate) {
        if let Some(ref db) = self.db
            && let Err(e) = db.update_session(id, update)
        {
            tracing::warn!(session_id = %id, error = %e, "DB write-through: update_session failed");
        }
    }

    /// Write-through: mark a session as ended in the DB. Best-effort.
    fn db_end_session(&self, id: &str) {
        if let Some(ref db) = self.db {
            let now = chrono::Utc::now().to_rfc3339();
            if let Err(e) = db.end_session(id, &now) {
                tracing::warn!(session_id = %id, error = %e, "DB write-through: end_session failed");
            }
            // Audit event: session stop (best-effort).
            if let Err(e) = db.log_event("session_stop", "registry", id, None) {
                tracing::warn!(error = %e, "audit: failed to log session_stop event");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/// Convert a `Session` to a `SessionRecord` for DB persistence.
fn session_to_record(session: &Session) -> SessionRecord {
    SessionRecord {
        id: session.id.clone(),
        pid: Some(session.pid as i64),
        project: session.project.clone(),
        cwd: Some(session.cwd.clone()),
        branch: session.branch.clone(),
        started_at: session.started_at.to_rfc3339(),
        ended_at: None,
        last_heartbeat: Some(session.last_heartbeat.to_rfc3339()),
        status: Some(session.status.to_string()),
        model: session.model.clone(),
        session_type: Some(session.session_type.to_string()),
        total_cost_usd: session.total_cost_usd,
        rate_limit_utilization: session.rate_limit_utilization,
        rate_limit_type: session.rate_limit_type.clone(),
        tmux_target: session.tmux_target.clone(),
        cc_session_id: session.cc_session_id.clone(),
        agent: session.agent.clone(),
    }
}

/// Convert a `SessionRecord` from the DB back into a `Session`.
fn session_from_record(record: &SessionRecord) -> Option<Session> {
    let started_at = chrono::DateTime::parse_from_rfc3339(&record.started_at)
        .ok()?
        .to_utc();
    let last_heartbeat = record
        .last_heartbeat
        .as_ref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.to_utc())
        .unwrap_or(started_at);

    let status = match record.status.as_deref() {
        Some("active") => nexus_core::session::SessionStatus::Active,
        Some("idle") => nexus_core::session::SessionStatus::Idle,
        Some("stale") => nexus_core::session::SessionStatus::Stale,
        Some("errored") => nexus_core::session::SessionStatus::Errored,
        Some("ended") => nexus_core::session::SessionStatus::Ended,
        _ => nexus_core::session::SessionStatus::Stale, // recovered sessions start as stale
    };

    let session_type = match record.session_type.as_deref() {
        Some("managed") => nexus_core::session::SessionType::Managed,
        Some("pooled") => nexus_core::session::SessionType::Pooled,
        _ => nexus_core::session::SessionType::AdHoc,
    };

    Some(Session {
        id: record.id.clone(),
        pid: record.pid.unwrap_or(0) as u32,
        project: record.project.clone(),
        cwd: record.cwd.clone().unwrap_or_default(),
        branch: record.branch.clone(),
        started_at,
        last_heartbeat,
        status,
        spec: None,
        command: None,
        agent: record.agent.clone(),
        tmux_session: None,
        cc_session_id: record.cc_session_id.clone(),
        tmux_target: record.tmux_target.clone(),
        machine: None,
        ended_at: record.ended_at.as_ref().and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .ok()
                .map(|dt| dt.with_timezone(&chrono::Utc))
        }),
        rate_limit_utilization: record.rate_limit_utilization,
        rate_limit_type: record.rate_limit_type.clone(),
        total_cost_usd: record.total_cost_usd,
        model: record.model.clone(),
        session_type,
    })
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::session::{Session, SessionStatus, SessionType};
    use std::sync::Arc;
    use std::time::Duration;

    fn make_registry() -> SessionRegistry {
        let events = Arc::new(EventBroadcaster::new(64));
        SessionRegistry::new(events)
    }

    fn make_session_with_heartbeat(
        id: &str,
        cwd: &str,
        heartbeat: DateTime<Utc>,
        tmux_session: Option<String>,
    ) -> Session {
        let mut s = Session::new(1234, cwd.to_string());
        s.id = id.to_string();
        s.last_heartbeat = heartbeat;
        s.status = SessionStatus::Active;
        s.tmux_session = tmux_session;
        s
    }

    // ── Task 5.2: Stale detection tests still pass after removing managed guard ──

    #[tokio::test]
    async fn detect_stale_marks_ad_hoc_session_stale() {
        let registry = make_registry();
        let stale_threshold = Duration::from_secs(300);
        let remove_threshold = Duration::from_secs(3600);

        // Session with heartbeat 10 minutes ago (well past stale threshold)
        let old_heartbeat = chrono::Utc::now() - chrono::Duration::seconds(600);
        let session = make_session_with_heartbeat("ad-hoc-1", "/tmp/foo", old_heartbeat, None);

        {
            let mut map = registry.sessions.write().await;
            map.insert(session.id.clone(), session);
        }

        registry.detect_stale(stale_threshold, remove_threshold).await;

        let sessions = registry.get_all().await;
        let s = sessions.iter().find(|s| s.id == "ad-hoc-1").expect("session should still exist");
        assert_eq!(
            s.status,
            SessionStatus::Stale,
            "ad-hoc session with old heartbeat must be marked Stale"
        );
    }

    #[tokio::test]
    async fn detect_stale_removes_ad_hoc_session_past_remove_threshold() {
        let registry = make_registry();
        let stale_threshold = Duration::from_secs(300);
        let remove_threshold = Duration::from_secs(3600);

        // Session with heartbeat 2 hours ago (past remove threshold)
        let very_old = chrono::Utc::now() - chrono::Duration::seconds(7200);
        let session = make_session_with_heartbeat("ad-hoc-old", "/tmp/bar", very_old, None);

        {
            let mut map = registry.sessions.write().await;
            map.insert(session.id.clone(), session);
        }

        registry.detect_stale(stale_threshold, remove_threshold).await;

        let sessions = registry.get_all().await;
        assert!(
            sessions.iter().all(|s| s.id != "ad-hoc-old"),
            "ad-hoc session past remove threshold must be removed"
        );
    }

    #[tokio::test]
    async fn detect_stale_does_not_remove_managed_session() {
        let registry = make_registry();
        let stale_threshold = Duration::from_secs(300);
        let remove_threshold = Duration::from_secs(3600);

        // Managed session with heartbeat 2 hours ago — should NOT be auto-removed
        // (managed sessions have tmux_session set, so the filter excludes them from removal)
        let very_old = chrono::Utc::now() - chrono::Duration::seconds(7200);
        let session = make_session_with_heartbeat(
            "managed-1",
            "/tmp/managed",
            very_old,
            Some("main".to_string()),
        );

        {
            let mut map = registry.sessions.write().await;
            map.insert(session.id.clone(), session);
        }

        registry.detect_stale(stale_threshold, remove_threshold).await;

        let sessions = registry.get_all().await;
        assert!(
            sessions.iter().any(|s| s.id == "managed-1"),
            "managed session must not be auto-removed even if very old"
        );
    }

    #[tokio::test]
    async fn detect_stale_fresh_session_not_affected() {
        let registry = make_registry();
        let stale_threshold = Duration::from_secs(300);
        let remove_threshold = Duration::from_secs(3600);

        // Fresh session — heartbeat just now
        let now = chrono::Utc::now();
        let session = make_session_with_heartbeat("fresh-1", "/tmp/fresh", now, None);

        {
            let mut map = registry.sessions.write().await;
            map.insert(session.id.clone(), session);
        }

        registry.detect_stale(stale_threshold, remove_threshold).await;

        let sessions = registry.get_all().await;
        let s = sessions.iter().find(|s| s.id == "fresh-1").expect("fresh session should exist");
        assert_eq!(
            s.status,
            SessionStatus::Active,
            "fresh session must remain Active"
        );
    }

    // ── Task 5.3: Managed session (tmux_session Some) with old heartbeat → Stale ──

    #[tokio::test]
    async fn detect_stale_marks_managed_session_stale_when_heartbeat_old() {
        let registry = make_registry();
        let stale_threshold = Duration::from_secs(300);
        let remove_threshold = Duration::from_secs(86400); // 24h remove threshold so it stays

        // Managed session with heartbeat 10 minutes ago (past stale, not past remove)
        let old_heartbeat = chrono::Utc::now() - chrono::Duration::seconds(600);
        let session = make_session_with_heartbeat(
            "managed-stale",
            "/tmp/managed-stale",
            old_heartbeat,
            Some("myproject".to_string()),
        );

        {
            let mut map = registry.sessions.write().await;
            map.insert(session.id.clone(), session);
        }

        registry.detect_stale(stale_threshold, remove_threshold).await;

        let sessions = registry.get_all().await;
        let s = sessions
            .iter()
            .find(|s| s.id == "managed-stale")
            .expect("managed session should still exist (not removed)");

        assert_eq!(
            s.status,
            SessionStatus::Stale,
            "managed session with heartbeat > stale threshold must be marked Stale"
        );
    }

    #[tokio::test]
    async fn detect_stale_skips_already_ended_session() {
        let registry = make_registry();
        let stale_threshold = Duration::from_secs(300);
        let remove_threshold = Duration::from_secs(3600);

        // Session already marked as Ended should not be changed to Stale
        let old_heartbeat = chrono::Utc::now() - chrono::Duration::seconds(600);
        let mut session = make_session_with_heartbeat("ended-1", "/tmp/ended", old_heartbeat, None);
        session.status = SessionStatus::Ended;
        // Ended sessions have tmux_session = None (ad-hoc style), but we set ended_at to
        // prevent removal. For this test we use a non-tmux session to test the Ended skip guard.
        // NOTE: The current impl removes sessions past remove_threshold only if tmux_session.is_none().
        // Ended sessions are skipped in the stale marking loop but CAN be removed by remove_threshold
        // sweep (which only checks idle_seconds, not status). We test the marking guard here.
        {
            let mut map = registry.sessions.write().await;
            map.insert(session.id.clone(), session);
        }

        // Use a remove threshold much larger than 600s to avoid removal during this test
        let long_remove = Duration::from_secs(86400);
        registry.detect_stale(stale_threshold, long_remove).await;

        let sessions = registry.get_all().await;
        if let Some(s) = sessions.iter().find(|s| s.id == "ended-1") {
            assert_eq!(
                s.status,
                SessionStatus::Ended,
                "Ended session status must not be changed to Stale"
            );
        }
        // If the session was removed by the remove sweep it's fine too —
        // the key invariant is that Ended is never overwritten to Stale.
    }
}
