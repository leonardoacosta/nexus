//! Anthropic Usage API Client
//!
//! Queries the Anthropic OAuth usage endpoint to retrieve account utilization.
//! Moved from nexus-core to nexus-agent since only the agent calls this.

use chrono::{DateTime, Utc};
use nexus_core::credentials::{AccountUsage, UsageWindow};
use serde::Deserialize;

/// API response from https://api.anthropic.com/api/oauth/usage
///
/// Matches the shape returned by the Anthropic OAuth usage endpoint.
#[derive(Debug, Clone, Deserialize)]
struct UsageApiResponse {
    five_hour: Option<UsageApiPeriod>,
    seven_day: Option<UsageApiPeriod>,
}

#[derive(Debug, Clone, Deserialize)]
struct UsageApiPeriod {
    utilization: f64,
    resets_at: Option<String>,
}

/// Query the Anthropic usage API for the account associated with `access_token`.
///
/// Calls `GET https://api.anthropic.com/api/oauth/usage` with a Bearer token
/// and the `anthropic-beta: oauth-2025-04-20` header.
pub async fn query_usage(
    client: &reqwest::Client,
    access_token: &str,
) -> anyhow::Result<AccountUsage> {
    let resp = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", access_token))
        .header("anthropic-beta", "oauth-2025-04-20")
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await?
        .error_for_status()?;

    let api: UsageApiResponse = resp.json().await?;
    parse_usage_response(api)
}

/// Convert the raw API response into our domain type.
fn parse_usage_response(api: UsageApiResponse) -> anyhow::Result<AccountUsage> {
    let five_hour = parse_period(api.five_hour, "five_hour")?;
    let seven_day = parse_period(api.seven_day, "seven_day")?;
    Ok(AccountUsage {
        five_hour,
        seven_day,
    })
}

fn parse_period(period: Option<UsageApiPeriod>, name: &str) -> anyhow::Result<UsageWindow> {
    let p = period.ok_or_else(|| anyhow::anyhow!("missing {} period in usage response", name))?;
    let resets_at_str = p
        .resets_at
        .ok_or_else(|| anyhow::anyhow!("missing resets_at in {} period", name))?;
    let resets_at = resets_at_str.parse::<DateTime<Utc>>()?;
    Ok(UsageWindow {
        utilization: p.utilization as f32,
        resets_at,
    })
}

// ── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_usage_response_valid() {
        let api = UsageApiResponse {
            five_hour: Some(UsageApiPeriod {
                utilization: 0.45,
                resets_at: Some("2026-03-31T19:15:00Z".to_string()),
            }),
            seven_day: Some(UsageApiPeriod {
                utilization: 0.72,
                resets_at: Some("2026-04-03T00:00:00Z".to_string()),
            }),
        };
        let usage = parse_usage_response(api).unwrap();
        assert!((usage.five_hour.utilization - 0.45).abs() < f32::EPSILON);
        assert!((usage.seven_day.utilization - 0.72).abs() < f32::EPSILON);
    }

    #[test]
    fn parse_usage_response_missing_period() {
        let api = UsageApiResponse {
            five_hour: None,
            seven_day: Some(UsageApiPeriod {
                utilization: 0.5,
                resets_at: Some("2026-04-03T00:00:00Z".to_string()),
            }),
        };
        assert!(parse_usage_response(api).is_err());
    }
}
