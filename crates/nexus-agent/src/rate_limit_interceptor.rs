//\! Rate Limit Interceptor + Exhaustion Handler
//\!
//\! Detects rate limit events from socket notifications and telemetry, then:
//\! 1. Rotates credentials via symlink swap (3-minute cross-session debounce)
//\! 2. Sends "continue" to affected sessions via tmux dispatch
//\! 3. Formats exhaustion notifications when all accounts are rate-limited

use std::sync::Arc;

use chrono::Local;
use nexus_core::credentials::CredentialAccount;

use crate::dispatch::dispatch_answer;
use crate::registry::SessionRegistry;
use crate::services::credential_pool::CredentialPool;

// ── Detection ─────────────────────────────────────────────────────────────

/// Check if a notification message indicates a rate limit hit.
pub fn is_rate_limit_notification(message: &str) -> bool {
    message.contains("hit your limit") || message.contains("You've hit your limit")
}

// ── Interceptor Result ────────────────────────────────────────────────────

/// Outcome of the rate limit interception attempt.
pub enum InterceptResult {
    /// Successfully handled — suppress the notification from TTS.
    Handled,
    /// All accounts exhausted — forward the exhaustion message to TTS.
    Exhausted(String),
    /// Pool is empty or in passthrough mode — do nothing special.
    NoPool,
}

// ── Core Rotation Flow ───────────────────────────────────────────────────

/// Handle a detected rate limit event for a session.
///
/// This implements the full rotation flow:
/// 1. Check debounce — if active, just send "continue" without re-swap
/// 2. Poll fresh usage data
/// 3. Find best available credential
/// 4. Swap symlink + send "continue" to session
/// 5. If all exhausted, format exhaustion notification
///
/// `session_id`: the session that triggered the rate limit (for tmux target lookup).
pub async fn handle_rate_limit(
    pool: &Arc<CredentialPool>,
    registry: &Arc<SessionRegistry>,
    session_id: Option<&str>,
) -> InterceptResult {
    // Check if pool has any accounts at all.
    {
        let accounts = pool.accounts.read().await;
        if accounts.is_empty() {
            return InterceptResult::NoPool;
        }
    }

    // [4.3] Debounce: if a swap happened within 3 minutes, skip re-swap.
    if pool.is_debounce_active().await {
        let debounce_account = pool
            .last_swap_account
            .read()
            .await
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        tracing::info!(
            last_swap_to = %debounce_account,
            "Debounce active — sending continue without re-swap"
        );
        // [4.5] Still try to send "continue" to the affected session.
        send_continue_to_session(registry, session_id).await;
        return InterceptResult::Handled;
    }

    // [4.2] Step 1: Poll fresh usage data.
    pool.poll_now().await;

    // [4.2] Step 2: Find best available credential.
    let current_account = pool
        .active_account
        .read()
        .await
        .clone()
        .unwrap_or_else(|| "unknown".to_string());

    match pool.best_available().await {
        Some(target) => {
            // [4.2] Step 3: Swap credential symlink.
            match pool.swap_credential(&target).await {
                Ok(()) => {
                    // [4.3] Record swap for debounce.
                    pool.record_swap(&target.name).await;

                    tracing::info!(
                        from = %current_account,
                        to = %target.name,
                        session = session_id.unwrap_or("unknown"),
                        "Rotated credential on rate limit"
                    );

                    // [4.2] Step 4: Send "continue" to the session.
                    send_continue_to_session(registry, session_id).await;

                    InterceptResult::Handled
                }
                Err(e) => {
                    tracing::error!(error = %e, "Failed to swap credential on rate limit");
                    // Still try to send continue even if swap fails.
                    send_continue_to_session(registry, session_id).await;
                    InterceptResult::Handled
                }
            }
        }
        None => {
            // [5.1-5.3] All accounts exhausted — format exhaustion notification.
            let accounts = pool.accounts.read().await;
            let message = format_exhaustion_message(&accounts);
            tracing::warn!("All credential accounts exhausted");
            InterceptResult::Exhausted(message)
        }
    }
}

// ── Continue Dispatch ─────────────────────────────────────────────────────

/// Send "continue" to a session's tmux pane. Handles the non-tmux case [4.5].
async fn send_continue_to_session(registry: &Arc<SessionRegistry>, session_id: Option<&str>) {
    let Some(sid) = session_id else {
        tracing::warn!("Cannot auto-continue — no session_id available");
        return;
    };

    match registry.get_tmux_target(sid).await {
        Some(tmux_target) => match dispatch_answer(&tmux_target, "continue").await {
            Ok(()) => {
                tracing::info!(
                    session = %sid,
                    tmux_target = %tmux_target,
                    "Sent 'continue' to session after rate limit rotation"
                );
            }
            Err(e) => {
                tracing::error!(
                    session = %sid,
                    error = %e,
                    "Failed to send 'continue' to session"
                );
            }
        },
        None => {
            // [4.5] Non-tmux session — swap still benefits all sessions.
            tracing::warn!(
                session = %sid,
                "Cannot auto-continue — no tmux target"
            );
        }
    }
}

// ── Exhaustion Notification Formatting ────────────────────────────────────

/// [5.1-5.2] Format the exhaustion notification listing all accounts with
/// their reset times. The account with the soonest reset is marked.
fn format_exhaustion_message(accounts: &[CredentialAccount]) -> String {
    if accounts.is_empty() {
        return "All accounts rate-limited (no credentials configured)".to_string();
    }

    let mut lines = vec!["All accounts rate-limited:".to_string()];

    // [5.2] Find the soonest-to-reset account across both windows.
    let soonest_name = find_soonest_reset(accounts);

    for acct in accounts {
        let (window_label, reset_time) = match &acct.usage {
            Some(usage) => {
                // Pick the window that resets sooner for display.
                if usage.five_hour.resets_at <= usage.seven_day.resets_at {
                    ("5h", usage.five_hour.resets_at)
                } else {
                    ("7d", usage.seven_day.resets_at)
                }
            }
            None => {
                lines.push(format!("  {}: no usage data", acct.name));
                continue;
            }
        };

        let local_time = reset_time.with_timezone(&Local);
        let formatted_time = format_reset_time(&local_time);

        let marker = if soonest_name.as_deref() == Some(&acct.name) {
            " \u{2190} next available" // ← next available
        } else {
            ""
        };

        lines.push(format!(
            "  {}: {} resets {}{}",
            acct.name, window_label, formatted_time, marker
        ));
    }

    lines.join("\n")
}

/// Find the account name with the soonest `resets_at` across both windows.
fn find_soonest_reset(accounts: &[CredentialAccount]) -> Option<String> {
    accounts
        .iter()
        .filter_map(|acct| {
            acct.usage.as_ref().map(|usage| {
                let soonest = usage.five_hour.resets_at.min(usage.seven_day.resets_at);
                (&acct.name, soonest)
            })
        })
        .min_by_key(|(_, reset)| *reset)
        .map(|(name, _)| name.clone())
}

/// Format a reset time for display. Uses "1:45 PM" for today,
/// or "Thu" for future days.
fn format_reset_time(dt: &chrono::DateTime<Local>) -> String {
    let now = Local::now();
    if dt.date_naive() == now.date_naive() {
        dt.format("%-I:%M %p").to_string()
    } else {
        dt.format("%a").to_string()
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use nexus_core::credentials::{AccountUsage, UsageWindow};
    use std::path::PathBuf;

    fn make_exhausted_account(
        name: &str,
        five_hour_resets_hours: i64,
        seven_day_resets_hours: i64,
    ) -> CredentialAccount {
        let now = Utc::now();
        CredentialAccount {
            name: name.to_string(),
            path: PathBuf::from(format!("/tmp/{}.json", name)),
            access_token: format!("tok-{}", name),
            expires_at: Some(now + Duration::hours(24)),
            usage: Some(AccountUsage {
                five_hour: UsageWindow {
                    utilization: 1.0,
                    resets_at: now + Duration::hours(five_hour_resets_hours),
                },
                seven_day: UsageWindow {
                    utilization: 1.0,
                    resets_at: now + Duration::hours(seven_day_resets_hours),
                },
            }),
            last_polled: Some(now),
        }
    }

    #[test]
    fn test_is_rate_limit_notification() {
        assert!(is_rate_limit_notification(
            "You've hit your limit for today"
        ));
        assert!(is_rate_limit_notification(
            "Something hit your limit on this account"
        ));
        assert!(!is_rate_limit_notification("Normal notification message"));
        assert!(!is_rate_limit_notification(
            "Rate limited but different text"
        ));
    }

    #[test]
    fn test_format_exhaustion_message_empty() {
        let msg = format_exhaustion_message(&[]);
        assert!(msg.contains("no credentials configured"));
    }

    #[test]
    fn test_format_exhaustion_message_with_accounts() {
        let accounts = vec![
            make_exhausted_account("personal", 2, 48),
            make_exhausted_account("work", 1, 168),
            make_exhausted_account("team", 3, 24),
        ];
        let msg = format_exhaustion_message(&accounts);
        assert!(msg.starts_with("All accounts rate-limited:"));
        assert!(msg.contains("personal:"));
        assert!(msg.contains("work:"));
        assert!(msg.contains("team:"));
        // "work" resets soonest (1 hour) — should have the marker.
        assert!(msg.contains("next available"));
    }

    #[test]
    fn test_find_soonest_reset() {
        let accounts = vec![
            make_exhausted_account("a", 5, 168),
            make_exhausted_account("b", 1, 168),
            make_exhausted_account("c", 3, 168),
        ];
        let soonest = find_soonest_reset(&accounts);
        assert_eq!(soonest.as_deref(), Some("b"));
    }

    #[test]
    fn test_find_soonest_reset_no_usage() {
        let mut acct = make_exhausted_account("x", 1, 1);
        acct.usage = None;
        assert!(find_soonest_reset(&[acct]).is_none());
    }

    #[test]
    fn test_format_exhaustion_message_no_usage_data() {
        let mut acct = make_exhausted_account("broken", 1, 1);
        acct.usage = None;
        let msg = format_exhaustion_message(&[acct]);
        assert!(msg.contains("broken: no usage data"));
    }
}
