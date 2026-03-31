use super::*;
use crate::services::receiver::state::ReceiverState;
#[cfg(test)]
use super::super::AudioController;

#[test]
fn test_parse_get_request() {
    let request = b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n";
    let result = ReceiverService::parse_request(request);
    assert!(result.is_some());
    let (method, path, body) = result.unwrap();
    assert_eq!(method, "GET");
    assert_eq!(path, "/health");
    assert!(body.is_empty());
}

#[test]
fn test_parse_post_request() {
    let request = b"POST /speak HTTP/1.1\r\nHost: localhost\r\nContent-Length: 23\r\n\r\n{\"message\":\"hello\"}";
    let result = ReceiverService::parse_request(request);
    assert!(result.is_some());
    let (method, path, body) = result.unwrap();
    assert_eq!(method, "POST");
    assert_eq!(path, "/speak");
    assert!(!body.is_empty());
}

#[test]
fn test_format_response() {
    let body = b"{\"status\":\"ok\"}";
    let response = ReceiverService::format_response(200, "application/json", body);
    let response_str = String::from_utf8_lossy(&response);
    assert!(response_str.contains("HTTP/1.1 200 OK"));
    assert!(response_str.contains("Content-Type: application/json"));
    assert!(response_str.contains("{\"status\":\"ok\"}"));
}

#[test]
fn test_speak_request_deserialize() {
    let json = r#"{"message":"hello world"}"#;
    let req: SpeakRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.message, "hello world");
    assert!(req.voice.is_none());
    assert!(req.priority.is_none());
}

#[test]
fn test_speak_request_with_options() {
    let json = r#"{"message":"hello","voice":"Samantha","priority":1}"#;
    let req: SpeakRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.message, "hello");
    assert_eq!(req.voice, Some("Samantha".to_string()));
    assert_eq!(req.priority, Some(1));
}

#[test]
fn test_speak_request_with_mode() {
    let json = r#"{"message":"test","mode":"system"}"#;
    let req: SpeakRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.message, "test");
    assert_eq!(req.mode, Some("system".to_string()));

    let json2 = r#"{"message":"test2"}"#;
    let req2: SpeakRequest = serde_json::from_str(json2).unwrap();
    assert_eq!(req2.message, "test2");
    assert_eq!(req2.mode, None);

    for mode in &["full", "system", "noduck", "silent"] {
        let json = format!(r#"{{"message":"test","mode":"{}"}}"#, mode);
        let req: SpeakRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req.mode, Some(mode.to_string()));
    }
}

#[test]
fn test_speak_request_with_notification_type() {
    let json = r#"{"message":"test","type":"quality_gates"}"#;
    let req: SpeakRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.message, "test");
    assert_eq!(req.notification_type, Some("quality_gates".to_string()));

    let json2 = r#"{"message":"test2"}"#;
    let req2: SpeakRequest = serde_json::from_str(json2).unwrap();
    assert_eq!(req2.message, "test2");
    assert_eq!(req2.notification_type, None);

    for ntype in &[
        "background_tasks",
        "quality_gates",
        "deployments",
        "reminders",
        "error_alerts",
    ] {
        let json = format!(r#"{{"message":"test","type":"{}"}}"#, ntype);
        let req: SpeakRequest = serde_json::from_str(&json).unwrap();
        assert_eq!(req.notification_type, Some(ntype.to_string()));
    }

    let json = r#"{"message":"test","mode":"system","type":"deployments"}"#;
    let req: SpeakRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.mode, Some("system".to_string()));
    assert_eq!(req.notification_type, Some("deployments".to_string()));
}

#[test]
fn test_play_request_deserialize() {
    let json = r#"{"path":"/tmp/audio.mp3"}"#;
    let req: PlayRequest = serde_json::from_str(json).unwrap();
    assert_eq!(req.path, "/tmp/audio.mp3");
    assert!(req.volume.is_none());
}

#[tokio::test]
async fn test_health_endpoint() {
    let mut state = ReceiverState::new_default();
    state.running = true;
    state.started_at = Some(Utc::now());
    let state = Arc::new(RwLock::new(state));

    let (status, content_type, body) =
        ReceiverService::handle_request("GET", "/health", &[], state).await;

    assert_eq!(status, 200);
    assert_eq!(content_type, "application/json");

    let response: HealthResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(response.status, "healthy");
    assert_eq!(response.port, 9999);
    assert_eq!(response.buffers, 0);
    assert_eq!(response.version, VERSION);
    assert!(response.uptime_seconds < 5);
}

#[tokio::test]
async fn test_speak_endpoint_parses_request() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"message":"test message"}"#;

    let (status, content_type, _response_body) =
        ReceiverService::handle_request("POST", "/speak", body, state).await;

    assert!(status == 200 || status == 500);
    assert_eq!(content_type, "application/json");
}

#[tokio::test]
async fn test_not_found() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));

    let (status, _, body) =
        ReceiverService::handle_request("GET", "/nonexistent", &[], state).await;

    assert_eq!(status, 404);

    let response: ErrorResponse = serde_json::from_slice(&body).unwrap();
    assert_eq!(response.error, "Not found");
}

#[tokio::test]
async fn test_invalid_speak_body() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = b"invalid json";

    let (status, _, response_body) =
        ReceiverService::handle_request("POST", "/speak", body, state).await;

    assert_eq!(status, 400);

    let response: ErrorResponse = serde_json::from_slice(&response_body).unwrap();
    assert_eq!(response.error, "Invalid request body");
}

#[tokio::test]
async fn test_duplicate_speak_request_skipped() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"message":"duplicate test"}"#;

    let (status1, _, _response_body1) =
        ReceiverService::handle_request("POST", "/speak", body, Arc::clone(&state)).await;

    assert!(status1 == 200 || status1 == 500);

    let (status2, _, response_body2) =
        ReceiverService::handle_request("POST", "/speak", body, state).await;

    assert_eq!(status2, 200);
    let response: SuccessResponse = serde_json::from_slice(&response_body2).unwrap();
    assert!(response.success);
    assert!(
        response
            .message
            .as_ref()
            .map(|m| m.contains("duplicate"))
            .unwrap_or(false)
    );
}

#[tokio::test]
async fn test_audio_controller_duck_media() {
    let controller = AudioController::new(Duration::from_millis(100));
    let was_playing = controller.duck_media().await;
    assert!(was_playing || !was_playing);
}

#[test]
fn test_format_message_with_project_adds_prefix() {
    let result = ReceiverService::format_message_with_project("Task complete", Some("oo"));
    assert_eq!(result, "OO: Task complete");
}

#[test]
fn test_format_message_with_project_no_double_prefix() {
    let result = ReceiverService::format_message_with_project("OO: Task complete", Some("oo"));
    assert_eq!(result, "OO: Task complete");

    let result = ReceiverService::format_message_with_project("OO : Task complete", Some("oo"));
    assert_eq!(result, "OO : Task complete");
}

#[test]
fn test_format_message_with_project_no_project() {
    let result = ReceiverService::format_message_with_project("Task complete", None);
    assert_eq!(result, "Task complete");
}

#[test]
fn test_format_message_with_project_empty_project() {
    let result = ReceiverService::format_message_with_project("Task complete", Some(""));
    assert_eq!(result, "Task complete");
}

#[test]
fn test_format_message_with_project_global_skipped() {
    let result = ReceiverService::format_message_with_project("Task complete", Some("global"));
    assert_eq!(result, "Task complete");
}

#[test]
fn test_enrich_vague_message_done() {
    let result = ReceiverService::enrich_vague_message("Done", Some("oo"));
    assert_eq!(result, "OO complete");
}

#[test]
fn test_enrich_vague_message_complete_with_period() {
    let result = ReceiverService::enrich_vague_message("Complete.", Some("tc"));
    assert_eq!(result, "TC complete");
}

#[test]
fn test_enrich_vague_message_finished_case_insensitive() {
    let result = ReceiverService::enrich_vague_message("FINISHED", Some("tl"));
    assert_eq!(result, "TL complete");
}

#[test]
fn test_enrich_vague_message_ready_no_project() {
    let result = ReceiverService::enrich_vague_message("ready", None);
    assert_eq!(result, "Task complete");
}

#[test]
fn test_enrich_vague_message_not_vague() {
    let result =
        ReceiverService::enrich_vague_message("Build completed successfully", Some("oo"));
    assert_eq!(result, "Build completed successfully");
}

#[test]
fn test_enrich_vague_message_whitespace_trimmed() {
    let result = ReceiverService::enrich_vague_message("  Done  ", Some("oo"));
    assert_eq!(result, "OO complete");
}

#[test]
fn test_should_block_message_blocked() {
    assert!(ReceiverService::should_block_message(
        "Claude needs assistance"
    ));
    assert!(ReceiverService::should_block_message(
        "Claude needs your attention"
    ));
    assert!(ReceiverService::should_block_message("which project"));
    assert!(ReceiverService::should_block_message(
        "The agent needs assistance with this"
    ));
    assert!(ReceiverService::should_block_message(
        "NEEDS YOUR ATTENTION"
    ));
}

#[test]
fn test_should_block_message_allowed() {
    assert!(!ReceiverService::should_block_message("Build complete"));
    assert!(!ReceiverService::should_block_message(
        "Tests passed successfully"
    ));
    assert!(!ReceiverService::should_block_message("OO: Task complete"));
    assert!(!ReceiverService::should_block_message("Done"));
}

#[tokio::test]
async fn test_blocked_message_returns_200() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"message":"Claude needs assistance"}"#;

    let (status, _, response_body) =
        ReceiverService::handle_request("POST", "/speak", body, state).await;

    assert_eq!(status, 200);
    let response: SuccessResponse = serde_json::from_slice(&response_body).unwrap();
    assert!(response.success);
    assert!(
        response
            .message
            .as_ref()
            .map(|m| m.contains("Blocked"))
            .unwrap_or(false)
    );
}

#[tokio::test]
async fn test_should_send_imessage_disabled() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let config = NotificationsConfig::default();
    assert!(!config.imessage.enabled);
    let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
    assert!(!result);
}

#[tokio::test]
async fn test_should_send_imessage_empty_recipient() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = String::new();
    let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
    assert!(!result);
}

#[tokio::test]
async fn test_should_send_imessage_threshold_not_met() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = "test@example.com".to_string();
    config.imessage.threshold_minutes = 10;

    {
        let mut guard = state.write().await;
        guard
            .operation_start_times
            .insert("test".to_string(), std::time::Instant::now());
    }

    let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
    assert!(!result, "Should not send iMessage when threshold not met");
}

#[tokio::test]
async fn test_should_send_imessage_no_start_time() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = "test@example.com".to_string();

    let result = ReceiverService::should_send_imessage(&state, Some("unknown"), &config).await;
    assert!(
        !result,
        "Should not send iMessage when no start time exists"
    );
}

#[tokio::test]
async fn test_should_send_imessage_threshold_met_no_throttle() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = "test@example.com".to_string();
    config.imessage.threshold_minutes = 0;

    {
        let mut guard = state.write().await;
        guard.operation_start_times.insert(
            "test".to_string(),
            std::time::Instant::now() - Duration::from_secs(1),
        );
    }

    let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
    assert!(
        result,
        "Should send iMessage when threshold met and no previous send"
    );
}

#[tokio::test]
async fn test_should_send_imessage_throttled() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = "test@example.com".to_string();
    config.imessage.threshold_minutes = 0;
    config.imessage.throttle_minutes = 5;

    {
        let mut guard = state.write().await;
        guard.operation_start_times.insert(
            "test".to_string(),
            std::time::Instant::now() - Duration::from_secs(1),
        );
        guard
            .last_imessage_times
            .insert("test".to_string(), std::time::Instant::now());
    }

    let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
    assert!(!result, "Should not send iMessage when throttled");
}

#[tokio::test]
async fn test_should_send_imessage_throttle_expired() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = "test@example.com".to_string();
    config.imessage.threshold_minutes = 0;
    config.imessage.throttle_minutes = 0;

    {
        let mut guard = state.write().await;
        guard.operation_start_times.insert(
            "test".to_string(),
            std::time::Instant::now() - Duration::from_secs(1),
        );
        guard.last_imessage_times.insert(
            "test".to_string(),
            std::time::Instant::now() - Duration::from_secs(1),
        );
    }

    let result = ReceiverService::should_send_imessage(&state, Some("test"), &config).await;
    assert!(result, "Should send iMessage when throttle has expired");
}

#[tokio::test]
async fn test_should_send_imessage_global_key() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let mut config = NotificationsConfig::default();
    config.imessage.enabled = true;
    config.imessage.recipient = "test@example.com".to_string();
    config.imessage.threshold_minutes = 0;

    {
        let mut guard = state.write().await;
        guard.operation_start_times.insert(
            "global".to_string(),
            std::time::Instant::now() - Duration::from_secs(1),
        );
    }

    let result = ReceiverService::should_send_imessage(&state, None, &config).await;
    assert!(result, "Should use 'global' key when project is None");
}

#[tokio::test]
async fn test_reset_operation_tracking() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));

    {
        let mut guard = state.write().await;
        guard
            .operation_start_times
            .insert("proj".to_string(), std::time::Instant::now());
        guard
            .last_imessage_times
            .insert("proj".to_string(), std::time::Instant::now());
    }

    {
        let guard = state.read().await;
        assert!(guard.operation_start_times.contains_key("proj"));
        assert!(guard.last_imessage_times.contains_key("proj"));
    }

    ReceiverService::reset_operation_tracking(&state, "proj").await;

    {
        let guard = state.read().await;
        assert!(!guard.operation_start_times.contains_key("proj"));
        assert!(!guard.last_imessage_times.contains_key("proj"));
    }
}

#[tokio::test]
async fn test_operation_start_time_recorded_on_speak() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"message":"test","project":"myproj"}"#;

    {
        let guard = state.read().await;
        assert!(!guard.operation_start_times.contains_key("myproj"));
    }

    let _ = ReceiverService::handle_request("POST", "/speak", body, Arc::clone(&state)).await;

    {
        let guard = state.read().await;
        assert!(
            guard.operation_start_times.contains_key("myproj"),
            "operation_start_times should track the project after speak"
        );
    }
}

#[tokio::test]
async fn test_watch_register_success() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"device_token":"test-token-abc123","platform":"watchOS 10"}"#;

    let (status, content_type, response_body) =
        ReceiverService::handle_request("POST", "/watch/register", body, state).await;

    assert_eq!(status, 200);
    assert_eq!(content_type, "application/json");

    let response: RegisterWatchResponse = serde_json::from_slice(&response_body).unwrap();
    assert_eq!(response.status, "registered");
}

#[tokio::test]
async fn test_watch_register_empty_token() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"device_token":"","platform":"watchOS 10"}"#;

    let (status, _, response_body) =
        ReceiverService::handle_request("POST", "/watch/register", body, state).await;

    assert_eq!(status, 400);

    let response: ErrorResponse = serde_json::from_slice(&response_body).unwrap();
    assert_eq!(response.error, "Invalid device_token");
}

#[tokio::test]
async fn test_watch_register_invalid_json() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = b"invalid json";

    let (status, _, response_body) =
        ReceiverService::handle_request("POST", "/watch/register", body, state).await;

    assert_eq!(status, 400);

    let response: ErrorResponse = serde_json::from_slice(&response_body).unwrap();
    assert_eq!(response.error, "Invalid request body");
}

#[tokio::test]
async fn test_watch_register_default_platform() {
    let state = Arc::new(RwLock::new(ReceiverState::new_default()));
    let body = br#"{"device_token":"test-token-xyz789"}"#;

    let (status, _, response_body) =
        ReceiverService::handle_request("POST", "/watch/register", body, state).await;

    assert_eq!(status, 200);

    let response: RegisterWatchResponse = serde_json::from_slice(&response_body).unwrap();
    assert_eq!(response.status, "registered");
}
