//! Meeting-aware notification queue
//!
//! When a meeting/call is detected, notifications are queued per-project
//! instead of being delivered immediately. When the meeting ends, queued
//! notifications are flushed as per-project summaries via TTS + banner.
//!
//! # Flow
//!
//! 1. `http_router` detects meeting active → calls `enqueue()`
//! 2. Background poll task checks meeting state every N seconds
//! 3. Meeting ends → `drain()` returns per-project notification groups
//! 4. Each group is delivered as a summary TTS + banner notification

use chrono::{DateTime, Utc};
use std::collections::HashMap;
use tracing::{debug, info};

/// A notification held during a meeting
#[derive(Debug, Clone)]
pub struct HeldNotification {
    /// The notification message text
    pub message: String,
    /// Project code (e.g., "oo", "tc")
    pub project: Option<String>,
    /// Notification type (e.g., "quality_gates", "deployments")
    pub notification_type: String,
    /// When the notification was received
    pub received_at: DateTime<Utc>,
}

/// Per-project summary ready for delivery after a meeting
#[derive(Debug, Clone)]
pub struct ProjectSummary {
    /// Project code
    pub project: Option<String>,
    /// Combined summary message for TTS
    pub tts_message: String,
    /// Individual notification messages (for banner/detailed view)
    pub messages: Vec<String>,
    /// Count of notifications held
    pub count: usize,
    /// Earliest notification timestamp
    pub earliest: DateTime<Utc>,
    /// Latest notification timestamp
    pub latest: DateTime<Utc>,
}

/// Meeting notification queue
///
/// Holds notifications per-project while a meeting is active.
/// Thread-safe access is provided by wrapping in `Arc<RwLock<>>` in ReceiverState.
pub struct MeetingQueue {
    /// Notifications grouped by project key
    queue: HashMap<String, Vec<HeldNotification>>,
    /// Whether a meeting is currently detected
    meeting_active: bool,
    /// When the current meeting was first detected
    meeting_started_at: Option<DateTime<Utc>>,
    /// When the meeting ended (for cooldown period)
    meeting_ended_at: Option<DateTime<Utc>>,
}

impl Default for MeetingQueue {
    fn default() -> Self {
        Self::new()
    }
}

impl MeetingQueue {
    pub fn new() -> Self {
        Self {
            queue: HashMap::new(),
            meeting_active: false,
            meeting_started_at: None,
            meeting_ended_at: None,
        }
    }

    /// Check if a meeting is currently active
    pub fn is_meeting_active(&self) -> bool {
        self.meeting_active
    }

    /// Update meeting state. Returns true if state changed (for transition detection).
    pub fn set_meeting_active(&mut self, active: bool) -> MeetingTransition {
        let was_active = self.meeting_active;
        self.meeting_active = active;

        match (was_active, active) {
            (false, true) => {
                self.meeting_started_at = Some(Utc::now());
                self.meeting_ended_at = None;
                info!("Meeting started — notifications will be queued");
                MeetingTransition::Started
            }
            (true, false) => {
                self.meeting_ended_at = Some(Utc::now());
                info!(
                    "Meeting ended — {} notifications queued across {} projects",
                    self.total_count(),
                    self.queue.len()
                );
                MeetingTransition::Ended
            }
            _ => MeetingTransition::NoChange,
        }
    }

    /// Queue a notification during a meeting
    pub fn enqueue(&mut self, notification: HeldNotification) {
        let key = notification
            .project
            .clone()
            .unwrap_or_else(|| "global".to_string());

        debug!(
            "Queuing notification for project '{}': {}",
            key,
            truncate(&notification.message, 60)
        );

        self.queue.entry(key).or_default().push(notification);
    }

    /// Drain all queued notifications and produce per-project summaries
    ///
    /// Returns summaries sorted by project (alphabetical), with "global" last.
    /// Clears the internal queue.
    pub fn drain(&mut self) -> Vec<ProjectSummary> {
        if self.queue.is_empty() {
            return Vec::new();
        }

        let mut summaries: Vec<ProjectSummary> = Vec::new();

        for (key, notifications) in self.queue.drain() {
            if notifications.is_empty() {
                continue;
            }

            let count = notifications.len();
            let project = notifications[0].project.clone();
            let earliest = notifications
                .iter()
                .map(|n| n.received_at)
                .min()
                .unwrap();
            let latest = notifications
                .iter()
                .map(|n| n.received_at)
                .max()
                .unwrap();

            let messages: Vec<String> = notifications.iter().map(|n| n.message.clone()).collect();
            let tts_message = build_tts_summary(&key, &messages);

            summaries.push(ProjectSummary {
                project,
                tts_message,
                messages,
                count,
                earliest,
                latest,
            });
        }

        // Sort: named projects alphabetically, "global" last
        summaries.sort_by(|a, b| {
            let a_key = a.project.as_deref().unwrap_or("zzz_global");
            let b_key = b.project.as_deref().unwrap_or("zzz_global");
            a_key.cmp(b_key)
        });

        info!(
            "Drained {} project summaries from meeting queue",
            summaries.len()
        );
        summaries
    }

    /// Total number of notifications currently queued
    pub fn total_count(&self) -> usize {
        self.queue.values().map(|v| v.len()).sum()
    }

    /// Number of projects with queued notifications
    pub fn project_count(&self) -> usize {
        self.queue.len()
    }

    /// When the current meeting started (if active)
    pub fn meeting_started_at(&self) -> Option<DateTime<Utc>> {
        self.meeting_started_at
    }
}

/// Meeting state transition
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MeetingTransition {
    /// Meeting just started (was inactive, now active)
    Started,
    /// Meeting just ended (was active, now inactive)
    Ended,
    /// No change in meeting state
    NoChange,
}

/// Build a TTS-friendly summary message for a project's queued notifications
fn build_tts_summary(project_key: &str, messages: &[String]) -> String {
    let count = messages.len();

    if count == 1 {
        // Single notification — just read it
        return messages[0].clone();
    }

    if count <= 3 {
        // 2-3 notifications — read them joined
        let joined = messages.join(". ");
        return format!("{count} updates while you were away. {joined}");
    }

    // 4+ notifications — summarize with first and last
    let first = truncate(&messages[0], 80);
    let last = truncate(&messages[messages.len() - 1], 80);
    format!(
        "{count} updates for {project_key} while you were away. First: {first}. Latest: {last}."
    )
}

/// Truncate a string to max_len characters, adding "..." if truncated
fn truncate(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len.saturating_sub(3)])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_notification(message: &str, project: Option<&str>) -> HeldNotification {
        HeldNotification {
            message: message.to_string(),
            project: project.map(|s| s.to_string()),
            notification_type: "notification".to_string(),
            received_at: Utc::now(),
        }
    }

    #[test]
    fn test_new_queue_is_empty() {
        let queue = MeetingQueue::new();
        assert!(!queue.is_meeting_active());
        assert_eq!(queue.total_count(), 0);
        assert_eq!(queue.project_count(), 0);
    }

    #[test]
    fn test_meeting_transitions() {
        let mut queue = MeetingQueue::new();

        assert_eq!(
            queue.set_meeting_active(true),
            MeetingTransition::Started
        );
        assert!(queue.is_meeting_active());
        assert!(queue.meeting_started_at().is_some());

        // No change when already active
        assert_eq!(
            queue.set_meeting_active(true),
            MeetingTransition::NoChange
        );

        assert_eq!(
            queue.set_meeting_active(false),
            MeetingTransition::Ended
        );
        assert!(!queue.is_meeting_active());

        // No change when already inactive
        assert_eq!(
            queue.set_meeting_active(false),
            MeetingTransition::NoChange
        );
    }

    #[test]
    fn test_enqueue_and_drain() {
        let mut queue = MeetingQueue::new();
        queue.set_meeting_active(true);

        queue.enqueue(make_notification("Build passed", Some("oo")));
        queue.enqueue(make_notification("Tests green", Some("oo")));
        queue.enqueue(make_notification("Deploy started", Some("tc")));

        assert_eq!(queue.total_count(), 3);
        assert_eq!(queue.project_count(), 2);

        let summaries = queue.drain();
        assert_eq!(summaries.len(), 2);
        assert_eq!(queue.total_count(), 0);

        // Should be sorted alphabetically
        assert_eq!(summaries[0].project, Some("oo".to_string()));
        assert_eq!(summaries[0].count, 2);
        assert_eq!(summaries[1].project, Some("tc".to_string()));
        assert_eq!(summaries[1].count, 1);
    }

    #[test]
    fn test_drain_empty_queue() {
        let mut queue = MeetingQueue::new();
        let summaries = queue.drain();
        assert!(summaries.is_empty());
    }

    #[test]
    fn test_global_project_sorts_last() {
        let mut queue = MeetingQueue::new();
        queue.set_meeting_active(true);

        queue.enqueue(make_notification("Global msg", None));
        queue.enqueue(make_notification("OO msg", Some("oo")));

        let summaries = queue.drain();
        assert_eq!(summaries.len(), 2);
        assert_eq!(summaries[0].project, Some("oo".to_string()));
        assert!(summaries[1].project.is_none()); // global is last
    }

    #[test]
    fn test_tts_summary_single() {
        let summary = build_tts_summary("oo", &["Build passed".to_string()]);
        assert_eq!(summary, "Build passed");
    }

    #[test]
    fn test_tts_summary_few() {
        let summary = build_tts_summary(
            "oo",
            &[
                "Build passed".to_string(),
                "Tests green".to_string(),
            ],
        );
        assert!(summary.contains("2 updates"));
        assert!(summary.contains("Build passed"));
        assert!(summary.contains("Tests green"));
    }

    #[test]
    fn test_tts_summary_many() {
        let msgs: Vec<String> = (0..5).map(|i| format!("Update {}", i)).collect();
        let summary = build_tts_summary("oo", &msgs);
        assert!(summary.contains("5 updates"));
        assert!(summary.contains("First:"));
        assert!(summary.contains("Latest:"));
    }

    #[test]
    fn test_truncate() {
        assert_eq!(truncate("short", 10), "short");
        assert_eq!(truncate("this is a long string", 10), "this is...");
    }
}
