//! Apple Watch notification delivery via APNs
//!
//! Delivers push notifications to registered Apple Watch devices.

use super::{ApnsClient, ApnsResponse, ApnsSender, WatchTokenStore};
use tracing::{debug, error, info, warn};

/// Validated configuration for Watch delivery, extracted from the notification
/// config to flatten the 4 sequential match guards.
struct WatchDeliveryConfig<'a> {
    apns_key_path: &'a str,
    apns_key_id: &'a str,
    apns_team_id: &'a str,
    bundle_id: &'a str,
    sandbox: bool,
}

impl<'a> WatchDeliveryConfig<'a> {
    /// Try to extract a valid Watch delivery config from the notification config.
    /// Returns `None` if Watch is disabled or any required field is missing.
    fn try_from(
        watch_config: &'a crate::claude_utils::notification_config::WatchConfig,
    ) -> Option<Self> {
        let apns_key_path = watch_config.apns_key_path.as_deref()?;
        if apns_key_path.is_empty() {
            warn!("Watch enabled but apns_key_path is empty");
            return None;
        }
        let apns_key_id = match &watch_config.apns_key_id {
            Some(id) => id.as_str(),
            None => {
                warn!("Watch enabled but apns_key_id not configured");
                return None;
            }
        };
        let apns_team_id = match &watch_config.apns_team_id {
            Some(id) => id.as_str(),
            None => {
                warn!("Watch enabled but apns_team_id not configured");
                return None;
            }
        };
        let bundle_id = match &watch_config.bundle_id {
            Some(id) => id.as_str(),
            None => {
                warn!("Watch enabled but bundle_id not configured");
                return None;
            }
        };
        let sandbox = watch_config.environment == "sandbox";
        Some(Self {
            apns_key_path,
            apns_key_id,
            apns_team_id,
            bundle_id,
            sandbox,
        })
    }
}

/// Deliver notification to Apple Watch devices.
pub(crate) async fn deliver_to_watch(
    message: &str,
    project: Option<&str>,
    notification_type: &str,
    mode: crate::claude_utils::notification_mode::NotificationMode,
    message_id: Option<&str>,
) {
    if mode == crate::claude_utils::notification_mode::NotificationMode::Silent {
        debug!("Watch delivery suppressed: silent mode");
        return;
    }

    let notification_config = crate::claude_utils::notification_config::load_notification_config();

    if !crate::claude_utils::notification_config::should_route_to_watch(
        &notification_config,
        notification_type,
    ) {
        debug!(
            "Watch routing disabled for notification type: {}",
            notification_type
        );
        return;
    }

    let watch_config = match notification_config.watch {
        Some(ref config) if config.enabled => config,
        _ => {
            debug!("Watch notifications disabled in config");
            return;
        }
    };

    let delivery_config = match WatchDeliveryConfig::try_from(watch_config) {
        Some(config) => config,
        None => return,
    };

    let key_path_expanded = crate::claude_utils::path::expand_home(delivery_config.apns_key_path);
    let key_path_str = key_path_expanded.to_string_lossy().to_string();

    let apns_client = match ApnsClient::new(
        &key_path_str,
        delivery_config.apns_key_id,
        delivery_config.apns_team_id,
        delivery_config.bundle_id,
        delivery_config.sandbox,
    ) {
        Ok(client) => client,
        Err(e) => {
            warn!("Failed to create APNS client: {}", e);
            return;
        }
    };

    let token_store = match WatchTokenStore::open() {
        Ok(store) => store,
        Err(e) => {
            warn!("Failed to open Watch token store: {}", e);
            return;
        }
    };

    let devices = match token_store.get_active_tokens() {
        Ok(tokens) => tokens,
        Err(e) => {
            warn!("Failed to get active Watch tokens: {}", e);
            return;
        }
    };

    if devices.is_empty() {
        debug!("No active Watch devices registered");
        return;
    }

    info!(
        "Delivering notification to {} Watch device(s) [type={}, message_id={:?}]",
        devices.len(),
        notification_type,
        message_id,
    );

    let (icon, name) = crate::claude_utils::project::get_project_display(project.unwrap_or(""));
    let title = format!("{} {}", icon, name);

    for device in devices {
        let result = apns_client
            .send_notification_ext(
                &device.device_token,
                &title,
                message,
                project,
                Some(notification_type),
                message_id,
            )
            .await;

        match result {
            Ok(ApnsResponse::Success) => {
                info!(
                    "Watch notification delivered successfully to device: {}",
                    &device.device_token[..8]
                );
            }
            Ok(ApnsResponse::TokenExpired) => {
                warn!(
                    "Watch device token expired, invalidating: {}",
                    &device.device_token[..8]
                );
                if let Err(e) = token_store.invalidate_token(&device.device_token) {
                    error!("Failed to invalidate expired token: {}", e);
                }
            }
            Ok(ApnsResponse::BadRequest(err)) => {
                warn!(
                    "Watch notification failed (bad request) for device {}: {}",
                    &device.device_token[..8],
                    err
                );
            }
            Ok(ApnsResponse::Error(err)) => {
                warn!(
                    "Watch notification failed for device {}: {}",
                    &device.device_token[..8],
                    err
                );
            }
            Err(e) => {
                error!(
                    "Watch notification error for device {}: {}",
                    &device.device_token[..8],
                    e
                );
            }
        }
    }
}
