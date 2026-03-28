use serde::Deserialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read};
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
    cost: Option<CcCost>,
    #[serde(default)]
    model: Option<CcModel>,
}

#[derive(Deserialize)]
struct CcContextWindow {
    remaining_percentage: Option<f64>,
}

#[derive(Deserialize)]
struct CcCost {
    total_cost_usd: Option<f64>,
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
    let color = if pct <= 20 {
        CTX_LOW
    } else if pct <= 40 {
        CTX_MED
    } else {
        CTX_HIGH
    };

    // Progress bar: 7 chars wide, filled from left = remaining
    let filled = ((pct as usize) * 7) / 100;
    let empty = 7 - filled;
    let bar = format!("{}{}", "═".repeat(filled), "─".repeat(empty));

    format!("{DIM}CTX{RESET} {color}{bar} {pct}%{RESET}")
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

fn render_session_cost(cost_usd: f64) -> String {
    let countdown = block_reset_countdown();
    format!("{COST}${:.2}{RESET} {DIM}↻{countdown}{RESET}", cost_usd)
}

fn render_weekly_cost(cost: f64) -> String {
    let countdown = weekly_reset_countdown();
    format!("{COST}${:.0}{RESET} {DIM}↻{countdown}{RESET}", cost)
}

// ── JSONL scanning (weekly cost) ──────────────────────────────────────────────

/// Model pricing per million tokens
struct ModelPricing {
    input: f64,
    output: f64,
    cache_write: f64,
    cache_read: f64,
}

impl ModelPricing {
    fn for_model(model: &str) -> Self {
        if model.contains("opus") {
            Self {
                input: 5.0,
                output: 25.0,
                cache_write: 6.25,
                cache_read: 0.50,
            }
        } else if model.contains("haiku") {
            Self {
                input: 1.0,
                output: 5.0,
                cache_write: 1.25,
                cache_read: 0.10,
            }
        } else {
            // Default: sonnet
            Self {
                input: 3.0,
                output: 15.0,
                cache_write: 3.75,
                cache_read: 0.30,
            }
        }
    }
}

#[derive(Deserialize)]
struct LogEntry {
    #[serde(rename = "type")]
    entry_type: Option<String>,
    timestamp: Option<String>,
    message: Option<LogMessage>,
}

#[derive(Deserialize)]
struct LogMessage {
    model: Option<String>,
    usage: Option<TokenUsage>,
}

#[derive(Deserialize)]
struct TokenUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

/// Parse ISO8601 timestamp (e.g. "2026-01-13T15:58:47.496Z") to unix seconds
fn parse_timestamp(ts: &str) -> Option<u64> {
    let clean = ts.trim_end_matches('Z');
    let parts: Vec<&str> = clean.split('T').collect();
    if parts.len() != 2 {
        return None;
    }
    let date_parts: Vec<i32> = parts[0].split('-').filter_map(|s| s.parse().ok()).collect();
    let time_str = parts[1].split('.').next()?;
    let time_parts: Vec<u64> = time_str.split(':').filter_map(|s| s.parse().ok()).collect();
    if date_parts.len() != 3 || time_parts.len() != 3 {
        return None;
    }
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

fn week_start_timestamp() -> u64 {
    let now = now_secs();
    let days_since_epoch = (now / 86400) as i32;
    let dow = (days_since_epoch + 4) % 7; // 0 = Sunday
    let week_start_days = days_since_epoch - dow;
    (week_start_days as u64) * 86400
}

fn calculate_cost(usage: &TokenUsage, model: &str) -> f64 {
    let pricing = ModelPricing::for_model(model);
    let input = usage.input_tokens.unwrap_or(0) as f64;
    let output = usage.output_tokens.unwrap_or(0) as f64;
    let cache_write = usage.cache_creation_input_tokens.unwrap_or(0) as f64;
    let cache_read = usage.cache_read_input_tokens.unwrap_or(0) as f64;
    (input * pricing.input
        + output * pricing.output
        + cache_write * pricing.cache_write
        + cache_read * pricing.cache_read)
        / 1_000_000.0
}

/// Pending assistant entry — last streaming chunk wins for deduplication
struct PendingAssistant {
    model: String,
    usage: TokenUsage,
    timestamp: Option<String>,
}

fn scan_jsonl_file(path: &PathBuf, since_timestamp: u64) -> f64 {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(_) => return 0.0,
    };
    let reader = BufReader::new(file);
    let mut total_cost = 0.0;
    let mut last_assistant: Option<PendingAssistant> = None;

    for line in reader.lines().flatten() {
        let entry: LogEntry = match serde_json::from_str(&line) {
            Ok(e) => e,
            Err(_) => continue,
        };
        let entry_type = entry.entry_type.as_deref().unwrap_or("");

        if entry_type == "assistant" {
            if let Some(msg) = entry.message {
                if let (Some(model), Some(usage)) = (msg.model, msg.usage) {
                    last_assistant = Some(PendingAssistant {
                        model,
                        usage,
                        timestamp: entry.timestamp,
                    });
                }
            }
        } else if entry_type == "user" || entry_type == "tool_result" {
            if let Some(cached) = last_assistant.take() {
                let in_range = cached
                    .timestamp
                    .as_ref()
                    .and_then(|ts| parse_timestamp(ts))
                    .map(|ts_secs| ts_secs >= since_timestamp)
                    .unwrap_or(true);
                if in_range {
                    total_cost += calculate_cost(&cached.usage, &cached.model);
                }
            }
        }
    }
    // Count any trailing assistant entry at EOF
    if let Some(cached) = last_assistant {
        let in_range = cached
            .timestamp
            .as_ref()
            .and_then(|ts| parse_timestamp(ts))
            .map(|ts_secs| ts_secs >= since_timestamp)
            .unwrap_or(true);
        if in_range {
            total_cost += calculate_cost(&cached.usage, &cached.model);
        }
    }
    total_cost
}

fn scan_weekly_cost() -> f64 {
    let since = week_start_timestamp();
    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return 0.0,
    };
    let projects_dir = PathBuf::from(home).join(".claude/projects");
    let mut total = 0.0;

    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            if let Ok(files) = fs::read_dir(&path) {
                for file_entry in files.flatten() {
                    let fp = file_entry.path();
                    if fp.extension().map(|e| e == "jsonl").unwrap_or(false) {
                        total += scan_jsonl_file(&fp, since);
                    }
                }
            }
        }
    }
    total
}

/// Return cached weekly cost (60-second TTL via /tmp file)
fn cached_weekly_cost() -> f64 {
    let cache_path = "/tmp/nexus-status-weekly-cache.json";

    let cache_fresh = std::fs::metadata(cache_path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.elapsed().ok())
        .map(|e| e.as_secs() < 60)
        .unwrap_or(false);

    if cache_fresh {
        if let Ok(content) = std::fs::read_to_string(cache_path) {
            if let Ok(cost) = content.trim().parse::<f64>() {
                return cost;
            }
        }
    }

    // Cache miss — scan JSONL files
    let cost = scan_weekly_cost();
    let _ = std::fs::write(cache_path, format!("{:.4}", cost));
    cost
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

    // Model
    if !model_name.is_empty() {
        parts.push(format!("{DIM}{model_name}{RESET}"));
    }

    // Context window (from CC stdin)
    if let Some(remaining) = cc_input
        .context_window
        .as_ref()
        .and_then(|c| c.remaining_percentage)
    {
        parts.push(render_context(remaining));
    }

    // Session cost in current 5-hour block (from CC stdin)
    if let Some(cost) = cc_input.cost.as_ref().and_then(|c| c.total_cost_usd) {
        parts.push(render_session_cost(cost));
    }

    // Weekly cost (JSONL scan, cached 60s)
    let weekly = cached_weekly_cost();
    if weekly > 0.01 {
        parts.push(render_weekly_cost(weekly));
    }

    print!("{}", parts.join("  "));
}
