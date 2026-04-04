//! Axum HTTP handler functions and associated request/response types.
//!
//! All axum handlers that were previously inline in `main.rs` live here.
//! The `AppState` struct (shared state injected by axum) and its supporting
//! types are also defined here so `main.rs` only needs to import from this
//! module.

mod agent;
mod analytics;
mod command_write;
mod commands;
mod credentials;
mod cron;
mod discovered_projects;
mod environment;
mod events;
mod failures;
mod health;
mod hooks;
mod projects;
mod recommend;
mod session_start;
mod specs;
mod statusline;

use std::sync::Arc;

use nexus_core::project_registry::ProjectRegistry;

use crate::cron_state::CronState;
use crate::environment::EnvironmentCache;
use crate::failures::FailureBuffer;
use crate::health::HealthCollector;
use crate::registry::SessionRegistry;
use crate::services::command_registry::CommandRegistry;
use crate::services::credential_pool::CredentialPool;
use crate::services::project_status::ProjectStatusCache;

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

/// Shared state passed to axum HTTP handlers via `State<AppState>`.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<SessionRegistry>,
    pub health: HealthCollector,
    pub environment_cache: Arc<EnvironmentCache>,
    pub failure_buffer: FailureBuffer,
    pub cron_state: CronState,
    pub agent_name: String,
    pub agent_host: String,
    pub started_at: std::time::Instant,
    pub project_registry: ProjectRegistry,
    pub status_cache: ProjectStatusCache,
    pub command_registry: CommandRegistry,
    /// Shared secret for authenticating sensitive endpoints.
    /// `None` means no auth required (backward compat).
    pub secret: Option<String>,
    /// Shared HTTP client for outbound requests (avoids per-request connection
    /// pool overhead).
    pub http_client: reqwest::Client,
    /// Credential pool for OAuth credential rotation (shared with socket handler).
    pub credential_pool: Arc<CredentialPool>,
    /// SQLite backing store for spec governance, events, and queries.
    pub db: Arc<nexus_core::db::NexusDb>,
    /// Base directory where projects live (from NEXUS_PROJECTS_DIR, default ~/dev).
    pub projects_dir: String,
}

// ---------------------------------------------------------------------------
// Re-exports — handler functions
// ---------------------------------------------------------------------------

pub use agent::agent_self_handler;
pub use analytics::{
    analytics_credentials_handler, analytics_cron_handler, analytics_git_handler,
    analytics_health_handler, analytics_lifecycle_handler, analytics_specs_handler,
};
pub use command_write::{update_command_handler, UpdateCommandBody};
pub use commands::{
    list_commands_by_namespace_handler, list_commands_handler, run_command_handler, validate_secret,
};
pub use credentials::credentials_handler;
pub use discovered_projects::discovered_projects_handler;
pub use cron::cron_handler;
pub use environment::environment_handler;
pub use events::events_handler;
pub use failures::failures_handler;
pub use health::health_handler;
pub use hooks::hooks_handler;
pub use projects::{
    project_beads_handler, project_git_handler, project_specs_handler, project_status_handler,
};
pub use recommend::recommend_handler;
pub use session_start::{session_start_handler, SessionStartBody};
pub use specs::{
    approve_spec_handler, get_spec_handler, list_specs_handler, read_spec_handler,
    reject_spec_handler, spec_status_handler, specs_all_handler,
};
pub use statusline::statusline_handler;

// ---------------------------------------------------------------------------
// Re-exports — response / request types
// ---------------------------------------------------------------------------

pub use analytics::{AnalyticsCredentialsResponse, AnalyticsSpecsResponse};
pub use commands::{ListCommandsQuery, RunCommandBody};
pub use credentials::{AccountStatus, CredentialsResponse, SwapInfo, WindowStatus};
pub use events::EventsQuery;
pub use failures::FailuresParams;
pub use health::HealthResponse;
pub use hooks::{HookEventPayload, HookResponse};
pub use projects::ProjectStatusQuery;
pub use specs::{
    AllSpecsResponse, BeadsSummary, ListSpecsQuery, ProjectSpecStatus, RejectBody,
    SpecStatusResponse,
};
pub use statusline::{StatuslineGit, StatuslineMachine, StatuslineResponse, StatuslineSession};

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{HeaderMap, StatusCode};

    #[test]
    fn no_secret_configured_allows_all_requests() {
        let secret: Option<String> = None;
        let headers = HeaderMap::new();
        assert!(validate_secret(&secret, &headers).is_ok());
    }

    #[test]
    fn secret_configured_rejects_missing_header() {
        let secret = Some("my-secret".to_string());
        let headers = HeaderMap::new();
        let err = validate_secret(&secret, &headers).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn secret_configured_rejects_wrong_header() {
        let secret = Some("my-secret".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("x-nexus-secret", "wrong-secret".parse().unwrap());
        let err = validate_secret(&secret, &headers).unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
    }

    #[test]
    fn secret_configured_accepts_valid_header() {
        let secret = Some("my-secret".to_string());
        let mut headers = HeaderMap::new();
        headers.insert("x-nexus-secret", "my-secret".parse().unwrap());
        assert!(validate_secret(&secret, &headers).is_ok());
    }

    #[test]
    fn credentials_response_no_sensitive_fields() {
        let resp = CredentialsResponse {
            active_account: None,
            accounts: vec![],
            swap: SwapInfo {
                debounce_active: false,
                last_swap_account: None,
            },
        };
        let json = serde_json::to_value(&resp).unwrap();

        // Must not contain access_token or path fields
        let json_str = serde_json::to_string(&json).unwrap();
        assert!(!json_str.contains("access_token"));
        assert!(!json_str.contains("\"path\""));
    }

    #[test]
    fn credentials_response_empty_pool() {
        let resp = CredentialsResponse {
            active_account: None,
            accounts: vec![],
            swap: SwapInfo {
                debounce_active: false,
                last_swap_account: None,
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["active_account"], serde_json::Value::Null);
        assert_eq!(json["accounts"], serde_json::json!([]));
    }

    #[test]
    fn hook_payload_session_start_deserializes() {
        let json = r#"{
            "hook_event_name": "session_start",
            "session_id": "sess-123",
            "project": "nx",
            "cwd": "/home/user/dev/nx",
            "model": "opus",
            "pid": 12345
        }"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.hook_event_name.as_deref(), Some("session_start"));
        assert_eq!(payload.session_id.as_deref(), Some("sess-123"));
        assert_eq!(payload.project.as_deref(), Some("nx"));
        assert_eq!(payload.pid, Some(12345));
    }

    #[test]
    fn hook_payload_stop_failure_deserializes() {
        let json = r#"{
            "event": "stop_failure",
            "session_id": "sess-456",
            "reason": "process crashed"
        }"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.event.as_deref(), Some("stop_failure"));
        assert_eq!(payload.session_id.as_deref(), Some("sess-456"));
        assert_eq!(payload.reason.as_deref(), Some("process crashed"));
    }

    #[test]
    fn hook_payload_session_summary_deserializes() {
        let json = r#"{
            "hook_event_name": "session_summary",
            "session_id": "sess-789",
            "project": "oo",
            "tool_counts": {"Read": 5, "Write": 3},
            "failure_count": 1,
            "compaction_count": 0,
            "agent_spawns": 2,
            "duration_ms": 120000,
            "model": "opus"
        }"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.hook_event_name.as_deref(), Some("session_summary"));
        let tc = payload.tool_counts.as_ref().unwrap();
        assert_eq!(*tc.get("Read").unwrap(), 5);
        assert_eq!(*tc.get("Write").unwrap(), 3);
        assert_eq!(payload.failure_count, Some(1));
        assert_eq!(payload.agent_spawns, Some(2));
        assert_eq!(payload.duration_ms, Some(120000));
    }

    #[test]
    fn hook_payload_malformed_json_fails() {
        let json = "not json at all";
        let result = serde_json::from_str::<HookEventPayload>(json);
        assert!(result.is_err());
    }

    #[test]
    fn hook_payload_unknown_event_deserializes() {
        let json = r#"{"event": "some_future_event", "session_id": "x"}"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert_eq!(payload.event.as_deref(), Some("some_future_event"));
    }

    #[test]
    fn hook_payload_fallback_discriminant() {
        // When hook_event_name is absent, event is used
        let json = r#"{"event": "session_start", "session_id": "x"}"#;
        let payload: HookEventPayload = serde_json::from_str(json).unwrap();
        assert!(payload.hook_event_name.is_none());
        assert_eq!(payload.event.as_deref(), Some("session_start"));
    }

    #[test]
    fn credentials_response_with_accounts() {
        let resp = CredentialsResponse {
            active_account: Some("personal".to_string()),
            accounts: vec![AccountStatus {
                name: "personal".to_string(),
                expired: false,
                five_hour: Some(WindowStatus {
                    utilization: 0.45,
                    resets_in_minutes: 120.5,
                }),
                seven_day: Some(WindowStatus {
                    utilization: 0.72,
                    resets_in_minutes: 4320.0,
                }),
                seconds_since_polled: Some(30),
            }],
            swap: SwapInfo {
                debounce_active: true,
                last_swap_account: Some("work".to_string()),
            },
        };
        let json = serde_json::to_value(&resp).unwrap();
        assert_eq!(json["active_account"], "personal");
        assert_eq!(json["accounts"].as_array().unwrap().len(), 1);
        assert_eq!(json["accounts"][0]["name"], "personal");
        assert!(!json["accounts"][0]["expired"].as_bool().unwrap());
        assert!(json["swap"]["debounce_active"].as_bool().unwrap());

        // Verify no sensitive data leakage
        let s = serde_json::to_string(&json).unwrap();
        assert!(!s.contains("access_token"));
        assert!(!s.contains("\"path\""));
    }

    #[test]
    fn all_specs_response_shape() {
        let resp = AllSpecsResponse {
            projects: vec![
                ProjectSpecStatus {
                    code: "oo".to_string(),
                    name: "Otaku Odyssey".to_string(),
                    specs: vec![nexus_core::project_registry::SpecSnapshot {
                        name: "add-feature".to_string(),
                        status: "active".to_string(),
                        completed_tasks: 3,
                        total_tasks: 10,
                        last_modified: None,
                    }],
                    beads: Some(BeadsSummary {
                        open: 5,
                        closed: 2,
                        ready: 3,
                    }),
                },
                ProjectSpecStatus {
                    code: "nx".to_string(),
                    name: "Nexus".to_string(),
                    specs: vec![],
                    beads: None,
                },
            ],
        };
        let json = serde_json::to_value(&resp).unwrap();
        let projects = json["projects"].as_array().unwrap();
        assert_eq!(projects.len(), 2);
        assert_eq!(projects[0]["code"], "oo");
        assert_eq!(projects[0]["specs"].as_array().unwrap().len(), 1);
        assert_eq!(projects[0]["specs"][0]["name"], "add-feature");
        assert_eq!(projects[0]["beads"]["open"], 5);
        assert_eq!(projects[0]["beads"]["ready"], 3);
        assert_eq!(projects[1]["code"], "nx");
        assert!(projects[1]["specs"].as_array().unwrap().is_empty());
        assert!(projects[1]["beads"].is_null());
    }
}
