//! Notification manager and notification panel state.

use std::collections::VecDeque;
use std::time::Instant;

// ---------------------------------------------------------------------------
// Notification system
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone)]
pub struct Notification {
    pub message: String,
    pub severity: Severity,
    pub created_at: Instant,
}

/// Manages transient notifications displayed in the status bar.
pub struct NotificationManager {
    pub queue: VecDeque<Notification>,
}

impl std::fmt::Debug for NotificationManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotificationManager")
            .field("queue_len", &self.queue.len())
            .finish()
    }
}

impl NotificationManager {
    pub fn new() -> Self {
        Self {
            queue: VecDeque::new(),
        }
    }

    /// Add a notification.
    pub fn push(&mut self, message: String, severity: Severity) {
        self.queue.push_back(Notification {
            message,
            severity,
            created_at: Instant::now(),
        });
    }

    /// Remove notifications older than 10 seconds.
    pub fn tick(&mut self) {
        let cutoff = std::time::Duration::from_secs(10);
        self.queue.retain(|n| n.created_at.elapsed() < cutoff);
    }

    /// Clear all notifications (called on keypress).
    pub fn dismiss_all(&mut self) {
        self.queue.clear();
    }

    /// Return the most recent notification, if any.
    pub fn latest(&self) -> Option<&Notification> {
        self.queue.back()
    }
}

// ---------------------------------------------------------------------------
// Notification panel state
// ---------------------------------------------------------------------------

/// A single row in the notification settings panel.
#[derive(Debug, Clone)]
pub struct NotificationPanelRow {
    /// Project code (e.g. "oo"), or empty string to represent the defaults row.
    pub project: String,
    /// Whether this row's settings come from the defaults (no per-project override).
    pub is_default: bool,
}

/// State for the notification settings panel overlay.
#[derive(Debug)]
pub struct NotificationPanelState {
    pub rows: Vec<NotificationPanelRow>,
    pub selected: usize,
    pub config: nexus_core::config::NotificationConfig,
}

impl NotificationPanelState {
    pub fn load() -> Self {
        let config = nexus_core::config::NotificationConfig::load().unwrap_or_default();
        let mut rows = vec![NotificationPanelRow {
            project: String::new(),
            is_default: false,
        }];
        let mut project_codes: Vec<String> = config.projects.keys().cloned().collect();
        project_codes.sort();
        for code in project_codes {
            rows.push(NotificationPanelRow {
                project: code,
                is_default: false,
            });
        }
        Self {
            rows,
            selected: 0,
            config,
        }
    }

    pub fn selected_rules(&self) -> &nexus_core::config::ProjectNotificationRules {
        let row = &self.rows[self.selected];
        if row.project.is_empty() {
            &self.config.defaults
        } else {
            self.config.rules_for(&row.project)
        }
    }

    pub fn selected_has_override(&self) -> bool {
        let row = &self.rows[self.selected];
        if row.project.is_empty() {
            return false;
        }
        self.config.projects.contains_key(&row.project)
    }

    pub fn cycle_verbosity(&mut self) {
        use nexus_core::config::Verbosity;
        let row = &self.rows[self.selected];
        let rules = if row.project.is_empty() {
            &mut self.config.defaults
        } else {
            let defaults_clone = self.config.defaults.clone();
            self.config
                .projects
                .entry(row.project.clone())
                .or_insert_with(|| defaults_clone)
        };
        rules.verbosity = match rules.verbosity {
            Verbosity::Silent => Verbosity::Brief,
            Verbosity::Brief => Verbosity::Verbose,
            Verbosity::Verbose => Verbosity::Silent,
        };
    }

    pub fn toggle_agents(&mut self) {
        let row = &self.rows[self.selected];
        let defaults_clone = self.config.defaults.clone();
        let rules = if row.project.is_empty() {
            &mut self.config.defaults
        } else {
            self.config
                .projects
                .entry(row.project.clone())
                .or_insert_with(|| defaults_clone)
        };
        rules.announce_agents = !rules.announce_agents;
    }

    pub fn toggle_specs(&mut self) {
        let row = &self.rows[self.selected];
        let defaults_clone = self.config.defaults.clone();
        let rules = if row.project.is_empty() {
            &mut self.config.defaults
        } else {
            self.config
                .projects
                .entry(row.project.clone())
                .or_insert_with(|| defaults_clone)
        };
        rules.announce_specs = !rules.announce_specs;
    }

    pub fn reset_selected_to_default(&mut self) {
        let row = &self.rows[self.selected];
        if row.project.is_empty() {
            return;
        }
        self.config.projects.remove(&row.project.clone());
    }

    pub fn save(&self) -> Result<(), String> {
        self.config.save().map_err(|e| e.to_string())
    }
}
