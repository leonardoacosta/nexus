use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::path::PathBuf;

// ── Core Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialAccount {
    pub name: String,
    pub path: PathBuf,
    pub access_token: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub usage: Option<AccountUsage>,
    pub last_polled: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageWindow {
    pub utilization: f32,
    pub resets_at: DateTime<Utc>,
}

// ── Usage Cache ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UsageCache {
    pub accounts: std::collections::HashMap<String, CachedUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedUsage {
    pub five_hour: UsageWindow,
    pub seven_day: UsageWindow,
    pub last_polled: DateTime<Utc>,
}

impl UsageCache {
    pub fn load(path: &std::path::Path) -> anyhow::Result<Self> {
        let content = std::fs::read_to_string(path)?;
        let cache: Self = serde_json::from_str(&content)?;
        Ok(cache)
    }

    /// Atomic write: serialize to a temp file in the same directory, then rename.
    pub fn save(&self, path: &std::path::Path) -> anyhow::Result<()> {
        let json = serde_json::to_string_pretty(self)?;
        let tmp_path = path.with_extension("tmp");
        std::fs::write(&tmp_path, json)?;
        std::fs::rename(&tmp_path, path)?;
        Ok(())
    }
}

// ── CredentialAccount Methods ───────────────────────────────────────────────

impl CredentialAccount {
    pub fn is_expired(&self) -> bool {
        self.expires_at.is_some_and(|exp| exp < Utc::now())
    }

    pub fn effective_utilization(&self) -> f32 {
        self.usage.as_ref().map_or(0.0, |u| {
            u.five_hour.utilization.max(u.seven_day.utilization)
        })
    }
}

pub fn best_available(accounts: &[CredentialAccount]) -> Option<&CredentialAccount> {
    accounts
        .iter()
        .filter(|a| !a.is_expired())
        .filter(|a| {
            a.usage.as_ref().is_none_or(|u| {
                u.five_hour.utilization < 1.0 && u.seven_day.utilization < 1.0
            })
        })
        .min_by(|a, b| {
            a.effective_utilization()
                .partial_cmp(&b.effective_utilization())
                .unwrap_or(Ordering::Equal)
        })
}

// ── Usage API Client ────────────────────────────────────────────────────────

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
    use chrono::Duration;

    fn make_account(name: &str, five_hour_util: f32, seven_day_util: f32) -> CredentialAccount {
        let now = Utc::now();
        CredentialAccount {
            name: name.to_string(),
            path: PathBuf::from(format!("/tmp/{}.json", name)),
            access_token: format!("tok-{}", name),
            expires_at: Some(now + Duration::hours(1)),
            usage: Some(AccountUsage {
                five_hour: UsageWindow {
                    utilization: five_hour_util,
                    resets_at: now + Duration::hours(5),
                },
                seven_day: UsageWindow {
                    utilization: seven_day_util,
                    resets_at: now + Duration::days(7),
                },
            }),
            last_polled: Some(now),
        }
    }

    fn make_expired_account(name: &str) -> CredentialAccount {
        let now = Utc::now();
        CredentialAccount {
            name: name.to_string(),
            path: PathBuf::from(format!("/tmp/{}.json", name)),
            access_token: format!("tok-{}", name),
            expires_at: Some(now - Duration::hours(1)),
            usage: Some(AccountUsage {
                five_hour: UsageWindow {
                    utilization: 0.1,
                    resets_at: now + Duration::hours(5),
                },
                seven_day: UsageWindow {
                    utilization: 0.1,
                    resets_at: now + Duration::days(7),
                },
            }),
            last_polled: Some(now),
        }
    }

    #[test]
    fn best_available_picks_lowest_utilization() {
        let accounts = vec![
            make_account("high", 0.8, 0.5),
            make_account("low", 0.2, 0.3),
            make_account("mid", 0.5, 0.4),
        ];
        let best = best_available(&accounts).unwrap();
        assert_eq!(best.name, "low");
    }

    #[test]
    fn best_available_skips_expired() {
        let accounts = vec![
            make_expired_account("expired-low"),
            make_account("valid-high", 0.9, 0.5),
        ];
        let best = best_available(&accounts).unwrap();
        assert_eq!(best.name, "valid-high");
    }

    #[test]
    fn best_available_returns_none_when_all_exhausted() {
        let accounts = vec![
            make_account("full-a", 1.0, 0.5),
            make_account("full-b", 0.5, 1.0),
        ];
        assert!(best_available(&accounts).is_none());
    }

    #[test]
    fn is_expired_with_past_date() {
        let acct = make_expired_account("past");
        assert!(acct.is_expired());
    }

    #[test]
    fn is_expired_with_future_date() {
        let acct = make_account("future", 0.5, 0.5);
        assert!(!acct.is_expired());
    }

    #[test]
    fn is_expired_with_none() {
        let mut acct = make_account("none", 0.5, 0.5);
        acct.expires_at = None;
        assert!(!acct.is_expired());
    }

    #[test]
    fn effective_utilization_returns_max_of_two_windows() {
        let acct = make_account("test", 0.3, 0.7);
        assert!((acct.effective_utilization() - 0.7).abs() < f32::EPSILON);

        let acct2 = make_account("test2", 0.9, 0.2);
        assert!((acct2.effective_utilization() - 0.9).abs() < f32::EPSILON);
    }

    #[test]
    fn effective_utilization_with_no_usage() {
        let mut acct = make_account("no-usage", 0.5, 0.5);
        acct.usage = None;
        assert!((acct.effective_utilization() - 0.0).abs() < f32::EPSILON);
    }

    #[test]
    fn usage_cache_round_trip() {
        let dir = std::env::temp_dir().join("nexus-test-usage-cache");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("usage-cache.json");

        let now = Utc::now();
        let mut cache = UsageCache::default();
        cache.accounts.insert(
            "personal".to_string(),
            CachedUsage {
                five_hour: UsageWindow {
                    utilization: 0.45,
                    resets_at: now + Duration::hours(3),
                },
                seven_day: UsageWindow {
                    utilization: 0.72,
                    resets_at: now + Duration::days(5),
                },
                last_polled: now,
            },
        );

        cache.save(&path).unwrap();
        let loaded = UsageCache::load(&path).unwrap();

        assert_eq!(loaded.accounts.len(), 1);
        let personal = loaded.accounts.get("personal").unwrap();
        assert!((personal.five_hour.utilization - 0.45).abs() < f32::EPSILON);
        assert!((personal.seven_day.utilization - 0.72).abs() < f32::EPSILON);

        // Cleanup
        let _ = std::fs::remove_dir_all(&dir);
    }

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

    #[test]
    fn best_available_prefers_no_usage_over_high_usage() {
        let mut no_usage = make_account("fresh", 0.0, 0.0);
        no_usage.usage = None;
        let high_usage = make_account("heavy", 0.8, 0.9);

        let accounts = vec![high_usage, no_usage];
        let best = best_available(&accounts).unwrap();
        assert_eq!(best.name, "fresh");
    }
}
