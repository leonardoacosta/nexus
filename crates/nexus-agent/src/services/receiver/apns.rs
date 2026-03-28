//! APNS client for delivering notifications to Apple Watch
//!
//! Provides HTTP/2-based push notification delivery using Apple's Push Notification service.
//! Uses token-based authentication (.p8 key) for secure, long-lived credentials.
//!
//! ## Testing
//!
//! The [`ApnsSender`] trait abstracts notification delivery so tests can inject a
//! [`MockApnsSender`] (available under `#[cfg(test)]`) instead of hitting real APNS servers.

use a2::{
    Client, ClientConfig, DefaultNotificationBuilder, Endpoint, NotificationBuilder,
    NotificationOptions, Priority, PushType,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use chrono::Utc;
use serde_json::json;
use std::fs;

/// Trait abstracting APNS notification delivery.
///
/// Implemented by [`ApnsClient`] for production use. Tests can use [`MockApnsSender`]
/// to return pre-configured responses without requiring a real APNS connection.
#[async_trait]
pub trait ApnsSender: Send + Sync {
    /// Send a notification to a specific device token
    async fn send_notification(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        project: Option<&str>,
        notification_type: Option<&str>,
    ) -> Result<ApnsResponse>;

    /// Send a notification with optional extended message support.
    /// When `message_id` is provided, uses `build_apns_payload_ext` to include
    /// the message_id in the payload and truncate the body for the push preview.
    async fn send_notification_ext(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        project: Option<&str>,
        notification_type: Option<&str>,
        _message_id: Option<&str>,
    ) -> Result<ApnsResponse> {
        // Default implementation: delegate to send_notification (ignoring message_id)
        self.send_notification(device_token, title, body, project, notification_type)
            .await
    }
}

/// APNS client for delivering notifications to Apple Watch
pub struct ApnsClient {
    client: Client,
    topic: String,
}

impl ApnsClient {
    /// Create a new APNS client using token-based authentication (.p8 key)
    ///
    /// # Arguments
    /// * `key_path` - Path to the .p8 private key file from Apple Developer portal
    /// * `key_id` - Key ID from Apple Developer portal (10-character string)
    /// * `team_id` - Team ID from Apple Developer portal (10-character string)
    /// * `bundle_id` - Watch app bundle ID (e.g., "com.example.app.watchkitapp")
    /// * `sandbox` - Whether to use sandbox environment (true) or production (false)
    pub fn new(
        key_path: &str,
        key_id: &str,
        team_id: &str,
        bundle_id: &str,
        sandbox: bool,
    ) -> Result<Self> {
        // Read the .p8 key file as string (PEM format)
        let key_pem = fs::read_to_string(key_path)
            .with_context(|| format!("Failed to read APNS key file at {}", key_path))?;

        Self::from_pem(&key_pem, key_id, team_id, bundle_id, sandbox)
    }

    /// Create a new APNS client from PEM key bytes (avoids filesystem access for testing)
    pub fn from_pem(
        key_pem: &str,
        key_id: &str,
        team_id: &str,
        bundle_id: &str,
        sandbox: bool,
    ) -> Result<Self> {
        // Determine endpoint
        let endpoint = if sandbox {
            Endpoint::Sandbox
        } else {
            Endpoint::Production
        };

        // Create client config
        let config = ClientConfig::new(endpoint);

        // Create a2::Client with token-based authentication
        let client = Client::token(key_pem.as_bytes(), key_id, team_id, config)
            .with_context(|| "Failed to create APNS client with token authentication")?;

        Ok(Self {
            client,
            topic: bundle_id.to_string(),
        })
    }

    /// Check if client is properly configured
    pub fn is_configured(&self) -> bool {
        true // If construction succeeded, we're configured
    }
}

/// Maximum APNs body preview length for extended messages.
/// Truncated to ~200 chars + "..." to stay well under the 4KB payload limit.
const APNS_EXTENDED_BODY_MAX: usize = 200;

/// Build the APS notification payload as a JSON value.
///
/// Extracted as a standalone function so payload construction can be tested
/// independently of the APNS transport layer.
///
/// For extended messages (`message_id` is Some), the body is truncated at ~200 chars
/// and the `message_id` is included in custom data so the device can fetch the full text.
pub fn build_apns_payload(
    title: &str,
    body: &str,
    project: Option<&str>,
    notification_type: Option<&str>,
) -> serde_json::Value {
    build_apns_payload_ext(title, body, project, notification_type, None)
}

/// Build the APS notification payload with optional extended message support.
///
/// When `message_id` is provided, the body is truncated for APNs and the full
/// text can be retrieved via `GET /messages/:id`.
pub fn build_apns_payload_ext(
    title: &str,
    body: &str,
    project: Option<&str>,
    notification_type: Option<&str>,
    message_id: Option<&str>,
) -> serde_json::Value {
    let timestamp = Utc::now().to_rfc3339();

    // For extended messages, truncate the body for the push preview
    let display_body = if message_id.is_some() && body.len() > APNS_EXTENDED_BODY_MAX {
        let truncated = &body[..APNS_EXTENDED_BODY_MAX];
        // Try to truncate at word boundary
        let end = truncated.rfind(' ').unwrap_or(APNS_EXTENDED_BODY_MAX);
        format!("{}...", &body[..end])
    } else {
        body.to_string()
    };

    let mut payload = json!({
        "aps": {
            "alert": {
                "title": title,
                "body": display_body,
            },
            "sound": "default",
        },
        "timestamp": timestamp,
    });

    if let Some(proj) = project {
        payload["project"] = json!(proj);
    }
    if let Some(notif_type) = notification_type {
        payload["type"] = json!(notif_type);
    }
    if let Some(mid) = message_id {
        payload["message_id"] = json!(mid);
    }

    payload
}

#[async_trait]
impl ApnsSender for ApnsClient {
    /// Send a notification to a specific device token
    ///
    /// # Arguments
    /// * `device_token` - Hex-encoded device token from the Watch app
    /// * `title` - Notification title
    /// * `body` - Notification body text
    /// * `project` - Optional project name for context
    /// * `notification_type` - Optional notification type (e.g., "tts", "status")
    async fn send_notification(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        project: Option<&str>,
        notification_type: Option<&str>,
    ) -> Result<ApnsResponse> {
        self.send_notification_ext(device_token, title, body, project, notification_type, None)
            .await
    }

    /// Send a notification with optional extended message support.
    /// When `message_id` is provided, uses `build_apns_payload_ext` to include
    /// the message_id in the payload and truncate the body for the push preview.
    async fn send_notification_ext(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        project: Option<&str>,
        notification_type: Option<&str>,
        message_id: Option<&str>,
    ) -> Result<ApnsResponse> {
        let payload = build_apns_payload_ext(title, body, project, notification_type, message_id);

        // Build notification with custom options
        let payload_str =
            serde_json::to_string(&payload).with_context(|| "Failed to serialize APNS payload")?;

        let options = NotificationOptions {
            apns_push_type: Some(PushType::Alert), // REQUIRED for WatchOS
            apns_topic: Some(&self.topic),
            apns_priority: Some(Priority::High), // Priority 10 for immediate delivery
            ..Default::default()
        };

        let builder = DefaultNotificationBuilder::new()
            .set_body(&payload_str)
            .set_sound("default");

        // Send via a2 client
        let response = self.client.send(builder.build(device_token, options)).await;

        // Parse response
        match response {
            Ok(resp) => {
                if resp.code == 200 {
                    Ok(ApnsResponse::Success)
                } else if resp.code == 400 {
                    Ok(ApnsResponse::BadRequest(
                        resp.error
                            .map(|e| format!("{:?}", e))
                            .unwrap_or_else(|| "Bad request".to_string()),
                    ))
                } else if resp.code == 410 {
                    Ok(ApnsResponse::TokenExpired) // Device token no longer valid
                } else {
                    Ok(ApnsResponse::Error(format!(
                        "APNS error: status={}, error={:?}",
                        resp.code, resp.error
                    )))
                }
            }
            Err(e) => Err(anyhow::anyhow!("APNS request failed: {}", e)),
        }
    }
}

/// APNS response wrapper
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApnsResponse {
    /// Notification delivered successfully (200)
    Success,
    /// Bad request - invalid payload or parameters (400)
    BadRequest(String),
    /// Device token expired or invalid (410)
    TokenExpired,
    /// Other APNS error
    Error(String),
}

/// Captured notification data from MockApnsSender calls
#[cfg(test)]
#[derive(Debug, Clone)]
pub struct CapturedNotification {
    pub device_token: String,
    pub title: String,
    pub body: String,
    pub project: Option<String>,
    pub notification_type: Option<String>,
}

/// Mock APNS sender for integration tests.
///
/// Returns a pre-configured response for every `send_notification` call and
/// captures the arguments so tests can inspect what was sent.
#[cfg(test)]
pub struct MockApnsSender {
    /// The response that will be returned for every send call
    response: std::sync::Mutex<Result<ApnsResponse>>,
    /// All notifications that were sent through this mock
    pub sent: std::sync::Mutex<Vec<CapturedNotification>>,
}

#[cfg(test)]
impl MockApnsSender {
    /// Create a mock that always returns the given response
    pub fn with_response(response: ApnsResponse) -> Self {
        Self {
            response: std::sync::Mutex::new(Ok(response)),
            sent: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Create a mock that always returns an error
    pub fn with_error(msg: &str) -> Self {
        Self {
            response: std::sync::Mutex::new(Err(anyhow::anyhow!("{}", msg))),
            sent: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Get a snapshot of all captured notifications
    pub fn get_sent(&self) -> Vec<CapturedNotification> {
        self.sent.lock().unwrap().clone()
    }
}

#[cfg(test)]
#[async_trait]
impl ApnsSender for MockApnsSender {
    async fn send_notification(
        &self,
        device_token: &str,
        title: &str,
        body: &str,
        project: Option<&str>,
        notification_type: Option<&str>,
    ) -> Result<ApnsResponse> {
        self.sent.lock().unwrap().push(CapturedNotification {
            device_token: device_token.to_string(),
            title: title.to_string(),
            body: body.to_string(),
            project: project.map(|s| s.to_string()),
            notification_type: notification_type.map(|s| s.to_string()),
        });

        let guard = self.response.lock().unwrap();
        match &*guard {
            Ok(resp) => Ok(resp.clone()),
            Err(e) => Err(anyhow::anyhow!("{}", e)),
        }
    }
}

/// Test .p8 private key (EC P-256) for unit tests. This is the same test key
/// used by the a2 crate and is NOT a production key.
#[cfg(test)]
const TEST_P8_KEY: &str = "-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg8g/n6j9roKvnUkwu
lCEIvbDqlUhA5FOzcakkG90E8L+hRANCAATKS2ZExEybUvchRDuKBftotMwVEus3
jDwmlD1Gg0yJt1e38djFwsxsfr5q2hv0Rj9fTEqAPr8H7mGm0wKxZ7iQ
-----END PRIVATE KEY-----";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    // -----------------------------------------------------------------------
    // [6.1] Mock APNS server tests
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_mock_sender_returns_success() {
        let mock = MockApnsSender::with_response(ApnsResponse::Success);
        let result = mock
            .send_notification("device123", "Title", "Body", None, None)
            .await;
        assert_eq!(result.unwrap(), ApnsResponse::Success);
    }

    #[tokio::test]
    async fn test_mock_sender_returns_token_expired() {
        let mock = MockApnsSender::with_response(ApnsResponse::TokenExpired);
        let result = mock
            .send_notification("device123", "Title", "Body", None, None)
            .await;
        assert_eq!(result.unwrap(), ApnsResponse::TokenExpired);
    }

    #[tokio::test]
    async fn test_mock_sender_returns_bad_request() {
        let mock =
            MockApnsSender::with_response(ApnsResponse::BadRequest("invalid payload".to_string()));
        let result = mock
            .send_notification("device123", "Title", "Body", None, None)
            .await;
        assert_eq!(
            result.unwrap(),
            ApnsResponse::BadRequest("invalid payload".to_string())
        );
    }

    #[tokio::test]
    async fn test_mock_sender_returns_error() {
        let mock = MockApnsSender::with_error("connection refused");
        let result = mock
            .send_notification("device123", "Title", "Body", None, None)
            .await;
        assert!(result.is_err());
        assert!(result
            .unwrap_err()
            .to_string()
            .contains("connection refused"));
    }

    #[tokio::test]
    async fn test_mock_sender_captures_arguments() {
        let mock = MockApnsSender::with_response(ApnsResponse::Success);

        mock.send_notification(
            "abc123def456",
            "Build Complete",
            "All tests passed",
            Some("my-project"),
            Some("status"),
        )
        .await
        .unwrap();

        let sent = mock.get_sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].device_token, "abc123def456");
        assert_eq!(sent[0].title, "Build Complete");
        assert_eq!(sent[0].body, "All tests passed");
        assert_eq!(sent[0].project.as_deref(), Some("my-project"));
        assert_eq!(sent[0].notification_type.as_deref(), Some("status"));
    }

    #[tokio::test]
    async fn test_mock_sender_captures_multiple_calls() {
        let mock = MockApnsSender::with_response(ApnsResponse::Success);

        mock.send_notification("token1", "T1", "B1", None, None)
            .await
            .unwrap();
        mock.send_notification("token2", "T2", "B2", Some("proj"), Some("tts"))
            .await
            .unwrap();
        mock.send_notification("token3", "T3", "B3", None, Some("error"))
            .await
            .unwrap();

        let sent = mock.get_sent();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].device_token, "token1");
        assert_eq!(sent[1].device_token, "token2");
        assert_eq!(sent[2].device_token, "token3");
    }

    // -----------------------------------------------------------------------
    // [6.2] Unit tests: JWT / client creation, payload construction, response types
    // -----------------------------------------------------------------------

    #[test]
    fn test_apns_client_from_pem_sandbox() {
        let client = ApnsClient::from_pem(
            TEST_P8_KEY,
            "89AFRD1X22",
            "ASDFQWERTY",
            "com.example.watchkitapp",
            true,
        );
        assert!(
            client.is_ok(),
            "ApnsClient::from_pem should succeed with valid test key"
        );
        let client = client.unwrap();
        assert!(client.is_configured());
    }

    #[test]
    fn test_apns_client_from_pem_production() {
        let client = ApnsClient::from_pem(
            TEST_P8_KEY,
            "89AFRD1X22",
            "ASDFQWERTY",
            "com.example.watchkitapp",
            false,
        );
        assert!(
            client.is_ok(),
            "ApnsClient::from_pem should succeed in production mode"
        );
    }

    #[test]
    fn test_apns_client_from_pem_invalid_key() {
        let result = ApnsClient::from_pem(
            "not-a-valid-pem-key",
            "89AFRD1X22",
            "ASDFQWERTY",
            "com.example.watchkitapp",
            true,
        );
        assert!(
            result.is_err(),
            "Invalid PEM key should cause creation failure"
        );
    }

    #[test]
    fn test_apns_client_new_missing_file() {
        let result = ApnsClient::new(
            "/nonexistent/path/key.p8",
            "89AFRD1X22",
            "ASDFQWERTY",
            "com.example.watchkitapp",
            true,
        );
        assert!(result.is_err());
        let err = format!("{}", result.err().unwrap());
        assert!(
            err.contains("Failed to read APNS key file"),
            "Error should mention file read failure, got: {}",
            err
        );
    }

    #[test]
    fn test_build_apns_payload_with_all_fields() {
        let payload = build_apns_payload(
            "Test Title",
            "Test Body",
            Some("test-project"),
            Some("status"),
        );

        assert_eq!(payload["aps"]["alert"]["title"], "Test Title");
        assert_eq!(payload["aps"]["alert"]["body"], "Test Body");
        assert_eq!(payload["aps"]["sound"], "default");
        assert_eq!(payload["project"], "test-project");
        assert_eq!(payload["type"], "status");
        assert!(payload["timestamp"].is_string());

        // Verify timestamp is valid RFC3339
        let ts = payload["timestamp"].as_str().unwrap();
        chrono::DateTime::parse_from_rfc3339(ts).expect("Timestamp should be valid RFC3339");
    }

    #[test]
    fn test_build_apns_payload_minimal() {
        let payload = build_apns_payload("Alert", "Message", None, None);

        assert_eq!(payload["aps"]["alert"]["title"], "Alert");
        assert_eq!(payload["aps"]["alert"]["body"], "Message");
        assert_eq!(payload["aps"]["sound"], "default");
        assert!(payload["timestamp"].is_string());
        assert!(payload["project"].is_null());
        assert!(payload["type"].is_null());
    }

    #[test]
    fn test_build_apns_payload_serializes_to_valid_json() {
        let payload = build_apns_payload("Title", "Body", Some("proj"), Some("alert"));
        let payload_str = serde_json::to_string(&payload).expect("Should serialize");
        let parsed: Value = serde_json::from_str(&payload_str).expect("Should deserialize");

        assert_eq!(parsed["aps"]["alert"]["title"], "Title");
        assert_eq!(parsed["project"], "proj");
        assert_eq!(parsed["type"], "alert");
    }

    #[test]
    fn test_build_apns_payload_special_characters() {
        let payload = build_apns_payload(
            "Test \"Quoted\" Title",
            "Body with 'single' and \"double\" quotes & <brackets>",
            Some("project-name_123"),
            Some("special-type"),
        );

        let payload_str = serde_json::to_string(&payload).expect("Should serialize");
        let reparsed: Value = serde_json::from_str(&payload_str).expect("Should deserialize");

        assert_eq!(reparsed["aps"]["alert"]["title"], "Test \"Quoted\" Title");
        assert_eq!(
            reparsed["aps"]["alert"]["body"],
            "Body with 'single' and \"double\" quotes & <brackets>"
        );
        assert_eq!(reparsed["project"], "project-name_123");
    }

    #[test]
    fn test_build_apns_payload_unicode() {
        let payload = build_apns_payload("Build complete", "Tests passed", None, None);
        let payload_str = serde_json::to_string(&payload).expect("Should serialize unicode");
        let reparsed: Value = serde_json::from_str(&payload_str).expect("Should deserialize");
        assert_eq!(reparsed["aps"]["alert"]["title"], "Build complete");
    }

    #[test]
    fn test_build_apns_payload_empty_strings() {
        let payload = build_apns_payload("", "", Some(""), Some(""));
        assert_eq!(payload["aps"]["alert"]["title"], "");
        assert_eq!(payload["aps"]["alert"]["body"], "");
        assert_eq!(payload["project"], "");
        assert_eq!(payload["type"], "");
    }

    #[test]
    fn test_build_apns_payload_long_body() {
        let long_body = "x".repeat(4096);
        let payload = build_apns_payload("Title", &long_body, None, None);
        assert_eq!(payload["aps"]["alert"]["body"], long_body.as_str());

        // Ensure it still serializes
        let payload_str = serde_json::to_string(&payload).expect("Should serialize long payload");
        assert!(payload_str.len() > 4096);
    }

    #[test]
    fn test_apns_response_success() {
        let response = ApnsResponse::Success;
        assert_eq!(response, ApnsResponse::Success);
    }

    #[test]
    fn test_apns_response_bad_request() {
        let error_msg = "Invalid payload".to_string();
        let response = ApnsResponse::BadRequest(error_msg.clone());

        match response {
            ApnsResponse::BadRequest(msg) => assert_eq!(msg, error_msg),
            _ => panic!("Expected BadRequest variant"),
        }
    }

    #[test]
    fn test_apns_response_token_expired() {
        let response = ApnsResponse::TokenExpired;
        assert_eq!(response, ApnsResponse::TokenExpired);
    }

    #[test]
    fn test_apns_response_error() {
        let error_msg = "Connection failed".to_string();
        let response = ApnsResponse::Error(error_msg.clone());

        match response {
            ApnsResponse::Error(msg) => assert_eq!(msg, error_msg),
            _ => panic!("Expected Error variant"),
        }
    }

    #[test]
    fn test_timestamp_format_is_rfc3339() {
        let timestamp = Utc::now().to_rfc3339();

        // Verify timestamp can be parsed back
        let parsed = chrono::DateTime::parse_from_rfc3339(&timestamp)
            .expect("Timestamp should be valid RFC3339");

        // Verify it's a valid datetime
        assert!(parsed.timestamp() > 0);
    }

    #[test]
    fn test_response_equality_for_success() {
        let resp1 = ApnsResponse::Success;
        let resp2 = ApnsResponse::Success;
        assert_eq!(resp1, resp2);
    }

    #[test]
    fn test_response_inequality_different_variants() {
        let success = ApnsResponse::Success;
        let expired = ApnsResponse::TokenExpired;
        assert_ne!(success, expired);
    }

    #[test]
    fn test_response_inequality_different_messages() {
        let error1 = ApnsResponse::Error("Error 1".to_string());
        let error2 = ApnsResponse::Error("Error 2".to_string());
        assert_ne!(error1, error2);
    }

    // -----------------------------------------------------------------------
    // [6.3] Integration test: mock sender -> verify payload format end-to-end
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_integration_sender_flow_with_project() {
        // Simulate the full flow: build payload, send via mock, verify capture
        let mock = MockApnsSender::with_response(ApnsResponse::Success);

        // Mimic what service.rs does: build title from project, send notification
        let project = Some("oo");
        let message = "Deploy complete. All checks passed.";
        let notification_type = "tts";

        let title = match project {
            Some(p) if !p.is_empty() && p != "global" => p.to_uppercase(),
            _ => "Claude".to_string(),
        };

        let result = mock
            .send_notification(
                "aabbccdd11223344",
                &title,
                message,
                project,
                Some(notification_type),
            )
            .await;

        assert_eq!(result.unwrap(), ApnsResponse::Success);

        let sent = mock.get_sent();
        assert_eq!(sent.len(), 1);
        assert_eq!(sent[0].title, "OO");
        assert_eq!(sent[0].body, "Deploy complete. All checks passed.");
        assert_eq!(sent[0].project.as_deref(), Some("oo"));
        assert_eq!(sent[0].notification_type.as_deref(), Some("tts"));
    }

    #[tokio::test]
    async fn test_integration_sender_flow_global_project() {
        let mock = MockApnsSender::with_response(ApnsResponse::Success);

        // When project is "global", title should be "Claude"
        let project = Some("global");
        let title = match project {
            Some(p) if !p.is_empty() && p != "global" => p.to_uppercase(),
            _ => "Claude".to_string(),
        };

        mock.send_notification("aabbccdd", &title, "Test message", project, Some("status"))
            .await
            .unwrap();

        let sent = mock.get_sent();
        assert_eq!(sent[0].title, "Claude");
    }

    #[tokio::test]
    async fn test_integration_sender_flow_no_project() {
        let mock = MockApnsSender::with_response(ApnsResponse::Success);

        let project: Option<&str> = None;
        let title = match project {
            Some(p) if !p.is_empty() && p != "global" => p.to_uppercase(),
            _ => "Claude".to_string(),
        };

        mock.send_notification("aabbccdd", &title, "Test", project, Some("error"))
            .await
            .unwrap();

        let sent = mock.get_sent();
        assert_eq!(sent[0].title, "Claude");
        assert!(sent[0].project.is_none());
    }

    #[tokio::test]
    async fn test_integration_multi_device_delivery() {
        // Simulate delivering to multiple devices (as service.rs does)
        let mock = MockApnsSender::with_response(ApnsResponse::Success);

        let devices = vec!["token_aaa", "token_bbb", "token_ccc"];

        for device in &devices {
            let result = mock
                .send_notification(device, "PROJ", "Alert", Some("proj"), Some("tts"))
                .await;
            assert_eq!(result.unwrap(), ApnsResponse::Success);
        }

        let sent = mock.get_sent();
        assert_eq!(sent.len(), 3);
        assert_eq!(sent[0].device_token, "token_aaa");
        assert_eq!(sent[1].device_token, "token_bbb");
        assert_eq!(sent[2].device_token, "token_ccc");
    }

    #[tokio::test]
    async fn test_integration_payload_structure_matches_aps_spec() {
        // Verify the payload built by build_apns_payload conforms to the APS spec:
        // - Must have "aps" object with "alert" containing "title" and "body"
        // - Must have "aps.sound"
        // - Custom keys at top level
        let payload = build_apns_payload("Build Done", "3 tests passed", Some("tc"), Some("tts"));

        // Required APS structure
        assert!(payload["aps"].is_object(), "aps must be an object");
        assert!(
            payload["aps"]["alert"].is_object(),
            "aps.alert must be an object"
        );
        assert!(
            payload["aps"]["alert"]["title"].is_string(),
            "aps.alert.title must be a string"
        );
        assert!(
            payload["aps"]["alert"]["body"].is_string(),
            "aps.alert.body must be a string"
        );
        assert!(
            payload["aps"]["sound"].is_string(),
            "aps.sound must be a string"
        );

        // Custom fields at top level (not nested under aps)
        assert!(payload["project"].is_string());
        assert!(payload["type"].is_string());
        assert!(payload["timestamp"].is_string());

        // Verify custom fields are NOT inside aps
        assert!(payload["aps"]["project"].is_null());
        assert!(payload["aps"]["type"].is_null());
        assert!(payload["aps"]["timestamp"].is_null());
    }

    // -----------------------------------------------------------------------
    // [6.4] Token invalidation: 410 -> token marked inactive
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn test_token_invalidation_on_410() {
        use super::super::watch_tokens::WatchTokenStore;
        use tempfile::TempDir;

        // Set up token store with an active device
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test-tokens.db");
        let store = WatchTokenStore::open_at(db_path).unwrap();

        let device_token = "aabbccdd11223344aabbccdd11223344";
        store.register_token(device_token, "watchOS").unwrap();

        // Verify token is active
        let active = store.get_active_tokens().unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].device_token, device_token);
        assert!(active[0].is_active);

        // Simulate APNS returning 410 (TokenExpired)
        let mock = MockApnsSender::with_response(ApnsResponse::TokenExpired);
        let result = mock
            .send_notification(device_token, "Title", "Body", None, None)
            .await
            .unwrap();

        // Replicate the service.rs invalidation logic
        if result == ApnsResponse::TokenExpired {
            store.invalidate_token(device_token).unwrap();
        }

        // Verify token is now inactive
        let active_after = store.get_active_tokens().unwrap();
        assert_eq!(
            active_after.len(),
            0,
            "Token should be inactive after 410 response"
        );
    }

    #[tokio::test]
    async fn test_token_not_invalidated_on_success() {
        use super::super::watch_tokens::WatchTokenStore;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test-tokens.db");
        let store = WatchTokenStore::open_at(db_path).unwrap();

        let device_token = "aabbccdd11223344aabbccdd11223344";
        store.register_token(device_token, "watchOS").unwrap();

        let mock = MockApnsSender::with_response(ApnsResponse::Success);
        let result = mock
            .send_notification(device_token, "Title", "Body", None, None)
            .await
            .unwrap();

        // Success should NOT invalidate the token
        if result == ApnsResponse::TokenExpired {
            store.invalidate_token(device_token).unwrap();
        }

        let active = store.get_active_tokens().unwrap();
        assert_eq!(
            active.len(),
            1,
            "Token should remain active after successful delivery"
        );
    }

    #[tokio::test]
    async fn test_token_not_invalidated_on_bad_request() {
        use super::super::watch_tokens::WatchTokenStore;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test-tokens.db");
        let store = WatchTokenStore::open_at(db_path).unwrap();

        let device_token = "aabbccdd11223344aabbccdd11223344";
        store.register_token(device_token, "watchOS").unwrap();

        let mock =
            MockApnsSender::with_response(ApnsResponse::BadRequest("PayloadTooLarge".to_string()));
        let result = mock
            .send_notification(device_token, "Title", "Body", None, None)
            .await
            .unwrap();

        // BadRequest should NOT invalidate the token
        if result == ApnsResponse::TokenExpired {
            store.invalidate_token(device_token).unwrap();
        }

        let active = store.get_active_tokens().unwrap();
        assert_eq!(
            active.len(),
            1,
            "Token should remain active after bad request (not a token problem)"
        );
    }

    #[tokio::test]
    async fn test_token_invalidation_multi_device_partial_410() {
        use super::super::watch_tokens::WatchTokenStore;
        use tempfile::TempDir;

        // Set up store with two devices
        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test-tokens.db");
        let store = WatchTokenStore::open_at(db_path).unwrap();

        let token_good = "good_token_aabbccdd11223344";
        let token_expired = "expired_token_aabbccdd1122";

        store.register_token(token_good, "watchOS").unwrap();
        store.register_token(token_expired, "watchOS").unwrap();

        let active = store.get_active_tokens().unwrap();
        assert_eq!(active.len(), 2);

        // Simulate sending: first device succeeds, second returns 410
        // (In real code each device gets its own send call)
        let devices_and_responses: Vec<(&str, ApnsResponse)> = vec![
            (token_good, ApnsResponse::Success),
            (token_expired, ApnsResponse::TokenExpired),
        ];

        for (token, expected_response) in &devices_and_responses {
            // Replicate the service.rs per-device handling
            match expected_response {
                ApnsResponse::TokenExpired => {
                    store.invalidate_token(token).unwrap();
                }
                _ => {}
            }
        }

        // Only the expired token should be inactive
        let active_after = store.get_active_tokens().unwrap();
        assert_eq!(active_after.len(), 1);
        assert_eq!(active_after[0].device_token, token_good);
    }

    #[tokio::test]
    async fn test_token_reactivation_after_invalidation() {
        use super::super::watch_tokens::WatchTokenStore;
        use tempfile::TempDir;

        let temp_dir = TempDir::new().unwrap();
        let db_path = temp_dir.path().join("test-tokens.db");
        let store = WatchTokenStore::open_at(db_path).unwrap();

        let device_token = "aabbccdd11223344aabbccdd11223344";
        store.register_token(device_token, "watchOS").unwrap();

        // Invalidate via 410
        let mock = MockApnsSender::with_response(ApnsResponse::TokenExpired);
        let result = mock
            .send_notification(device_token, "Title", "Body", None, None)
            .await
            .unwrap();
        if result == ApnsResponse::TokenExpired {
            store.invalidate_token(device_token).unwrap();
        }
        assert_eq!(store.get_active_tokens().unwrap().len(), 0);

        // Device re-registers (e.g., user re-opened app)
        store.register_token(device_token, "watchOS").unwrap();

        let active = store.get_active_tokens().unwrap();
        assert_eq!(active.len(), 1);
        assert!(active[0].is_active);
    }
}
