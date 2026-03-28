use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

// ── ANSI colors ──────────────────────────────────────────────────────────────
const RESET: &str = "\x1b[0m";
const PROJ: &str = "\x1b[38;5;117m"; // sky blue
const GIT: &str = "\x1b[38;5;150m"; // soft green
const GIT_DIRTY: &str = "\x1b[38;5;215m"; // peach
const CTX_HIGH: &str = "\x1b[38;5;158m"; // mint   (>40% remaining)
const CTX_MED: &str = "\x1b[38;5;215m"; // orange (20-40% remaining)
const CTX_LOW: &str = "\x1b[38;5;203m"; // red    (<20% remaining)
const SPEC: &str = "\x1b[38;5;216m"; // salmon
const DIM: &str = "\x1b[38;5;240m"; // gray
const COST: &str = "\x1b[38;5;222m"; // light gold

// ── CC stdin types ────────────────────────────────────────────────────────────

#[derive(Deserialize, Default)]
struct CcInput {
    #[serde(default)]
    context_window: Option<CcContextWindow>,
    #[serde(default)]
    model: Option<CcModel>,
}

#[derive(Deserialize)]
struct CcContextWindow {
    remaining_percentage: Option<f64>,
}

#[derive(Deserialize)]
struct CcModel {
    display_name: String,
}

fn read_stdin_input() -> CcInput {
    let mut buf = String::new();
    let _ = std::io::stdin().read_to_string(&mut buf);
    if buf.is_empty() {
        return CcInput::default();
    }
    serde_json::from_str(&buf).unwrap_or_default()
}

// ── Nexus-agent /statusline types ────────────────────────────────────────────

#[derive(Deserialize)]
struct StatuslineResponse {
    sessions: Vec<StatuslineSession>,
}

#[derive(Deserialize)]
struct StatuslineSession {
    project: Option<String>,
    #[allow(dead_code)]
    status: Option<String>,
    model: Option<String>,
    spec: Option<String>,
}

// ── Local git info ────────────────────────────────────────────────────────────

struct GitInfo {
    branch: String,
    dirty: bool,
    ahead: u32,
}

fn get_git_status(dir: &str) -> Option<GitInfo> {
    let branch_out = std::process::Command::new("git")
        .args(["-C", dir, "branch", "--show-current"])
        .output()
        .ok()?;
    let branch = String::from_utf8_lossy(&branch_out.stdout)
        .trim()
        .to_string();
    if branch.is_empty() {
        return None;
    }

    let porcelain = std::process::Command::new("git")
        .args(["-C", dir, "status", "--porcelain"])
        .output()
        .ok()?;
    let dirty = !porcelain.stdout.is_empty();

    let ahead = std::process::Command::new("git")
        .args(["-C", dir, "rev-list", "--count", "@{upstream}..HEAD"])
        .output()
        .ok()
        .and_then(|o| {
            String::from_utf8_lossy(&o.stdout)
                .trim()
                .parse::<u32>()
                .ok()
        })
        .unwrap_or(0);

    Some(GitInfo {
        branch,
        dirty,
        ahead,
    })
}

// ── Project code derivation ───────────────────────────────────────────────────

fn derive_project_code(dir: &str) -> String {
    // ~/.claude or paths containing /.claude → "cc"
    if dir.contains("/.claude") || dir.ends_with("/.claude") {
        return "cc".to_string();
    }
    // ~/dev/oo/... → "oo"
    if let Some(idx) = dir.find("/dev/") {
        let rest = &dir[idx + 5..];
        if let Some(end) = rest.find('/') {
            return rest[..end].to_string();
        }
        return rest.to_string();
    }
    // Fallback: basename
    std::path::Path::new(dir)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "?".to_string())
}

// ── Model name helpers ────────────────────────────────────────────────────────

/// Shorten "Claude Sonnet 4.5" → "Sonnet" (second word, or full string).
fn shorten_model(model: &str) -> &str {
    let mut parts = model.split_whitespace();
    parts.next(); // skip first word ("Claude")
    parts.next().unwrap_or(model)
}

// ── Context window rendering ──────────────────────────────────────────────────

fn render_context(remaining_pct: f64) -> String {
    let pct = remaining_pct.round() as u8;
    let suffix = format!("{pct}%");
    render_gauge("CTX", pct, &suffix)
}

// ── Time helpers ──────────────────────────────────────────────────────────────

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Countdown until end of current 5-hour block (aligned to midnight UTC)
fn block_reset_countdown() -> String {
    let now = now_secs();
    let block_duration = 5 * 3600u64;
    let block_end = ((now / block_duration) + 1) * block_duration;
    let remaining = block_end - now;
    let hours = remaining / 3600;
    let mins = (remaining % 3600) / 60;
    format!("{}:{:02}h", hours, mins)
}

/// Countdown until next Sunday midnight UTC (weekly reset)
fn weekly_reset_countdown() -> String {
    let now = now_secs();
    let days_since_epoch = (now / 86400) as i32;
    let dow = (days_since_epoch + 4) % 7; // 0 = Sunday
    let days_until = if dow == 0 { 7 } else { 7 - dow };

    if days_until >= 2 {
        format!("{}d", days_until)
    } else {
        let secs_into_today = now % 86400;
        let secs_until = (days_until as u64) * 86400 - secs_into_today;
        format!("{}:{:02}h", secs_until / 3600, (secs_until % 3600) / 60)
    }
}

// ── Cost rendering ────────────────────────────────────────────────────────────

// ── Gauge rendering (shared by CTX, SES, WKL) ───────────────────────────────

/// Render a labeled gauge bar. `pct` is 0-100 representing the "good" direction:
/// - For CTX: pct = remaining (higher = better)
/// - For SES/WKL: pct = 100 - usage_pct (higher = more budget left)
fn render_gauge(label: &str, pct: u8, suffix: &str) -> String {
    let color = if pct <= 20 { CTX_LOW } else if pct <= 40 { CTX_MED } else { CTX_HIGH };
    let filled = ((pct as usize) * 7) / 100;
    let empty = 7 - filled;
    let bar = format!("{}{}", "═".repeat(filled), "─".repeat(empty));
    format!("{DIM}{label}{RESET} {color}{bar} {suffix}{RESET}")
}

fn render_session_usage(utilization: f64, resets_at: Option<&str>) -> String {
    let remaining_pct = (100.0 - utilization).max(0.0) as u8;
    let countdown = resets_at
        .and_then(|t| parse_timestamp(t))
        .map(|target| {
            let now = now_secs();
            if target > now {
                let rem = target - now;
                format!("↻{}:{:02}h", rem / 3600, (rem % 3600) / 60)
            } else {
                "↻now".to_string()
            }
        })
        .unwrap_or_else(|| block_reset_countdown_str());
    let suffix = format!("{:.0}% {countdown}", utilization);
    render_gauge("SES", remaining_pct, &suffix)
}

fn render_weekly_usage(utilization: f64, resets_at: Option<&str>) -> String {
    let remaining_pct = (100.0 - utilization).max(0.0) as u8;
    let countdown = resets_at
        .and_then(|t| parse_timestamp(t))
        .map(|target| {
            let now = now_secs();
            if target > now {
                let rem = target - now;
                if rem >= 86400 * 2 {
                    format!("↻{}d", rem / 86400)
                } else {
                    format!("↻{}:{:02}h", rem / 3600, (rem % 3600) / 60)
                }
            } else {
                "↻now".to_string()
            }
        })
        .unwrap_or_else(|| weekly_reset_countdown());
    let suffix = format!("{:.0}% {countdown}", utilization);
    render_gauge("WKL", remaining_pct, &suffix)
}

fn block_reset_countdown_str() -> String {
    let countdown = block_reset_countdown();
    format!("↻{countdown}")
}

// ── Anthropic Usage API ──────────────────────────────────────────────────────

/// API response from https://api.anthropic.com/api/oauth/usage
#[derive(Debug, Clone, Deserialize, Serialize)]
struct UsageResponse {
    five_hour: Option<UsagePeriod>,
    seven_day: Option<UsagePeriod>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct UsagePeriod {
    utilization: f64,
    resets_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct CachedUsage {
    fetched_at: u64,
    data: UsageResponse,
}

#[derive(Debug, Deserialize)]
struct Credentials {
    #[serde(rename = "claudeAiOauth")]
    claude_ai_oauth: Option<OAuthCreds>,
}

#[derive(Debug, Deserialize)]
struct OAuthCreds {
    #[serde(rename = "accessToken")]
    access_token: String,
    #[serde(rename = "expiresAt")]
    expires_at: Option<u64>,
}

const USAGE_CACHE_TTL: u64 = 300; // 5 minutes

fn get_api_usage() -> Option<UsageResponse> {
    let cache_path = usage_cache_path()?;

    // Check cache (5 min TTL)
    if let Ok(content) = fs::read_to_string(&cache_path) {
        if let Ok(cached) = serde_json::from_str::<CachedUsage>(&content) {
            if now_secs() - cached.fetched_at < USAGE_CACHE_TTL {
                return Some(cached.data);
            }
        }
    }

    // Fetch fresh
    let token = read_access_token()?;
    let fresh = fetch_usage_curl(&token)?;

    // Write cache
    let cached = CachedUsage { fetched_at: now_secs(), data: fresh.clone() };
    if let Ok(json) = serde_json::to_string(&cached) {
        let _ = fs::write(&cache_path, json);
    }

    Some(fresh)
}

fn usage_cache_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    Some(PathBuf::from(home).join(".claude/scripts/state/usage-cache.json"))
}

fn read_access_token() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    let path = PathBuf::from(home).join(".claude/.credentials.json");
    let content = fs::read_to_string(&path).ok()?;
    let creds: Credentials = serde_json::from_str(&content).ok()?;
    let oauth = creds.claude_ai_oauth?;

    // Check expiry
    if let Some(expires_at) = oauth.expires_at {
        if now_secs() * 1000 > expires_at {
            return None;
        }
    }
    Some(oauth.access_token)
}

fn fetch_usage_curl(token: &str) -> Option<UsageResponse> {
    let output = std::process::Command::new("curl")
        .args([
            "-s", "--max-time", "2",
            "-H", "Accept: application/json",
            "-H", &format!("Authorization: Bearer {}", token),
            "-H", "anthropic-beta: oauth-2025-04-20",
            "https://api.anthropic.com/api/oauth/usage",
        ])
        .output()
        .ok()?;

    if !output.status.success() { return None; }
    let body = String::from_utf8(output.stdout).ok()?;
    if body.contains("\"error\"") { return None; }
    serde_json::from_str(&body).ok()
}

/// Parse ISO8601 timestamp (e.g. "2026-01-13T15:58:47.496Z") to unix seconds
fn parse_timestamp(ts: &str) -> Option<u64> {
    let clean = ts.trim_end_matches('Z');
    let parts: Vec<&str> = clean.split('T').collect();
    if parts.len() != 2 { return None; }
    let date_parts: Vec<i32> = parts[0].split('-').filter_map(|s| s.parse().ok()).collect();
    let time_str = parts[1].split('.').next()?;
    let time_parts: Vec<u64> = time_str.split(':').filter_map(|s| s.parse().ok()).collect();
    if date_parts.len() != 3 || time_parts.len() != 3 { return None; }
    let (year, month, day) = (date_parts[0], date_parts[1] as u32, date_parts[2] as u32);
    let (hour, min, sec) = (time_parts[0], time_parts[1], time_parts[2]);
    let days = days_from_civil(year, month, day);
    Some((days as u64) * 86400 + hour * 3600 + min * 60 + sec)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i32 {
    let y = if month <= 2 { year - 1 } else { year };
    let m = if month <= 2 { month + 12 } else { month };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u32;
    let doy = (153 * (m - 3) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i32 - 719468
}

// ── Fetch nexus-agent ─────────────────────────────────────────────────────────

fn fetch_statusline() -> Option<StatuslineResponse> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .ok()?;
    let resp = client.get("http://localhost:7401/statusline").send().ok()?;
    resp.json().ok()
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    // Read CC stdin JSON (non-blocking — empty when not piped by CC)
    let cc_input = read_stdin_input();

    let project_dir = std::env::var("CLAUDE_PROJECT_DIR").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });
    let project_code = derive_project_code(&project_dir);
    let git = get_git_status(&project_dir);

    // Resolve model name: prefer CC stdin, fall back to nexus-agent session
    let cc_model = cc_input
        .model
        .as_ref()
        .map(|m| shorten_model(&m.display_name).to_string());

    // Attempt nexus-agent fetch (optional)
    let nexus_data = fetch_statusline();
    let session = nexus_data.as_ref().and_then(|d| {
        d.sessions
            .iter()
            .find(|s| s.project.as_deref() == Some(&project_code))
    });

    let model_name = cc_model
        .or_else(|| {
            session
                .and_then(|s| s.model.as_deref())
                .map(|m| shorten_model(m).to_string())
        })
        .unwrap_or_default();

    // ── Build parts ──────────────────────────────────────────────────────────

    let mut parts: Vec<String> = Vec::new();

    // Session count indicator
    let session_count = nexus_data.as_ref().map(|d| d.sessions.len()).unwrap_or(0);
    if session_count > 1 {
        parts.push(format!("{DIM}◉{RESET} {session_count}"));
    } else if session_count == 1 {
        parts.push(format!("{DIM}◉{RESET}"));
    } else {
        parts.push(format!("{DIM}◌{RESET}"));
    }

    // Project code
    parts.push(format!("{PROJ}{project_code}{RESET}"));

    // Git branch
    if let Some(g) = &git {
        let branch_part = if g.dirty {
            format!("{GIT_DIRTY}{}*{RESET}", g.branch)
        } else {
            format!("{GIT}{}{RESET}", g.branch)
        };
        let branch_str = if g.ahead > 0 {
            format!("{branch_part}  {DIM}↑{}{RESET}", g.ahead)
        } else {
            branch_part
        };
        parts.push(branch_str);
    }

    // Active spec (from nexus-agent session)
    if let Some(sess) = session {
        if let Some(spec) = &sess.spec {
            if !spec.is_empty() {
                parts.push(format!("⚡ {SPEC}{spec}{RESET}"));
            }
        }
    }

    // Context window (from CC stdin)
    if let Some(remaining) = cc_input
        .context_window
        .as_ref()
        .and_then(|c| c.remaining_percentage)
    {
        parts.push(render_context(remaining));
    }

    // Session (5hr) and Weekly (7d) usage from Anthropic API (cached 5min)
    if let Some(usage) = get_api_usage() {
        if let Some(five_hour) = &usage.five_hour {
            parts.push(render_session_usage(
                five_hour.utilization,
                five_hour.resets_at.as_deref(),
            ));
        }
        if let Some(seven_day) = &usage.seven_day {
            parts.push(render_weekly_usage(
                seven_day.utilization,
                seven_day.resets_at.as_deref(),
            ));
        }
    }

    print!("{}", parts.join("  "));
}
