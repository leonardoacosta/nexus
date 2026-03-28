//! NotificationEngine — processes `LifecycleEvent` values, applies per-project rules
//! from `NotificationConfig`, constructs human-readable TTS messages, and delivers
//! them via `ReceiverService::speak_from_socket`.
//!
//! Message format rules:
//!
//! - **Verbose**: `"<PROJECT> — <agent_type> done, <done>/<total> tasks, <Xs>"`
//!   e.g. `"OO — UI engineer done, 3/5 tasks, 45s"`
//! - **Brief**: `"<PROJECT> spec done"`, `"<PROJECT> session started"`, etc.
//! - **Error**: always announced regardless of verbosity or announce_* gates,
//!   using the error message as-is prefixed with the project name if known.
//!
//! The engine is intentionally stateless — all context needed for a message is
//! carried in the `LifecycleEvent` itself.
//!
//! ## Hot-reload
//!
//! Call `spawn_config_watcher` after constructing the engine to watch
//! `~/.config/nexus/notifications.toml` for changes. On modify/create events
//! the config is reloaded and swapped atomically via the shared `Arc<RwLock>`.
//! A 100 ms debounce prevents redundant reloads from editor write flushes.

use std::sync::Arc;
use std::time::Duration;

use notify::{EventKind, RecursiveMode, Watcher};
use nexus_core::config::{NotificationConfig, Verbosity};
use nexus_core::lifecycle::{LifecycleEvent, LifecycleEventKind};
use tokio::sync::{RwLock, mpsc};
use tracing::debug;

use crate::services::receiver::ReceiverService;

/// Spawn a background task that watches `notifications.toml` for modifications
/// and atomically swaps the shared config on reload.
///
/// The watcher stays alive as long as the returned task is running. A 100 ms
/// debounce window coalesces rapid successive writes (e.g. editor flush + fsync).
pub fn spawn_config_watcher(config: Arc<RwLock<NotificationConfig>>) {
    let config_path = NotificationConfig::config_path();

    // Bridge: notify fires on an OS thread; we forward a unit signal into a
    // tokio channel to do the actual reload inside an async context.
    let (notify_tx, mut notify_rx) = mpsc::channel::<()>(1);

    let mut watcher =
        match notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(ev) = res {
                if matches!(ev.kind, EventKind::Modify(_) | EventKind::Create(_)) {
                    // Best-effort send; duplicate events during the debounce
                    // window are dropped intentionally.
                    let _ = notify_tx.try_send(());
                }
            }
        }) {
            Ok(w) => w,
            Err(e) => {
                tracing::warn!("notification_engine: failed to create config watcher: {e}");
                return;
            }
        };

    if let Err(e) = watcher.watch(&config_path, RecursiveMode::NonRecursive) {
        tracing::warn!(
            path = %config_path.display(),
            "notification_engine: failed to watch notifications.toml: {e}"
        );
        return;
    }

    tokio::spawn(async move {
        // Keep the watcher alive inside the task.
        let _watcher = watcher;

        loop {
            // Wait for the next raw filesystem event.
            if notify_rx.recv().await.is_none() {
                break;
            }

            // Debounce: drain any additional events within 100 ms.
            let debounce = tokio::time::sleep(Duration::from_millis(100));
            tokio::pin!(debounce);
            loop {
                tokio::select! {
                    _ = &mut debounce => break,
                    extra = notify_rx.recv() => {
                        if extra.is_none() {
                            return;
                        }
                        debounce.as_mut().reset(
                            tokio::time::Instant::now() + Duration::from_millis(100),
                        );
                    }
                }
            }

            // Reload outside the lock to avoid holding it during I/O.
            // We evaluate the result before any `.await` so the non-Send
            // Box<dyn Error> is not held across the await point.
            let reload_result: Result<NotificationConfig, String> =
                NotificationConfig::load().map_err(|e| e.to_string());
            match reload_result {
                Ok(new_config) => {
                    let mut cfg = config.write().await;
                    *cfg = new_config;
                    tracing::info!("notification_engine: notifications.toml reloaded");
                }
                Err(e) => {
                    tracing::warn!("notification_engine: reload failed: {e}");
                }
            }
        }
    });
}

/// A constructed notification ready for delivery.
struct Notification {
    message: String,
    message_type: String,
    channels: Vec<String>,
}

/// Receives `LifecycleEvent` values from a channel and delivers TTS notifications.
pub struct NotificationEngine {
    config: Arc<RwLock<NotificationConfig>>,
    receiver: Arc<ReceiverService>,
}

impl NotificationEngine {
    /// Create a new engine backed by the given config and receiver.
    pub fn new(config: Arc<RwLock<NotificationConfig>>, receiver: Arc<ReceiverService>) -> Self {
        Self { config, receiver }
    }

    /// Spawn a background task that drains `rx` and processes each event.
    pub fn spawn(self, mut rx: mpsc::Receiver<LifecycleEvent>) {
        tokio::spawn(async move {
            while let Some(event) = rx.recv().await {
                self.process(&event).await;
            }
            tracing::info!("notification_engine: channel closed, stopping");
        });
    }

    /// Process a single lifecycle event: apply rules, build message, deliver.
    pub async fn process(&self, event: &LifecycleEvent) {
        let config = self.config.read().await;
        let rules = config.rules_for(&event.project);

        // Errors always fire regardless of other settings.
        if let LifecycleEventKind::Error { ref message, .. } = event.kind {
            if rules.announce_errors {
                let prefix = if event.project.is_empty() {
                    String::new()
                } else {
                    format!("{} — ", event.project.to_uppercase())
                };
                let full_message = format!("{}Error: {}", prefix, message);
                self.deliver(Notification {
                    message: full_message,
                    message_type: "brief".to_string(),
                    channels: rules.channels.clone(),
                })
                .await;
            }
            return;
        }

        // Silent verbosity suppresses everything except errors (handled above).
        if rules.verbosity == Verbosity::Silent {
            debug!(
                project = %event.project,
                source = %event.source_agent,
                "notification_engine: project is silent, suppressing"
            );
            return;
        }

        let notification = match &event.kind {
            LifecycleEventKind::SessionStart { .. } => {
                if !rules.announce_sessions {
                    return;
                }
                build_session_start_message(event, rules.verbosity)
            }
            LifecycleEventKind::SessionStop { .. } => {
                if !rules.announce_sessions {
                    return;
                }
                build_session_stop_message(event, rules.verbosity)
            }
            LifecycleEventKind::AgentSpawn { .. } => {
                if !rules.announce_agents {
                    return;
                }
                build_agent_spawn_message(event, rules.verbosity)
            }
            LifecycleEventKind::AgentComplete { .. } => {
                if !rules.announce_agents {
                    return;
                }
                build_agent_complete_message(event, rules.verbosity)
            }
            LifecycleEventKind::SpecComplete { .. } => {
                if !rules.announce_specs {
                    return;
                }
                build_spec_complete_message(event, rules.verbosity)
            }
            LifecycleEventKind::Notification {
                message,
                channels,
                message_type,
            } => {
                // Raw notification passthrough — deliver as-is.
                Notification {
                    message: message.clone(),
                    message_type: message_type.clone(),
                    channels: channels.clone(),
                }
            }
            LifecycleEventKind::Error { .. } => unreachable!("handled above"),
        };

        // Override channels with per-project rules unless the event carries its own.
        let notification = if let LifecycleEventKind::Notification { .. } = event.kind {
            notification
        } else {
            Notification {
                channels: rules.channels.clone(),
                ..notification
            }
        };

        self.deliver(notification).await;
    }

    async fn deliver(&self, notification: Notification) {
        let channels: Vec<String> = notification.channels;
        let ch_refs: Option<&[String]> = if channels.is_empty() {
            None
        } else {
            Some(&channels)
        };
        tracing::info!(
            message = %notification.message,
            message_type = %notification.message_type,
            channels = ?ch_refs,
            "notification_engine: delivering"
        );
        self.receiver
            .speak_from_socket(
                &notification.message,
                Some(&notification.message_type),
                ch_refs,
            )
            .await;
    }
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

fn project_prefix(event: &LifecycleEvent) -> String {
    if event.project.is_empty() {
        format!("{} — ", event.source_agent.to_uppercase())
    } else {
        format!("{} — ", event.project.to_uppercase())
    }
}

fn build_session_start_message(event: &LifecycleEvent, verbosity: Verbosity) -> Notification {
    let prefix = project_prefix(event);
    let message = match verbosity {
        Verbosity::Verbose => {
            if let LifecycleEventKind::SessionStart { ref model, .. } = event.kind {
                let model_str = model
                    .as_deref()
                    .map(|m| format!(", {}", m))
                    .unwrap_or_default();
                format!("{}session started{}", prefix, model_str)
            } else {
                format!("{}session started", prefix)
            }
        }
        _ => format!("{}session started", prefix),
    };
    Notification {
        message,
        message_type: "brief".to_string(),
        channels: vec![],
    }
}

fn build_session_stop_message(event: &LifecycleEvent, verbosity: Verbosity) -> Notification {
    let prefix = project_prefix(event);
    let message = match verbosity {
        Verbosity::Verbose => {
            if let LifecycleEventKind::SessionStop { duration_s, .. } = event.kind {
                if duration_s > 0 {
                    format!("{}session ended, {}s", prefix, duration_s)
                } else {
                    format!("{}session ended", prefix)
                }
            } else {
                format!("{}session ended", prefix)
            }
        }
        _ => format!("{}session ended", prefix),
    };
    Notification {
        message,
        message_type: "brief".to_string(),
        channels: vec![],
    }
}

fn build_agent_spawn_message(event: &LifecycleEvent, verbosity: Verbosity) -> Notification {
    let prefix = project_prefix(event);
    let message = match verbosity {
        Verbosity::Verbose => {
            if let LifecycleEventKind::AgentSpawn {
                ref agent_type,
                ref model,
            } = event.kind
            {
                let agent_readable = readable_agent_type(agent_type);
                let model_str = model
                    .as_deref()
                    .map(|m| format!(", {}", m))
                    .unwrap_or_default();
                format!("{}{} starting{}", prefix, agent_readable, model_str)
            } else {
                format!("{}agent starting", prefix)
            }
        }
        _ => format!("{}agent starting", prefix),
    };
    Notification {
        message,
        message_type: "brief".to_string(),
        channels: vec![],
    }
}

fn build_agent_complete_message(event: &LifecycleEvent, verbosity: Verbosity) -> Notification {
    let prefix = project_prefix(event);
    let message = match verbosity {
        Verbosity::Verbose => {
            if let LifecycleEventKind::AgentComplete {
                ref agent_type,
                duration_ms,
                tasks_done,
                tasks_total,
            } = event.kind
            {
                let agent_readable = readable_agent_type(agent_type);
                let duration_s = duration_ms / 1000;
                if tasks_total > 0 {
                    format!(
                        "{}{} done, {}/{} tasks, {}s",
                        prefix, agent_readable, tasks_done, tasks_total, duration_s
                    )
                } else if duration_s > 0 {
                    format!("{}{} done, {}s", prefix, agent_readable, duration_s)
                } else {
                    format!("{}{} done", prefix, agent_readable)
                }
            } else {
                format!("{}agent done", prefix)
            }
        }
        _ => {
            if let LifecycleEventKind::AgentComplete { ref agent_type, .. } = event.kind {
                let agent_readable = readable_agent_type(agent_type);
                format!("{}{} done", prefix, agent_readable)
            } else {
                format!("{}agent done", prefix)
            }
        }
    };
    Notification {
        message,
        message_type: "brief".to_string(),
        channels: vec![],
    }
}

fn build_spec_complete_message(event: &LifecycleEvent, verbosity: Verbosity) -> Notification {
    let prefix = project_prefix(event);
    let message = match verbosity {
        Verbosity::Verbose => {
            if let LifecycleEventKind::SpecComplete {
                ref spec_name,
                tasks_total,
            } = event.kind
            {
                if tasks_total > 0 {
                    format!("{}{} complete, {} tasks", prefix, spec_name, tasks_total)
                } else {
                    format!("{}{} complete", prefix, spec_name)
                }
            } else {
                format!("{}spec complete", prefix)
            }
        }
        _ => {
            if let LifecycleEventKind::SpecComplete { ref spec_name, .. } = event.kind {
                format!("{}{} done", prefix, spec_name)
            } else {
                format!("{}spec done", prefix)
            }
        }
    };
    Notification {
        message,
        message_type: "brief".to_string(),
        channels: vec![],
    }
}

/// Convert a raw agent_type string to a human-readable form.
///
/// E.g. "ui-engineer" → "UI engineer", "db-analyst" → "DB analyst"
fn readable_agent_type(agent_type: &str) -> String {
    let parts: Vec<&str> = agent_type.split('-').collect();
    if parts.is_empty() {
        return agent_type.to_string();
    }

    // Capitalise known acronym prefixes.
    let first = match parts[0].to_lowercase().as_str() {
        "ui" => "UI".to_string(),
        "db" => "DB".to_string(),
        "api" => "API".to_string(),
        "ux" => "UX".to_string(),
        other => {
            let mut s = other.to_string();
            if let Some(c) = s.get_mut(0..1) {
                c.make_ascii_uppercase();
            }
            s
        }
    };

    if parts.len() == 1 {
        return first;
    }

    let rest: String = parts[1..].join(" ");
    format!("{} {}", first, rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use nexus_core::lifecycle::LifecycleEvent;

    #[test]
    fn test_readable_agent_type() {
        assert_eq!(readable_agent_type("ui-engineer"), "UI engineer");
        assert_eq!(readable_agent_type("db-analyst"), "DB analyst");
        assert_eq!(readable_agent_type("api-engineer"), "API engineer");
        assert_eq!(readable_agent_type("backend-engineer"), "Backend engineer");
        assert_eq!(readable_agent_type("test-writer"), "Test writer");
    }

    #[test]
    fn test_build_agent_complete_verbose() {
        let ev = LifecycleEvent::agent_complete("macbook", "oo", "ui-engineer", 45000, 3, 5);
        let n = build_agent_complete_message(&ev, Verbosity::Verbose);
        assert_eq!(n.message, "OO — UI engineer done, 3/5 tasks, 45s");
    }

    #[test]
    fn test_build_agent_complete_brief() {
        let ev = LifecycleEvent::agent_complete("macbook", "oo", "ui-engineer", 45000, 3, 5);
        let n = build_agent_complete_message(&ev, Verbosity::Brief);
        assert_eq!(n.message, "OO — UI engineer done");
    }

    #[test]
    fn test_build_spec_complete_brief() {
        let ev = LifecycleEvent::spec_complete("homelab", "tl", "add-invoice-export", 8);
        let n = build_spec_complete_message(&ev, Verbosity::Brief);
        assert_eq!(n.message, "TL — add-invoice-export done");
    }

    #[test]
    fn test_build_spec_complete_verbose() {
        let ev = LifecycleEvent::spec_complete("homelab", "tl", "add-invoice-export", 8);
        let n = build_spec_complete_message(&ev, Verbosity::Verbose);
        assert_eq!(n.message, "TL — add-invoice-export complete, 8 tasks");
    }
}
