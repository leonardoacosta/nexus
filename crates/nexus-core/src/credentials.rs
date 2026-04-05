use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::path::{Path, PathBuf};

// ── Core Types ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CredentialAccount {
    pub name: String,
    pub path: PathBuf,
    /// Access token is never serialized to JSON to prevent accidental exposure.
    /// Populate this field programmatically after deserialization (e.g. by reading
    /// the credential file directly) — it will never be populated from a JSON key.
    #[serde(skip)]
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
            a.usage
                .as_ref()
                .is_none_or(|u| u.five_hour.utilization < 1.0 && u.seven_day.utilization < 1.0)
        })
        .min_by(|a, b| {
            a.effective_utilization()
                .partial_cmp(&b.effective_utilization())
                .unwrap_or(Ordering::Equal)
        })
}

// ── Token Fingerprinting ────────────────────────────────────────────────────

/// Compute a short fingerprint of an access token using SHA-256.
///
/// Returns the first 8 hex characters of the SHA-256 hash.
/// Deterministic: same token always produces the same fingerprint.
pub fn fingerprint_token(access_token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(access_token.as_bytes());
    let result = hasher.finalize();
    format!("{:x}", result)[..8].to_string()
}

/// Check if `path` is a symlink whose target resides inside `pool_dir`.
///
/// Returns `false` if the path is not a symlink, does not exist, or
/// its target is outside `pool_dir`.
pub fn is_managed_symlink(path: &Path, pool_dir: &Path) -> bool {
    match std::fs::read_link(path) {
        Ok(target) => {
            // Handle relative symlinks by resolving against the link's parent.
            let resolved = if target.is_absolute() {
                target
            } else {
                path.parent().map(|p| p.join(&target)).unwrap_or(target)
            };
            // Canonicalize both to handle .. and other path components.
            let canon_target = match resolved.canonicalize() {
                Ok(p) => p,
                Err(_) => return false,
            };
            let canon_pool = match pool_dir.canonicalize() {
                Ok(p) => p,
                Err(_) => return false,
            };
            canon_target.starts_with(&canon_pool)
        }
        Err(_) => false,
    }
}

/// Sanitize a name for use as a credential filename.
///
/// Lowercases, replaces non-alphanumeric characters with hyphens,
/// collapses consecutive hyphens, trims leading/trailing hyphens,
/// and truncates to 32 characters.
pub fn sanitize_account_name(name: &str) -> String {
    let sanitized: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    // Collapse consecutive hyphens.
    let mut result = String::with_capacity(sanitized.len());
    let mut last_was_hyphen = false;
    for c in sanitized.chars() {
        if c == '-' {
            if !last_was_hyphen {
                result.push(c);
            }
            last_was_hyphen = true;
        } else {
            result.push(c);
            last_was_hyphen = false;
        }
    }
    let trimmed = result.trim_matches('-');
    if trimmed.len() > 32 {
        trimmed[..32].trim_end_matches('-').to_string()
    } else {
        trimmed.to_string()
    }
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
    fn fingerprint_token_deterministic() {
        let fp1 = fingerprint_token("tok-abc123");
        let fp2 = fingerprint_token("tok-abc123");
        assert_eq!(fp1, fp2, "same token should produce same fingerprint");
    }

    #[test]
    fn fingerprint_token_is_8_hex_chars() {
        let fp = fingerprint_token("some-access-token-value");
        assert_eq!(
            fp.len(),
            8,
            "fingerprint should be 8 chars, got {}",
            fp.len()
        );
        assert!(
            fp.chars().all(|c| c.is_ascii_hexdigit()),
            "fingerprint should be hex, got {}",
            fp
        );
    }

    #[test]
    fn fingerprint_token_different_tokens_differ() {
        let fp1 = fingerprint_token("token-alpha");
        let fp2 = fingerprint_token("token-beta");
        assert_ne!(
            fp1, fp2,
            "different tokens should produce different fingerprints"
        );
    }

    #[test]
    fn is_managed_symlink_returns_false_for_regular_file() {
        let dir = std::env::temp_dir().join("nexus-test-managed-symlink");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pool_dir = dir.join("pool");
        std::fs::create_dir_all(&pool_dir).unwrap();
        let file = dir.join("regular.json");
        std::fs::write(&file, "{}").unwrap();

        assert!(!is_managed_symlink(&file, &pool_dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_managed_symlink_returns_true_for_symlink_inside_pool() {
        let dir = std::env::temp_dir().join("nexus-test-managed-symlink-2");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pool_dir = dir.join("pool");
        std::fs::create_dir_all(&pool_dir).unwrap();

        // Create target file inside pool.
        let target = pool_dir.join("acct-test.json");
        std::fs::write(&target, "{}").unwrap();

        // Create symlink pointing into pool.
        let link = dir.join("link.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(is_managed_symlink(&link, &pool_dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_managed_symlink_returns_false_for_symlink_outside_pool() {
        let dir = std::env::temp_dir().join("nexus-test-managed-symlink-3");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let pool_dir = dir.join("pool");
        std::fs::create_dir_all(&pool_dir).unwrap();
        let outside = dir.join("outside");
        std::fs::create_dir_all(&outside).unwrap();

        let target = outside.join("other.json");
        std::fs::write(&target, "{}").unwrap();

        let link = dir.join("link.json");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert!(!is_managed_symlink(&link, &pool_dir));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_managed_symlink_returns_false_for_nonexistent_path() {
        let pool_dir = std::env::temp_dir().join("nexus-test-nonexistent-pool");
        assert!(!is_managed_symlink(
            Path::new("/tmp/nonexistent-link-xyz"),
            &pool_dir
        ));
    }

    #[test]
    fn sanitize_account_name_basic() {
        assert_eq!(sanitize_account_name("John Doe"), "john-doe");
        assert_eq!(
            sanitize_account_name("user@example.com"),
            "user-example-com"
        );
    }

    #[test]
    fn sanitize_account_name_truncates_to_32() {
        let long = "a".repeat(50);
        let result = sanitize_account_name(&long);
        assert!(result.len() <= 32);
    }

    #[test]
    fn sanitize_account_name_strips_special() {
        assert_eq!(sanitize_account_name("---hello---"), "hello");
        assert_eq!(sanitize_account_name("a  b  c"), "a-b-c");
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

    // ── E2E-2: CredentialAccount serialization must NOT emit access_token ──

    /// [E2E-2] `CredentialAccount` with a non-empty access_token must not
    /// include the `access_token` field in its JSON serialization.
    /// This guards against accidental token exposure in API responses.
    #[test]
    fn credential_account_serialization_omits_access_token() {
        let account = CredentialAccount {
            name: "personal".to_string(),
            path: PathBuf::from("/home/user/.config/nexus/pool/personal.json"),
            access_token: "sk-ant-super-secret-token-that-must-not-appear".to_string(),
            expires_at: None,
            usage: None,
            last_polled: None,
        };

        let json = serde_json::to_string(&account).expect("serialization must succeed");

        assert!(
            !json.contains("access_token"),
            "JSON must not contain 'access_token' key, got: {json}"
        );
        assert!(
            !json.contains("sk-ant-super-secret-token-that-must-not-appear"),
            "JSON must not contain the token value, got: {json}"
        );

        // Sanity check: other fields are still present.
        assert!(json.contains("\"personal\""), "name field must be serialized");
    }

    /// [E2E-2] Deserializing a JSON that *does* contain an access_token key
    /// must NOT populate the field (serde(skip) blocks both directions).
    #[test]
    fn credential_account_deserialization_ignores_access_token_key() {
        let json = r#"{
            "name": "work",
            "path": "/tmp/work.json",
            "access_token": "should-be-ignored",
            "expires_at": null,
            "usage": null,
            "last_polled": null
        }"#;

        let account: CredentialAccount =
            serde_json::from_str(json).expect("deserialization must succeed");

        assert!(
            account.access_token.is_empty(),
            "access_token must be empty after deserialization, got: '{}'",
            account.access_token
        );
    }
}
