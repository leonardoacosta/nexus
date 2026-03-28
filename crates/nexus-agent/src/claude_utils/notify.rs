// Notification utilities module
//
// This module provides best-effort notification delivery to remote audio receivers.
// It supports multiple receiver endpoints with automatic failover and deduplication.
//
// # Environment Variables
//
// - `AUDIO_RECEIVER_URLS`: Comma-separated list of receiver URLs (primary)
// - `AUDIO_RECEIVER_URL`: Single URL or comma-separated list (fallback)
//
// # Example
//
// ```no_run
// use claude_utils::notify::{get_receiver_urls, send_notification};
//
// #[tokio::main]
// async fn main() {
//     // Get all configured receivers
//     let urls = get_receiver_urls();
//     println!("Configured receivers: {}", urls.len());
//
//     // Send notification
//     match send_notification("Build completed", Some("my-project")).await {
//         Ok(true) => println!("Notification sent"),
//         Ok(false) => println!("No receivers or all failed"),
//         Err(e) => eprintln!("Error: {}", e),
//     }
// }
// ```

use anyhow::Result;
use reqwest::Client;
use serde_json::json;
use std::collections::HashSet;
use std::env;
use std::time::Duration;

/// Get all configured audio receiver URLs from environment.
/// Supports both AUDIO_RECEIVER_URLS (comma-separated) and AUDIO_RECEIVER_URL.
/// Returns deduplicated list of URLs.
pub fn get_receiver_urls() -> Vec<String> {
    let mut urls = Vec::new();
    let mut seen = HashSet::new();

    // Primary: AUDIO_RECEIVER_URLS (comma-separated)
    if let Ok(url_list) = env::var("AUDIO_RECEIVER_URLS") {
        for url in url_list.split(',') {
            let trimmed = url.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                urls.push(trimmed.to_string());
            }
        }
    }

    // Also parse AUDIO_RECEIVER_URL (supports comma-separated too)
    if let Ok(single_url) = env::var("AUDIO_RECEIVER_URL") {
        for url in single_url.split(',') {
            let trimmed = url.trim();
            if !trimmed.is_empty() && seen.insert(trimmed.to_string()) {
                urls.push(trimmed.to_string());
            }
        }
    }

    urls
}

/// Send notification to remote audio receiver(s).
/// Tries each endpoint in order until one succeeds.
/// Returns true if successfully delivered to any endpoint, false if all fail.
///
/// # Arguments
/// * `message` - The notification message to send
/// * `project_code` - Optional project code to include in the notification
pub async fn send_notification(message: &str, project_code: Option<&str>) -> Result<bool> {
    let urls = get_receiver_urls();
    if urls.is_empty() {
        return Ok(false);
    }

    let client = Client::builder().timeout(Duration::from_secs(3)).build()?;

    // Try each endpoint in order until one succeeds
    for url in urls {
        let endpoint = format!("{}/speak", url);
        let body = json!({
            "message": message,
            "project": project_code
        });

        match client
            .post(&endpoint)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                return Ok(true);
            }
            _ => {
                // Try next endpoint
                continue;
            }
        }
    }

    Ok(false)
}
