//! Schema migration functions.

use anyhow::Result;
use rusqlite::Connection;

/// V1 Migration — core tables (specs, sessions, failures, events).
pub(crate) fn migrate_v1(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS specs (
            id TEXT PRIMARY KEY,
            project TEXT NOT NULL,
            name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'unread',
            title TEXT,
            summary TEXT,
            tasks_total INTEGER DEFAULT 0,
            tasks_done INTEGER DEFAULT 0,
            proposal_hash TEXT,
            discovered_at TEXT NOT NULL,
            read_at TEXT,
            approved_at TEXT,
            applied_at TEXT,
            archived_at TEXT,
            rejected_at TEXT,
            rejection_reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_specs_project ON specs(project);
        CREATE INDEX IF NOT EXISTS idx_specs_status ON specs(status);

        CREATE TABLE IF NOT EXISTS sessions (
            id TEXT PRIMARY KEY,
            pid INTEGER,
            project TEXT,
            cwd TEXT,
            branch TEXT,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            last_heartbeat TEXT,
            status TEXT,
            model TEXT,
            session_type TEXT,
            total_cost_usd REAL,
            rate_limit_utilization REAL,
            rate_limit_type TEXT,
            tmux_target TEXT,
            cc_session_id TEXT,
            agent TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
        CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);

        CREATE TABLE IF NOT EXISTS failures (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            error_summary TEXT,
            project TEXT,
            session_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_failures_timestamp ON failures(timestamp);
        CREATE INDEX IF NOT EXISTS idx_failures_tool ON failures(tool_name);
        CREATE INDEX IF NOT EXISTS idx_failures_project ON failures(project);

        CREATE TABLE IF NOT EXISTS events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            actor TEXT,
            target TEXT,
            details TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
        ",
    )?;
    Ok(())
}

/// V2 Migration — analytics tables.
pub(crate) fn migrate_v2(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS health_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            cpu_percent REAL,
            memory_used_gb REAL,
            memory_total_gb REAL,
            disk_used_gb REAL,
            disk_total_gb REAL,
            load1 REAL,
            load5 REAL,
            load15 REAL,
            uptime_seconds INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_health_timestamp ON health_samples(timestamp);

        CREATE TABLE IF NOT EXISTS spec_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            project TEXT NOT NULL,
            spec_name TEXT NOT NULL,
            completed_tasks INTEGER,
            total_tasks INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_spec_snap_project ON spec_snapshots(project, spec_name);
        CREATE INDEX IF NOT EXISTS idx_spec_snap_timestamp ON spec_snapshots(timestamp);

        CREATE TABLE IF NOT EXISTS credential_polls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            account TEXT NOT NULL,
            five_hour_utilization REAL,
            seven_day_utilization REAL,
            five_hour_resets_at TEXT,
            seven_day_resets_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cred_poll_account ON credential_polls(account);
        CREATE INDEX IF NOT EXISTS idx_cred_poll_timestamp ON credential_polls(timestamp);

        CREATE TABLE IF NOT EXISTS credential_swaps (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            from_account TEXT NOT NULL,
            to_account TEXT NOT NULL,
            trigger_session_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_cred_swap_timestamp ON credential_swaps(timestamp);

        CREATE TABLE IF NOT EXISTS notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            message TEXT NOT NULL,
            message_type TEXT,
            project TEXT,
            channels TEXT,
            delivered INTEGER NOT NULL DEFAULT 1,
            suppressed INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_notif_timestamp ON notifications(timestamp);
        CREATE INDEX IF NOT EXISTS idx_notif_project ON notifications(project);
        ",
    )?;
    Ok(())
}

/// V4 Migration — drop health_samples (superseded by PostgreSQL health_snapshots).
pub(crate) fn migrate_v4(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        DROP TABLE IF EXISTS health_samples;
        DROP INDEX IF EXISTS idx_health_timestamp;
        ",
    )?;
    Ok(())
}

/// V3 Migration — consolidation tables (cron_runs, git_events, agent_lifecycle).
pub(crate) fn migrate_v3(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS cron_runs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            job TEXT NOT NULL,
            status TEXT NOT NULL,
            details TEXT,
            duration_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_cron_timestamp ON cron_runs(timestamp);
        CREATE INDEX IF NOT EXISTS idx_cron_job ON cron_runs(job);

        CREATE TABLE IF NOT EXISTS git_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            project TEXT NOT NULL,
            event_type TEXT NOT NULL,
            old_ref TEXT,
            new_ref TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_git_timestamp ON git_events(timestamp);
        CREATE INDEX IF NOT EXISTS idx_git_project ON git_events(project);

        CREATE TABLE IF NOT EXISTS agent_lifecycle (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            event_type TEXT NOT NULL,
            version TEXT,
            uptime_seconds INTEGER,
            reason TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_lifecycle_timestamp ON agent_lifecycle(timestamp);
        ",
    )?;
    Ok(())
}
