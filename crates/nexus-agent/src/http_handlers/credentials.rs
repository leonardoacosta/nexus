//! GET /credentials handler.

use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};

use super::AppState;
use super::commands::validate_secret;

#[derive(Debug, Serialize, Deserialize)]
pub struct WindowStatus {
    pub utilization: f32,
    pub resets_in_minutes: f64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct AccountStatus {
    pub name: String,
    pub expired: bool,
    pub five_hour: Option<WindowStatus>,
    pub seven_day: Option<WindowStatus>,
    pub seconds_since_polled: Option<i64>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SwapInfo {
    pub debounce_active: bool,
    pub last_swap_account: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CredentialsResponse {
    pub active_account: Option<String>,
    pub accounts: Vec<AccountStatus>,
    pub swap: SwapInfo,
}

/// GET /credentials — return sanitized credential pool status (no tokens/paths).
///
/// Requires `X-Nexus-Secret` when a secret is configured in agents.toml or via
/// the `NEXUS_SECRET` env var. Unauthenticated requests receive HTTP 401.
/// The secret value is sourced from `AppState::secret`, which is the same field
/// used by the `/project/{code}/run` guard (`effective_secret()` in main.rs).
pub async fn credentials_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CredentialsResponse>, (StatusCode, String)> {
    validate_secret(&state.secret, &headers)?;

    let pool = &state.credential_pool;
    let now = chrono::Utc::now();

    let active = pool.active_account.read().await.clone();
    let accounts = pool.accounts.read().await;

    let account_statuses: Vec<AccountStatus> = accounts
        .iter()
        .map(|a| {
            let (five_hour, seven_day) = match &a.usage {
                Some(usage) => {
                    let fh = WindowStatus {
                        utilization: usage.five_hour.utilization,
                        resets_in_minutes: usage
                            .five_hour
                            .resets_at
                            .signed_duration_since(now)
                            .num_seconds() as f64
                            / 60.0,
                    };
                    let sd = WindowStatus {
                        utilization: usage.seven_day.utilization,
                        resets_in_minutes: usage
                            .seven_day
                            .resets_at
                            .signed_duration_since(now)
                            .num_seconds() as f64
                            / 60.0,
                    };
                    (Some(fh), Some(sd))
                }
                None => (None, None),
            };

            let seconds_since_polled = a
                .last_polled
                .map(|lp| now.signed_duration_since(lp).num_seconds());

            AccountStatus {
                name: a.name.clone(),
                expired: a.is_expired(),
                five_hour,
                seven_day,
                seconds_since_polled,
            }
        })
        .collect();

    let debounce_active = pool.is_debounce_active().await;
    let last_swap_account = pool.last_swap_account.read().await.clone();

    Ok(Json(CredentialsResponse {
        active_account: active,
        accounts: account_statuses,
        swap: SwapInfo {
            debounce_active,
            last_swap_account,
        },
    }))
}
