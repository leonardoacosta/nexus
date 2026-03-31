use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::sync::Mutex;

/// How long to cache the environment check results.
const CACHE_TTL: Duration = Duration::from_secs(60);

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentResponse {
    pub status: String,
    pub checks: EnvironmentChecks,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct EnvironmentChecks {
    pub dependencies: HashMap<String, DependencyCheck>,
    pub config: ConfigChecks,
    pub services: ServiceChecks,
}

#[derive(Debug, Clone, Serialize)]
pub struct DependencyCheck {
    pub found: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigChecks {
    pub settings_json: ConfigFileCheck,
    pub master_context: ConfigExistsCheck,
    pub bin_dir: BinDirCheck,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigFileCheck {
    pub valid: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConfigExistsCheck {
    pub exists: bool,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BinDirCheck {
    pub exists: bool,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ServiceChecks {
    pub nexus_agent: NexusAgentCheck,
    pub nexus_socket: SocketCheck,
}

#[derive(Debug, Clone, Serialize)]
pub struct NexusAgentCheck {
    pub running: bool,
    pub uptime_seconds: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SocketCheck {
    pub exists: bool,
    pub path: String,
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

pub struct EnvironmentCache {
    inner: Mutex<CacheState>,
}

struct CacheState {
    value: Option<EnvironmentResponse>,
    refreshed_at: Instant,
}

impl Default for EnvironmentCache {
    fn default() -> Self {
        Self::new()
    }
}

impl EnvironmentCache {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(CacheState {
                value: None,
                // Force a refresh on first access.
                refreshed_at: Instant::now()
                    .checked_sub(CACHE_TTL + Duration::from_secs(1))
                    .unwrap_or(Instant::now()),
            }),
        }
    }

    /// Return cached result or refresh if stale. `uptime_seconds` is provided
    /// by the caller from `AppState::started_at`.
    pub async fn get(&self, uptime_seconds: u64) -> EnvironmentResponse {
        let mut cache = self.inner.lock().await;
        if cache.refreshed_at.elapsed() >= CACHE_TTL || cache.value.is_none() {
            let result = collect_environment(uptime_seconds).await;
            cache.value = Some(result.clone());
            cache.refreshed_at = Instant::now();
            result
        } else {
            // Update uptime in the cached copy so it stays fresh.
            let mut resp = cache.value.clone().unwrap();
            resp.checks.services.nexus_agent.uptime_seconds = uptime_seconds;
            resp.timestamp = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
            resp
        }
    }
}

// ---------------------------------------------------------------------------
// Collection logic
// ---------------------------------------------------------------------------

/// Collect the full environment snapshot.
async fn collect_environment(uptime_seconds: u64) -> EnvironmentResponse {
    let home = std::env::var("HOME").unwrap_or_else(|_| String::from("/root"));

    // Run all dependency checks in parallel.
    let (bd, git, jq, node, cargo, gh, openspec) = tokio::join!(
        check_dependency("bd", &["--version"]),
        check_dependency("git", &["--version"]),
        check_dependency("jq", &["--version"]),
        check_dependency("node", &["--version"]),
        check_dependency("cargo", &["--version"]),
        check_gh(),
        check_dependency("openspec", &["--version"]),
    );

    let mut dependencies = HashMap::new();
    dependencies.insert("bd".into(), bd);
    dependencies.insert("git".into(), git);
    dependencies.insert("jq".into(), jq);
    dependencies.insert("node".into(), node);
    dependencies.insert("cargo".into(), cargo);
    dependencies.insert("gh".into(), gh);
    dependencies.insert("openspec".into(), openspec);

    // Config checks.
    let settings_path = format!("{}/.claude/settings.json", home);
    let master_context_path = format!("{}/.claude/scripts/state/master-context.json", home);
    let bin_dir_path = format!("{}/.claude/scripts/bin", home);

    let (settings_json, master_context, bin_dir) = tokio::join!(
        check_settings_json(&settings_path),
        check_file_exists(&master_context_path),
        check_bin_dir(&bin_dir_path),
    );

    let config = ConfigChecks {
        settings_json: ConfigFileCheck {
            valid: settings_json,
            path: settings_path.replace(&home, "~"),
        },
        master_context: ConfigExistsCheck {
            exists: master_context,
            path: master_context_path.replace(&home, "~"),
        },
        bin_dir,
    };

    // Service checks.
    let socket_path = "/tmp/nexus-agent.sock";
    let socket_exists = tokio::fs::metadata(socket_path).await.is_ok();

    let services = ServiceChecks {
        nexus_agent: NexusAgentCheck {
            running: true, // We are serving this request, so we are running.
            uptime_seconds,
        },
        nexus_socket: SocketCheck {
            exists: socket_exists,
            path: socket_path.into(),
        },
    };

    // Status logic.
    let git_found = dependencies.get("git").is_some_and(|d| d.found);
    let any_optional_missing = dependencies.values().any(|d| !d.found);

    let status = if !git_found {
        "critical"
    } else if any_optional_missing {
        "degraded"
    } else {
        "healthy"
    };

    EnvironmentResponse {
        status: status.into(),
        checks: EnvironmentChecks {
            dependencies,
            config,
            services,
        },
        timestamp: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
    }
}

/// Check whether a binary exists and extract its version string.
async fn check_dependency(name: &str, version_args: &[&str]) -> DependencyCheck {
    // Check if binary exists.
    let which = tokio::process::Command::new("which")
        .arg(name)
        .output()
        .await;

    let found = which.as_ref().is_ok_and(|o| o.status.success());
    if !found {
        return DependencyCheck {
            found: false,
            version: None,
            auth: None,
        };
    }

    // Get version.
    let version = match tokio::process::Command::new(name)
        .args(version_args)
        .output()
        .await
    {
        Ok(output) if output.status.success() => {
            let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Some(extract_version(&raw))
        }
        _ => None,
    };

    DependencyCheck {
        found: true,
        version,
        auth: None,
    }
}

/// Special handler for `gh` — also checks auth status.
async fn check_gh() -> DependencyCheck {
    let mut dep = check_dependency("gh", &["--version"]).await;
    if !dep.found {
        return dep;
    }

    // Check auth status.
    let auth = tokio::process::Command::new("gh")
        .args(["auth", "status"])
        .output()
        .await;

    dep.auth = Some(auth.as_ref().is_ok_and(|o| o.status.success()));
    dep
}

/// Check if settings.json exists and is valid JSON.
async fn check_settings_json(path: &str) -> bool {
    match tokio::fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str::<serde_json::Value>(&contents).is_ok(),
        Err(_) => false,
    }
}

/// Check if a file exists.
async fn check_file_exists(path: &str) -> bool {
    tokio::fs::metadata(path).await.is_ok()
}

/// Check if bin directory exists and count entries.
async fn check_bin_dir(path: &str) -> BinDirCheck {
    match tokio::fs::read_dir(path).await {
        Ok(mut entries) => {
            let mut count = 0;
            while entries.next_entry().await.ok().flatten().is_some() {
                count += 1;
            }
            BinDirCheck {
                exists: true,
                count,
            }
        }
        Err(_) => BinDirCheck {
            exists: false,
            count: 0,
        },
    }
}

/// Extract a clean version number from a version string.
///
/// Examples:
///   "git version 2.47.1" -> "2.47.1"
///   "jq-1.7.1" -> "1.7.1"
///   "v22.14.0" -> "22.14.0"
///   "cargo 1.86.0 (abc123 2026-01-01)" -> "1.86.0"
///   "gh version 2.67.0 (2026-01-01)" -> "2.67.0"
///   "openspec 0.4.0" -> "0.4.0"
///   "bd 0.8.2" -> "0.8.2"
fn extract_version(raw: &str) -> String {
    // Take only the first line.
    let line = raw.lines().next().unwrap_or(raw);

    // Look for a semver-like pattern: digits.digits.digits (optional -suffix).
    for word in line.split_whitespace() {
        let trimmed = word.trim_start_matches('v').trim_start_matches("jq-");
        if is_version_like(trimmed) {
            // Return just the version part (before any parenthetical).
            return trimmed.to_string();
        }
    }

    // Fallback: return the whole first line trimmed.
    line.to_string()
}

/// Returns true if the string starts with a digit and contains at least one dot.
fn is_version_like(s: &str) -> bool {
    s.starts_with(|c: char| c.is_ascii_digit()) && s.contains('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_version() {
        assert_eq!(extract_version("git version 2.47.1"), "2.47.1");
        assert_eq!(extract_version("jq-1.7.1"), "1.7.1");
        assert_eq!(extract_version("v22.14.0"), "22.14.0");
        assert_eq!(
            extract_version("cargo 1.86.0 (abc123 2026-01-01)"),
            "1.86.0"
        );
        assert_eq!(extract_version("gh version 2.67.0 (2026-01-01)"), "2.67.0");
        assert_eq!(extract_version("openspec 0.4.0"), "0.4.0");
        assert_eq!(extract_version("bd 0.8.2"), "0.8.2");
    }
}
