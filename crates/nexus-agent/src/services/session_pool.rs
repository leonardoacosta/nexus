//! Session Pool Service
//!
//! Manages a pool of warm Claude Code sessions per project. Sessions are kept
//! alive and ready for commands, avoiding cold-start latency.
//!
//! # Lifecycle
//! - `Warming`: Session starting up; not yet available.
//! - `Ready`: Available for commands.
//! - `Busy`: A command is in progress.
//! - `Draining`: Being evicted or stopped.
//!
//! # Task 6 note
//! Actual CC session spawning is a stub here — `get_or_create` creates a
//! placeholder `PooledSession` entry. Real gRPC-backed spawning is wired in
//! Task 6.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use tokio::sync::{RwLock, mpsc};
use tracing::{debug, info, warn};

use nexus_core::config::PoolConfig;
use nexus_core::project_registry::ProjectRegistry;

use crate::services::Service;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/// The lifecycle state of a pooled session.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PooledSessionStatus {
    /// Session is starting up and not yet available for commands.
    Warming,
    /// Session is idle and ready to accept a command.
    Ready,
    /// A command is currently running in this session.
    Busy,
    /// Session is being evicted or the pool is shutting down.
    Draining,
}

impl std::fmt::Display for PooledSessionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PooledSessionStatus::Warming => write!(f, "warming"),
            PooledSessionStatus::Ready => write!(f, "ready"),
            PooledSessionStatus::Busy => write!(f, "busy"),
            PooledSessionStatus::Draining => write!(f, "draining"),
        }
    }
}

// ---------------------------------------------------------------------------
// PooledSession
// ---------------------------------------------------------------------------

/// An individual session held in the pool.
#[derive(Debug)]
pub struct PooledSession {
    /// Unique identifier for this session (placeholder until Task 6).
    pub session_id: String,
    /// Project this session belongs to (e.g. `"oo"`, `"nx"`).
    pub project_code: String,
    /// Absolute working directory for the session.
    pub cwd: String,
    /// Current lifecycle status.
    pub status: PooledSessionStatus,
    /// When this session was created.
    pub created_at: Instant,
    /// When this session last handled a command.
    pub last_used_at: Instant,
}

// ---------------------------------------------------------------------------
// PoolStats
// ---------------------------------------------------------------------------

/// Aggregate counts returned by [`SessionPool::stats`].
#[derive(Debug, Clone)]
pub struct PoolStats {
    /// Sessions in `Busy` state.
    pub active: usize,
    /// Sessions in `Ready` state.
    pub idle: usize,
    /// Sessions in `Warming` state.
    pub warming: usize,
    /// Sessions in `Draining` state.
    pub draining: usize,
    /// Total sessions tracked by the pool.
    pub total: usize,
}

// ---------------------------------------------------------------------------
// SessionPool
// ---------------------------------------------------------------------------

/// A cheaply-cloneable handle to the session pool.
///
/// Backed by an `Arc<PoolInner>` so all clones share the same state.
#[derive(Clone)]
pub struct SessionPool {
    inner: Arc<PoolInner>,
}

struct PoolInner {
    /// Active sessions keyed by project code (one session per project for now).
    sessions: RwLock<HashMap<String, PooledSession>>,
    config: PoolConfig,
    project_registry: ProjectRegistry,
}

impl SessionPool {
    /// Create a new pool with the given config and project registry.
    pub fn new(config: PoolConfig, project_registry: ProjectRegistry) -> Self {
        Self {
            inner: Arc::new(PoolInner {
                sessions: RwLock::new(HashMap::new()),
                config,
                project_registry,
            }),
        }
    }

    /// Return a session ID for the given project, creating one if needed.
    ///
    /// - If a `Ready` session exists: marks it `Busy` and returns its ID.
    /// - If no session exists: creates a placeholder `Warming` entry and
    ///   returns a generated session ID.
    ///
    /// Returns an error if the pool is at capacity or the project cannot
    /// be resolved.
    pub async fn get_or_create(&self, project_code: &str) -> Result<String> {
        let mut sessions = self.inner.sessions.write().await;

        // If a session already exists for this project, check its state.
        if let Some(session) = sessions.get_mut(project_code) {
            match session.status {
                PooledSessionStatus::Ready => {
                    session.status = PooledSessionStatus::Busy;
                    session.last_used_at = Instant::now();
                    let id = session.session_id.clone();
                    debug!(
                        project = project_code,
                        session_id = %id,
                        "Returning existing ready session"
                    );
                    return Ok(id);
                }
                PooledSessionStatus::Busy => {
                    let id = session.session_id.clone();
                    debug!(
                        project = project_code,
                        session_id = %id,
                        "Session already busy; returning its ID"
                    );
                    return Ok(id);
                }
                PooledSessionStatus::Warming => {
                    let id = session.session_id.clone();
                    debug!(
                        project = project_code,
                        "Session still warming; returning placeholder ID"
                    );
                    return Ok(id);
                }
                PooledSessionStatus::Draining => {
                    // Fall through — evict it and create a new one below.
                    sessions.remove(project_code);
                }
            }
        }

        // Enforce pool capacity.
        let max = self.inner.config.max_sessions;
        if sessions.len() >= max {
            anyhow::bail!(
                "Session pool at capacity ({} sessions); cannot create session for '{}'",
                max,
                project_code
            );
        }

        // Resolve the project's working directory.
        let cwd = match self.inner.project_registry.resolve(project_code) {
            Some(pp) => pp.cwd.to_string_lossy().into_owned(),
            None => {
                warn!(
                    project = project_code,
                    "Project not found in registry; using empty cwd"
                );
                String::new()
            }
        };

        // --- STUB: actual CC spawning happens in Task 6 ---
        let session_id = format!("pool-{}-{}", project_code, uuid_simple());

        info!(
            project = project_code,
            session_id = %session_id,
            cwd = %cwd,
            "Creating placeholder pooled session (stub — Task 6 will wire real spawning)"
        );

        let now = Instant::now();
        sessions.insert(
            project_code.to_string(),
            PooledSession {
                session_id: session_id.clone(),
                project_code: project_code.to_string(),
                cwd,
                status: PooledSessionStatus::Warming,
                created_at: now,
                last_used_at: now,
            },
        );

        Ok(session_id)
    }

    /// Mark a project's session as `Ready` after a command completes.
    pub async fn release(&self, project_code: &str) {
        let mut sessions = self.inner.sessions.write().await;
        if let Some(session) = sessions.get_mut(project_code) {
            debug!(
                project = project_code,
                previous = %session.status,
                "Releasing session back to Ready"
            );
            session.status = PooledSessionStatus::Ready;
            session.last_used_at = Instant::now();
        } else {
            warn!(
                project = project_code,
                "release called but no session found"
            );
        }
    }

    /// Remove a project's session from the pool entirely.
    pub async fn remove(&self, project_code: &str) {
        let mut sessions = self.inner.sessions.write().await;
        if sessions.remove(project_code).is_some() {
            info!(project = project_code, "Session removed from pool");
        } else {
            debug!(project = project_code, "remove called but no session found");
        }
    }

    /// Return aggregate counts for the pool.
    pub async fn stats(&self) -> PoolStats {
        let sessions = self.inner.sessions.read().await;
        let mut stats = PoolStats {
            active: 0,
            idle: 0,
            warming: 0,
            draining: 0,
            total: sessions.len(),
        };
        for s in sessions.values() {
            match s.status {
                PooledSessionStatus::Busy => stats.active += 1,
                PooledSessionStatus::Ready => stats.idle += 1,
                PooledSessionStatus::Warming => stats.warming += 1,
                PooledSessionStatus::Draining => stats.draining += 1,
            }
        }
        stats
    }

    /// Return a snapshot of all sessions as `(project_code, status)` pairs.
    /// Used by the health endpoint.
    pub async fn all_sessions(&self) -> Vec<(String, PooledSessionStatus)> {
        let sessions = self.inner.sessions.read().await;
        sessions
            .values()
            .map(|s| (s.project_code.clone(), s.status))
            .collect()
    }

    // -----------------------------------------------------------------------
    // Lifecycle helpers
    // -----------------------------------------------------------------------

    /// Evict sessions whose `last_used_at` is older than the configured
    /// `idle_timeout_minutes`. Only `Ready` sessions are eligible.
    pub async fn evict_idle(&self) {
        let timeout = Duration::from_secs(self.inner.config.idle_timeout_minutes * 60);
        let now = Instant::now();

        let mut sessions = self.inner.sessions.write().await;
        let before = sessions.len();

        sessions.retain(|code, session| {
            if session.status == PooledSessionStatus::Ready
                && now.duration_since(session.last_used_at) > timeout
            {
                info!(
                    project = code.as_str(),
                    idle_secs = now.duration_since(session.last_used_at).as_secs(),
                    "Evicting idle session"
                );
                false
            } else {
                true
            }
        });

        let evicted = before - sessions.len();
        if evicted > 0 {
            info!(
                evicted,
                remaining = sessions.len(),
                "Idle eviction complete"
            );
        } else {
            debug!("Idle eviction: no sessions to evict");
        }
    }

    /// Check health of all sessions. Placeholder — real PID/gRPC check wired in Task 6.
    pub async fn health_check_all(&self) {
        let sessions = self.inner.sessions.read().await;
        for session in sessions.values() {
            debug!(
                project = session.project_code.as_str(),
                session_id = %session.session_id,
                status = %session.status,
                "Health check placeholder (no PID verification yet)"
            );
        }
    }

    /// Update the session ID for a project's pool entry.
    ///
    /// Called after a real CC session is spawned for a `Warming` placeholder
    /// so the pool tracks the actual session ID going forward.
    pub async fn set_session_id(&self, project_code: &str, session_id: String) {
        let mut sessions = self.inner.sessions.write().await;
        if let Some(session) = sessions.get_mut(project_code) {
            debug!(
                project = project_code,
                old_id = %session.session_id,
                new_id = %session_id,
                "Updating pool entry with real session ID"
            );
            session.session_id = session_id;
        } else {
            warn!(
                project = project_code,
                "set_session_id called but no pool entry found"
            );
        }
    }

    /// Mark all sessions as `Draining` and return their session IDs for
    /// graceful shutdown signalling.
    pub async fn drain_all(&self) -> Vec<String> {
        let mut sessions = self.inner.sessions.write().await;
        let ids: Vec<String> = sessions
            .values_mut()
            .map(|s| {
                s.status = PooledSessionStatus::Draining;
                s.session_id.clone()
            })
            .collect();

        if !ids.is_empty() {
            info!(count = ids.len(), "Draining all pooled sessions");
        }
        ids
    }
}

// ---------------------------------------------------------------------------
// Service impl
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
impl Service for SessionPool {
    fn name(&self) -> &'static str {
        "session-pool"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        if !self.inner.config.enabled {
            info!("Session pool disabled by config; service exiting immediately");
            return Ok(());
        }

        info!(
            max_sessions = self.inner.config.max_sessions,
            idle_timeout_minutes = self.inner.config.idle_timeout_minutes,
            "Session pool service started"
        );

        // Pre-warm projects listed in config.
        for code in &self.inner.config.warmup_on_startup.clone() {
            match self.get_or_create(code).await {
                Ok(id) => info!(project = code.as_str(), session_id = %id, "Pre-warmed session"),
                Err(e) => warn!(project = code.as_str(), error = %e, "Pre-warm failed"),
            }
        }

        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = interval.tick() => {
                    self.evict_idle().await;
                    self.health_check_all().await;
                }
                _ = shutdown_rx.recv() => {
                    info!("Session pool service shutting down");
                    self.drain_all().await;
                    break;
                }
            }
        }

        Ok(())
    }

    async fn health_check(&self) -> bool {
        let stats = self.stats().await;
        debug!(
            active = stats.active,
            idle = stats.idle,
            warming = stats.warming,
            total = stats.total,
            "Session pool health check"
        );
        true
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Generate a short pseudo-unique suffix without pulling in the uuid crate
/// directly (it's already a workspace dependency but not exposed here).
fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    format!("{:08x}", nanos)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pool() -> SessionPool {
        let config = PoolConfig {
            enabled: true,
            max_sessions: 3,
            idle_timeout_minutes: 15,
            warmup_on_startup: vec![],
        };
        let registry = ProjectRegistry::load_empty();
        SessionPool::new(config, registry)
    }

    #[tokio::test]
    async fn get_or_create_creates_new_session() {
        let pool = make_pool();
        let id = pool.get_or_create("oo").await.unwrap();
        assert!(id.starts_with("pool-oo-"), "unexpected id: {id}");

        let stats = pool.stats().await;
        assert_eq!(stats.total, 1);
        assert_eq!(stats.warming, 1);
    }

    #[tokio::test]
    async fn get_or_create_reuses_ready_session() {
        let pool = make_pool();
        let id1 = pool.get_or_create("oo").await.unwrap();
        // Manually transition to Ready so it can be reused.
        pool.release("oo").await;

        let id2 = pool.get_or_create("oo").await.unwrap();
        assert_eq!(id1, id2, "should reuse the same session");

        let stats = pool.stats().await;
        assert_eq!(stats.active, 1);
    }

    #[tokio::test]
    async fn release_sets_status_to_ready() {
        let pool = make_pool();
        pool.get_or_create("nx").await.unwrap();
        pool.release("nx").await;

        let stats = pool.stats().await;
        assert_eq!(stats.idle, 1);
        assert_eq!(stats.active, 0);
    }

    #[tokio::test]
    async fn remove_drops_session() {
        let pool = make_pool();
        pool.get_or_create("tc").await.unwrap();
        pool.remove("tc").await;

        let stats = pool.stats().await;
        assert_eq!(stats.total, 0);
    }

    #[tokio::test]
    async fn capacity_limit_returns_error() {
        let pool = make_pool(); // max_sessions = 3
        pool.get_or_create("a").await.unwrap();
        pool.get_or_create("b").await.unwrap();
        pool.get_or_create("c").await.unwrap();

        let result = pool.get_or_create("d").await;
        assert!(result.is_err(), "expected capacity error");
    }

    #[tokio::test]
    async fn evict_idle_removes_ready_sessions_past_timeout() {
        let config = PoolConfig {
            enabled: true,
            max_sessions: 5,
            idle_timeout_minutes: 0, // instant timeout for test
            warmup_on_startup: vec![],
        };
        let pool = SessionPool::new(config, ProjectRegistry::load_empty());

        pool.get_or_create("oo").await.unwrap();
        pool.release("oo").await; // status = Ready

        // With idle_timeout_minutes = 0, any Ready session is instantly stale.
        // But Duration::from_secs(0) means > 0 elapsed, so we sleep briefly.
        tokio::time::sleep(Duration::from_millis(1)).await;

        pool.evict_idle().await;

        let stats = pool.stats().await;
        assert_eq!(stats.total, 0, "idle session should have been evicted");
    }

    #[tokio::test]
    async fn drain_all_marks_sessions_draining() {
        let pool = make_pool();
        pool.get_or_create("oo").await.unwrap();
        pool.get_or_create("nx").await.unwrap();

        let ids = pool.drain_all().await;
        assert_eq!(ids.len(), 2);

        let sessions = pool.all_sessions().await;
        for (_, status) in &sessions {
            assert_eq!(*status, PooledSessionStatus::Draining);
        }
    }
}
