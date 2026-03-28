//! Notification batching buffer for coalescing rapid notifications
//!
//! This module provides batching and coalescing of notifications by type.
//! Features:
//! - Build notification coalescing (e.g., "3 gates: 2 passed, 1 failed")
//! - Reminder coalescing (e.g., "Claude waiting (5 reminders suppressed)")
//! - Focus session mode (batch all notifications while user is AFK)

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// A queued notification waiting to be batched
#[derive(Debug, Clone)]
pub struct QueuedNotification {
    pub message: String,
    pub notification_type: String,
    pub project: Option<String>,
    pub received_at: Instant,
}

/// Notification batching buffer that coalesces rapid notifications
pub struct NotificationBatchBuffer {
    /// Notifications queued by type
    queues: HashMap<String, Vec<QueuedNotification>>,
    /// Window for coalescing build notifications
    build_coalesce_window: Duration,
    /// Whether reminder coalescing is enabled
    reminder_coalesce: bool,
    /// Whether focus session mode is active (user is AFK, batch everything)
    focus_session_active: bool,
    /// When the user last had terminal focus
    last_focus_at: Option<Instant>,
}

impl NotificationBatchBuffer {
    pub fn new(build_coalesce_window_ms: u64, reminder_coalesce: bool) -> Self {
        Self {
            queues: HashMap::new(),
            build_coalesce_window: Duration::from_millis(build_coalesce_window_ms),
            reminder_coalesce,
            focus_session_active: false,
            last_focus_at: Some(Instant::now()),
        }
    }

    /// Add a notification to the batch queue. Returns None if batched,
    /// or Some(message) if it should be delivered immediately.
    pub fn add(&mut self, notification: QueuedNotification) -> Option<String> {
        let ntype = notification.notification_type.clone();

        // If not in batching mode and not a coalesceable type, deliver immediately
        if !self.focus_session_active && !self.should_coalesce(&ntype) {
            return Some(notification.message.clone());
        }

        // Add to queue
        self.queues.entry(ntype).or_default().push(notification);
        None
    }

    /// Check if a notification type should be coalesced
    fn should_coalesce(&self, notification_type: &str) -> bool {
        match notification_type {
            "quality_gates" => true, // Always coalesce build results
            "reminders" => self.reminder_coalesce,
            _ if self.focus_session_active => true, // Coalesce everything in focus mode
            _ => false,
        }
    }

    /// Set focus session state
    pub fn set_focus_session(&mut self, active: bool) {
        self.focus_session_active = active;
        if !active {
            self.last_focus_at = Some(Instant::now());
        }
    }

    /// Flush all ready batches. Returns a list of (type, coalesced_message) pairs.
    pub fn flush_ready(&mut self) -> Vec<(String, String)> {
        let mut results = Vec::new();
        let mut types_to_remove = Vec::new();

        for (ntype, queue) in &self.queues {
            if queue.is_empty() {
                continue;
            }

            match ntype.as_str() {
                "quality_gates" => {
                    // Check if coalesce window has passed since first entry
                    if let Some(first) = queue.first() {
                        if first.received_at.elapsed() >= self.build_coalesce_window {
                            let coalesced = self.coalesce_quality_gates(queue);
                            results.push((ntype.clone(), coalesced));
                            types_to_remove.push(ntype.clone());
                        }
                    }
                }
                "reminders" if self.reminder_coalesce => {
                    if queue.len() >= 2 {
                        let coalesced = self.coalesce_reminders(queue);
                        results.push((ntype.clone(), coalesced));
                        types_to_remove.push(ntype.clone());
                    }
                }
                _ if self.focus_session_active => {
                    // In focus mode, don't flush until focus returns
                }
                _ => {
                    // Deliver immediately
                    for item in queue {
                        results.push((ntype.clone(), item.message.clone()));
                    }
                    types_to_remove.push(ntype.clone());
                }
            }
        }

        for ntype in types_to_remove {
            self.queues.remove(&ntype);
        }

        results
    }

    /// Flush everything (focus session ended, user returned)
    pub fn flush_all(&mut self) -> Vec<(String, String)> {
        let mut results = Vec::new();

        // Collect drain into vec first to avoid mutable/immutable borrow conflict
        let queues: Vec<(String, Vec<QueuedNotification>)> = self.queues.drain().collect();

        for (ntype, queue) in queues {
            if queue.is_empty() {
                continue;
            }

            let coalesced = match ntype.as_str() {
                "quality_gates" => self.coalesce_quality_gates(&queue),
                "reminders" if self.reminder_coalesce && queue.len() >= 2 => {
                    self.coalesce_reminders(&queue)
                }
                _ => {
                    // For other types, create a digest
                    if queue.len() == 1 {
                        queue[0].message.clone()
                    } else {
                        format!(
                            "{} notifications: {}",
                            queue.len(),
                            queue
                                .iter()
                                .map(|q| q.message.as_str())
                                .collect::<Vec<_>>()
                                .join("; ")
                        )
                    }
                }
            };
            results.push((ntype, coalesced));
        }

        results
    }

    /// Coalesce quality gate notifications: "3 gates: 2 passed, 1 failed"
    fn coalesce_quality_gates(&self, queue: &[QueuedNotification]) -> String {
        let total = queue.len();
        let passed = queue
            .iter()
            .filter(|q| {
                let lower = q.message.to_lowercase();
                lower.contains("pass") || lower.contains("success") || lower.contains("complete")
            })
            .count();
        let failed = total - passed;

        if failed == 0 {
            format!("All {} quality gates passed", total)
        } else if passed == 0 {
            format!("All {} quality gates failed", total)
        } else {
            format!("{} gates: {} passed, {} failed", total, passed, failed)
        }
    }

    /// Coalesce reminders: "Claude has been waiting N minutes (M reminders)"
    fn coalesce_reminders(&self, queue: &[QueuedNotification]) -> String {
        let count = queue.len();
        // Extract wait time from last reminder message if possible
        if let Some(last) = queue.last() {
            if last.message.contains("waiting") {
                return format!("{} ({} reminders suppressed)", last.message, count - 1);
            }
        }
        format!("Claude has been waiting ({} reminders)", count)
    }

    /// Get total queued count
    pub fn total_queued(&self) -> usize {
        self.queues.values().map(|q| q.len()).sum()
    }
}

/// Check if the terminal has focus (simplified X11 check)
pub async fn is_terminal_focused() -> bool {
    // Try xdotool to get active window name
    if let Ok(output) = tokio::process::Command::new("xdotool")
        .args(["getactivewindow", "getwindowname"])
        .output()
        .await
    {
        if output.status.success() {
            let name = String::from_utf8_lossy(&output.stdout).to_lowercase();
            let terminal_indicators = [
                "kitty",
                "alacritty",
                "wezterm",
                "foot",
                "ghostty",
                "terminal",
                "tmux",
                "konsole",
            ];
            return terminal_indicators.iter().any(|t| name.contains(t));
        }
    }
    // Default: assume focused
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_should_coalesce_quality_gates() {
        let buffer = NotificationBatchBuffer::new(30000, true);
        assert!(buffer.should_coalesce("quality_gates"));
        assert!(!buffer.should_coalesce("background_tasks"));
    }

    #[test]
    fn test_should_coalesce_reminders() {
        let buffer = NotificationBatchBuffer::new(30000, true);
        assert!(buffer.should_coalesce("reminders"));

        let buffer_no_reminder = NotificationBatchBuffer::new(30000, false);
        assert!(!buffer_no_reminder.should_coalesce("reminders"));
    }

    #[test]
    fn test_focus_mode_coalesces_all() {
        let mut buffer = NotificationBatchBuffer::new(30000, false);
        buffer.set_focus_session(true);

        assert!(buffer.should_coalesce("background_tasks"));
        assert!(buffer.should_coalesce("deployments"));
        assert!(buffer.should_coalesce("anything"));
    }

    #[test]
    fn test_add_immediate_delivery() {
        let mut buffer = NotificationBatchBuffer::new(30000, false);
        let notification = QueuedNotification {
            message: "Test message".to_string(),
            notification_type: "background_tasks".to_string(),
            project: None,
            received_at: Instant::now(),
        };

        let result = buffer.add(notification);
        assert_eq!(result, Some("Test message".to_string()));
        assert_eq!(buffer.total_queued(), 0);
    }

    #[test]
    fn test_add_batched() {
        let mut buffer = NotificationBatchBuffer::new(30000, true);
        let notification = QueuedNotification {
            message: "Build passed".to_string(),
            notification_type: "quality_gates".to_string(),
            project: Some("oo".to_string()),
            received_at: Instant::now(),
        };

        let result = buffer.add(notification);
        assert_eq!(result, None);
        assert_eq!(buffer.total_queued(), 1);
    }

    #[test]
    fn test_coalesce_quality_gates_all_passed() {
        let buffer = NotificationBatchBuffer::new(30000, true);
        let queue = vec![
            QueuedNotification {
                message: "Lint passed".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
            QueuedNotification {
                message: "Tests passed".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
        ];

        let result = buffer.coalesce_quality_gates(&queue);
        assert_eq!(result, "All 2 quality gates passed");
    }

    #[test]
    fn test_coalesce_quality_gates_all_failed() {
        let buffer = NotificationBatchBuffer::new(30000, true);
        let queue = vec![
            QueuedNotification {
                message: "Lint failed".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
            QueuedNotification {
                message: "Tests failed".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
        ];

        let result = buffer.coalesce_quality_gates(&queue);
        assert_eq!(result, "All 2 quality gates failed");
    }

    #[test]
    fn test_coalesce_quality_gates_mixed() {
        let buffer = NotificationBatchBuffer::new(30000, true);
        let queue = vec![
            QueuedNotification {
                message: "Lint passed".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
            QueuedNotification {
                message: "Tests failed".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
            QueuedNotification {
                message: "Build complete".to_string(),
                notification_type: "quality_gates".to_string(),
                project: None,
                received_at: Instant::now(),
            },
        ];

        let result = buffer.coalesce_quality_gates(&queue);
        assert_eq!(result, "3 gates: 2 passed, 1 failed");
    }

    #[test]
    fn test_coalesce_reminders() {
        let buffer = NotificationBatchBuffer::new(30000, true);
        let queue = vec![
            QueuedNotification {
                message: "Claude waiting 5 minutes".to_string(),
                notification_type: "reminders".to_string(),
                project: None,
                received_at: Instant::now(),
            },
            QueuedNotification {
                message: "Claude waiting 10 minutes".to_string(),
                notification_type: "reminders".to_string(),
                project: None,
                received_at: Instant::now(),
            },
            QueuedNotification {
                message: "Claude waiting 15 minutes".to_string(),
                notification_type: "reminders".to_string(),
                project: None,
                received_at: Instant::now(),
            },
        ];

        let result = buffer.coalesce_reminders(&queue);
        assert_eq!(result, "Claude waiting 15 minutes (2 reminders suppressed)");
    }

    #[test]
    fn test_flush_all() {
        let mut buffer = NotificationBatchBuffer::new(30000, true);
        buffer.set_focus_session(true);

        // Add multiple notifications
        buffer.add(QueuedNotification {
            message: "Build passed".to_string(),
            notification_type: "quality_gates".to_string(),
            project: None,
            received_at: Instant::now(),
        });
        buffer.add(QueuedNotification {
            message: "Test failed".to_string(),
            notification_type: "quality_gates".to_string(),
            project: None,
            received_at: Instant::now(),
        });
        buffer.add(QueuedNotification {
            message: "Deploy complete".to_string(),
            notification_type: "deployments".to_string(),
            project: None,
            received_at: Instant::now(),
        });

        let results = buffer.flush_all();
        assert_eq!(results.len(), 2); // quality_gates + deployments

        // Find quality_gates result
        let qg = results.iter().find(|(t, _)| t == "quality_gates").unwrap();
        assert_eq!(qg.1, "2 gates: 1 passed, 1 failed");

        // Check that queue is now empty
        assert_eq!(buffer.total_queued(), 0);
    }
}
