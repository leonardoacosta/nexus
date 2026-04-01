//! CronService — scheduled maintenance and drift detection.
//!
//! Two internal jobs:
//!
//! **maintain** (daily ~00:17): Prunes stale temp files, old failure JSONL,
//! old telemetry JSONL, debug logs, paste-cache, and session dirs.
//!
//! **drift** (weekly, Sunday ~09:00): Validates settings.json, checks for
//! orphaned worktree memory directories.
//!
//! Job results are persisted to SQLite via `NexusDb::insert_cron_run`.
//! In-memory [`CronState`] is updated for fast `/cron` HTTP reads.

use crate::cron_state::CronState;
use crate::services::Service;
use anyhow::{Context, Result};
use chrono::{Datelike, Local, NaiveTime, Weekday};
use nexus_core::db::{CronRunRecord, NexusDb};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{debug, error, info, warn};

// ---------------------------------------------------------------------------
// CronService
// ---------------------------------------------------------------------------

pub struct CronService {
    state: CronState,
    db: Arc<NexusDb>,
}

impl CronService {
    pub fn new(state: CronState, db: Arc<NexusDb>) -> Self {
        Self { state, db }
    }
}

#[async_trait::async_trait]
impl Service for CronService {
    fn name(&self) -> &'static str {
        "cron"
    }

    async fn start(&self, mut shutdown_rx: mpsc::Receiver<()>) -> Result<()> {
        info!("CronService starting — maintain(daily@00:17), drift(weekly Sun@09:00)");

        loop {
            // Calculate delay to the next job (whichever fires first).
            let now = Local::now();
            let next_maintain = next_daily_at(now, NaiveTime::from_hms_opt(0, 17, 0).unwrap());
            let next_drift =
                next_weekly_at(now, Weekday::Sun, NaiveTime::from_hms_opt(9, 0, 0).unwrap());

            let (next_job, delay) = if next_maintain <= next_drift {
                ("maintain", next_maintain - now)
            } else {
                ("drift", next_drift - now)
            };

            let delay_std = delay.to_std().unwrap_or(std::time::Duration::from_secs(60));
            debug!(
                job = next_job,
                delay_secs = delay_std.as_secs(),
                "sleeping until next cron job"
            );

            tokio::select! {
                _ = shutdown_rx.recv() => {
                    info!("CronService shutting down");
                    return Ok(());
                }
                _ = tokio::time::sleep(delay_std) => {
                    match next_job {
                        "maintain" => self.run_maintain().await,
                        "drift" => self.run_drift().await,
                        _ => unreachable!(),
                    }
                }
            }
        }
    }
}

impl CronService {
    // -----------------------------------------------------------------------
    // maintain job
    // -----------------------------------------------------------------------
    async fn run_maintain(&self) {
        let start = std::time::Instant::now();
        info!("cron: maintain job starting");
        let mut total_pruned: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut details: Vec<String> = Vec::new();
        let mut errors: Vec<String> = Vec::new();

        let home = match home_dir() {
            Some(h) => h,
            None => {
                error!("cron maintain: cannot determine HOME");
                return;
            }
        };

        // 1. Prune /tmp/nexus-* stale files (>24h)
        match prune_tmp_nexus().await {
            Ok((count, bytes)) => {
                if count > 0 {
                    details.push(format!("/tmp/nexus-*: {count} files, {bytes} bytes"));
                }
                total_pruned += count;
                total_bytes += bytes;
            }
            Err(e) => errors.push(format!("tmp prune: {e}")),
        }

        // 2. Prune ~/.claude/scripts/state/failures/*.jsonl files >30 days old
        let failures_dir = home.join(".claude/scripts/state/failures");
        match prune_old_files(&failures_dir, "*.jsonl", 30).await {
            Ok((count, bytes)) => {
                if count > 0 {
                    details.push(format!("failures/: {count} files, {bytes} bytes"));
                }
                total_pruned += count;
                total_bytes += bytes;
            }
            Err(e) => errors.push(format!("failures prune: {e}")),
        }

        // 3. Prune ~/.claude/telemetry/1p_failed_events.*.json >30 days old
        let telemetry_dir = home.join(".claude/telemetry");
        match prune_old_files(&telemetry_dir, "1p_failed_events.*.json", 30).await {
            Ok((count, bytes)) => {
                if count > 0 {
                    details.push(format!("telemetry/: {count} files, {bytes} bytes"));
                }
                total_pruned += count;
                total_bytes += bytes;
            }
            Err(e) => errors.push(format!("telemetry prune: {e}")),
        }

        // 4. Prune ~/.claude/debug/*.txt >7 days old
        let debug_dir = home.join(".claude/debug");
        match prune_old_files(&debug_dir, "*.txt", 7).await {
            Ok((count, bytes)) => {
                if count > 0 {
                    details.push(format!("debug/: {count} files, {bytes} bytes"));
                }
                total_pruned += count;
                total_bytes += bytes;
            }
            Err(e) => errors.push(format!("debug prune: {e}")),
        }

        // 5. Prune ~/.claude/paste-cache/* >30 days old
        let paste_dir = home.join(".claude/paste-cache");
        match prune_old_files(&paste_dir, "*", 30).await {
            Ok((count, bytes)) => {
                if count > 0 {
                    details.push(format!("paste-cache/: {count} files, {bytes} bytes"));
                }
                total_pruned += count;
                total_bytes += bytes;
            }
            Err(e) => errors.push(format!("paste-cache prune: {e}")),
        }

        // 6. Prune old SQLite records (sessions/failures/events: 30d, archived specs: 90d)
        match self.db.prune_old_records(30, 90) {
            Ok(stats) => {
                let db_total = stats.sessions_deleted
                    + stats.failures_deleted
                    + stats.events_deleted
                    + stats.specs_deleted
                    + stats.cron_runs_deleted
                    + stats.git_events_deleted
                    + stats.lifecycle_deleted;
                if db_total > 0 {
                    details.push(format!(
                        "db: {} sessions, {} failures, {} events, {} specs, {} cron, {} git, {} lifecycle",
                        stats.sessions_deleted,
                        stats.failures_deleted,
                        stats.events_deleted,
                        stats.specs_deleted,
                        stats.cron_runs_deleted,
                        stats.git_events_deleted,
                        stats.lifecycle_deleted,
                    ));
                    total_pruned += db_total as u64;
                }
            }
            Err(e) => errors.push(format!("db prune: {e}")),
        }

        let status = if errors.is_empty() {
            "success"
        } else {
            "partial"
        };

        let details_str = if details.is_empty() && errors.is_empty() {
            "nothing to prune".to_string()
        } else {
            let mut parts = details;
            for e in &errors {
                parts.push(format!("ERROR: {e}"));
            }
            parts.join("; ")
        };

        let duration_ms = start.elapsed().as_millis() as i64;

        info!(
            "cron: maintain complete — {} items, {} bytes freed, {}ms",
            total_pruned, total_bytes, duration_ms
        );

        // Write to SQLite DB.
        if let Err(e) = self.db.insert_cron_run(&CronRunRecord {
            id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            job: "maintain".to_string(),
            status: status.to_string(),
            details: Some(details_str.clone()),
            duration_ms: Some(duration_ms),
        }) {
            warn!("cron: failed to write maintain record to DB: {e}");
        }

        // Update in-memory state for /cron endpoint.
        let log_message = if total_pruned > 0 {
            format!("pruned {} items, freed {} bytes", total_pruned, total_bytes)
        } else {
            "nothing to prune".to_string()
        };
        self.state
            .record_run("maintain", status, &log_message)
            .await;
    }

    // -----------------------------------------------------------------------
    // drift job
    // -----------------------------------------------------------------------
    async fn run_drift(&self) {
        let start = std::time::Instant::now();
        info!("cron: drift job starting");
        let mut findings: Vec<String> = Vec::new();

        let home = match home_dir() {
            Some(h) => h,
            None => {
                error!("cron drift: cannot determine HOME");
                return;
            }
        };

        // 1. Validate ~/.claude/settings.json is valid JSON.
        let settings_path = home.join(".claude/settings.json");
        match tokio::fs::read_to_string(&settings_path).await {
            Ok(contents) => match serde_json::from_str::<serde_json::Value>(&contents) {
                Ok(_) => {
                    debug!("cron drift: settings.json is valid JSON");
                }
                Err(e) => {
                    findings.push(format!("settings.json: invalid JSON: {e}"));
                }
            },
            Err(e) => {
                findings.push(format!("settings.json: cannot read: {e}"));
            }
        }

        // 2. Check for orphaned worktree memory dirs.
        let projects_dir = home.join(".claude/projects");
        match find_orphaned_worktree_dirs(&projects_dir).await {
            Ok(orphans) => {
                if !orphans.is_empty() {
                    findings.push(format!(
                        "{} orphaned worktree dir(s): {}",
                        orphans.len(),
                        orphans.join(", ")
                    ));
                }
            }
            Err(e) => {
                findings.push(format!("worktree check failed: {e}"));
            }
        }

        let severity = if findings.iter().any(|f| f.contains("invalid JSON")) {
            "error"
        } else if findings.is_empty() {
            "ok"
        } else {
            "warn"
        };

        let status = if findings.is_empty() {
            "success"
        } else {
            severity
        };

        let duration_ms = start.elapsed().as_millis() as i64;

        info!(
            "cron: drift complete — {} finding(s), severity={}, {}ms",
            findings.len(),
            severity,
            duration_ms
        );

        let details_str = if findings.is_empty() {
            "no drift detected".to_string()
        } else {
            format!("{} findings: {}", findings.len(), findings.join(", "))
        };

        // Write to SQLite DB.
        if let Err(e) = self.db.insert_cron_run(&CronRunRecord {
            id: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
            job: "drift".to_string(),
            status: status.to_string(),
            details: Some(details_str.clone()),
            duration_ms: Some(duration_ms),
        }) {
            warn!("cron: failed to write drift record to DB: {e}");
        }

        // Update in-memory state for /cron endpoint.
        self.state
            .record_run("drift", status, &details_str)
            .await;
    }
}

// ---------------------------------------------------------------------------
// Schedule calculation helpers
// ---------------------------------------------------------------------------

/// Calculate the next occurrence of a daily time from `now`.
/// If the time has already passed today, returns tomorrow at that time.
fn next_daily_at(now: chrono::DateTime<Local>, time: NaiveTime) -> chrono::DateTime<Local> {
    let today_at = now
        .date_naive()
        .and_time(time)
        .and_local_timezone(Local)
        .latest()
        .unwrap_or(now);

    if today_at > now {
        today_at
    } else {
        let tomorrow = now.date_naive() + chrono::Duration::days(1);
        tomorrow
            .and_time(time)
            .and_local_timezone(Local)
            .latest()
            .unwrap_or(now + chrono::Duration::days(1))
    }
}

/// Calculate the next occurrence of a weekly day+time from `now`.
/// If we're past that day/time this week, returns next week.
fn next_weekly_at(
    now: chrono::DateTime<Local>,
    weekday: Weekday,
    time: NaiveTime,
) -> chrono::DateTime<Local> {
    let today = now.date_naive();
    let current_weekday = today.weekday();

    let days_ahead =
        (weekday.num_days_from_monday() as i64 - current_weekday.num_days_from_monday() as i64 + 7)
            % 7;

    let target_date = today + chrono::Duration::days(days_ahead);
    let target_dt = target_date
        .and_time(time)
        .and_local_timezone(Local)
        .latest()
        .unwrap_or(now);

    if target_dt > now {
        target_dt
    } else {
        let next_week = target_date + chrono::Duration::days(7);
        next_week
            .and_time(time)
            .and_local_timezone(Local)
            .latest()
            .unwrap_or(now + chrono::Duration::days(7))
    }
}

// ---------------------------------------------------------------------------
// Job helpers
// ---------------------------------------------------------------------------

fn home_dir() -> Option<PathBuf> {
    let p = nexus_core::paths::home_dir();
    // Return None if the fallback /tmp sentinel was used.
    if p.as_os_str() == "/tmp" {
        None
    } else {
        Some(p)
    }
}

/// Prune /tmp/nexus-* files older than 24 hours.
async fn prune_tmp_nexus() -> Result<(u64, u64)> {
    let output = tokio::process::Command::new("find")
        .args([
            "/tmp",
            "-maxdepth",
            "1",
            "-name",
            "nexus-*",
            "-mmin",
            "+1440",
            "-type",
            "f",
        ])
        .output()
        .await
        .context("failed to run find for /tmp/nexus-*")?;

    if !output.status.success() {
        return Ok((0, 0));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();

    let mut count: u64 = 0;
    let mut bytes: u64 = 0;

    for file in files {
        let path = Path::new(file);
        match tokio::fs::metadata(path).await {
            Ok(meta) => {
                bytes += meta.len();
                if let Err(e) = tokio::fs::remove_file(path).await {
                    warn!("cron: failed to remove {}: {e}", path.display());
                } else {
                    count += 1;
                    debug!("cron: pruned {}", path.display());
                }
            }
            Err(_) => continue,
        }
    }

    Ok((count, bytes))
}

/// Prune files matching a glob pattern older than `days` in a directory.
async fn prune_old_files(dir: &Path, pattern: &str, days: u32) -> Result<(u64, u64)> {
    if !dir.exists() {
        return Ok((0, 0));
    }

    let output = tokio::process::Command::new("find")
        .args([
            dir.to_str().unwrap_or("/dev/null"),
            "-maxdepth",
            "1",
            "-name",
            pattern,
            "-mtime",
            &format!("+{days}"),
            "-type",
            "f",
        ])
        .output()
        .await
        .context("failed to run find")?;

    if !output.status.success() {
        return Ok((0, 0));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let files: Vec<&str> = stdout.lines().filter(|l| !l.is_empty()).collect();

    let mut count: u64 = 0;
    let mut bytes: u64 = 0;

    for file in files {
        let path = Path::new(file);
        match tokio::fs::metadata(path).await {
            Ok(meta) => {
                bytes += meta.len();
                if let Err(e) = tokio::fs::remove_file(path).await {
                    warn!("cron: failed to remove {}: {e}", path.display());
                } else {
                    count += 1;
                    debug!("cron: pruned {}", path.display());
                }
            }
            Err(_) => continue,
        }
    }

    Ok((count, bytes))
}

/// Find orphaned worktree memory directories in ~/.claude/projects/.
async fn find_orphaned_worktree_dirs(projects_dir: &Path) -> Result<Vec<String>> {
    if !projects_dir.exists() {
        return Ok(vec![]);
    }

    let mut worktree_dirs: Vec<String> = Vec::new();
    let mut entries = tokio::fs::read_dir(projects_dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains("worktrees") && entry.file_type().await?.is_dir() {
            worktree_dirs.push(name);
        }
    }

    if worktree_dirs.is_empty() {
        return Ok(vec![]);
    }

    // Get active worktree names from git.
    let active_worktrees = match tokio::process::Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let stdout = String::from_utf8_lossy(&output.stdout);
            stdout
                .lines()
                .filter_map(|l| l.strip_prefix("worktree "))
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        }
        _ => vec![],
    };

    let orphans: Vec<String> = worktree_dirs
        .into_iter()
        .filter(|dir_name| {
            let is_active = active_worktrees
                .iter()
                .any(|wt| dir_name.contains(wt.rsplit('/').next().unwrap_or("")));
            !is_active
        })
        .collect();

    Ok(orphans)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Timelike};

    #[test]
    fn test_next_daily_at_future_today() {
        let now = Local.with_ymd_and_hms(2026, 3, 30, 10, 0, 0).unwrap();
        let target = NaiveTime::from_hms_opt(23, 0, 0).unwrap();
        let next = next_daily_at(now, target);
        assert_eq!(next.hour(), 23);
        assert_eq!(next.day(), 30);
    }

    #[test]
    fn test_next_daily_at_past_today() {
        let now = Local.with_ymd_and_hms(2026, 3, 30, 10, 0, 0).unwrap();
        let target = NaiveTime::from_hms_opt(0, 17, 0).unwrap();
        let next = next_daily_at(now, target);
        assert_eq!(next.hour(), 0);
        assert_eq!(next.minute(), 17);
        assert_eq!(next.day(), 31);
    }

    #[test]
    fn test_next_weekly_at_future_this_week() {
        let now = Local.with_ymd_and_hms(2026, 3, 30, 10, 0, 0).unwrap();
        assert_eq!(now.weekday(), Weekday::Mon);
        let target = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
        let next = next_weekly_at(now, Weekday::Sun, target);
        assert_eq!(next.weekday(), Weekday::Sun);
        assert!(next > now);
    }

    #[test]
    fn test_next_weekly_at_past_this_week() {
        let now = Local.with_ymd_and_hms(2026, 3, 29, 10, 0, 0).unwrap();
        assert_eq!(now.weekday(), Weekday::Sun);
        let target = NaiveTime::from_hms_opt(9, 0, 0).unwrap();
        let next = next_weekly_at(now, Weekday::Sun, target);
        assert_eq!(next.weekday(), Weekday::Sun);
        assert!(next > now);
        // March 29 + 7 = April 5
        assert_eq!(next.month(), 4);
        assert_eq!(next.day(), 5);
    }
}
