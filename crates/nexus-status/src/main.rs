use serde::Deserialize;

// ── ANSI colors ──────────────────────────────────────────────────────────────
const RESET: &str = "\x1b[0m";
const PROJ: &str = "\x1b[38;5;117m"; // sky blue
const GIT: &str = "\x1b[38;5;150m"; // soft green
const GIT_DIRTY: &str = "\x1b[38;5;215m"; // peach
const CTX_HIGH: &str = "\x1b[38;5;158m"; // mint  (< 50%)
const CTX_MED: &str = "\x1b[38;5;215m"; // orange (50-80%)
const CTX_LOW: &str = "\x1b[38;5;203m"; // red    (> 80%)
const SPEC: &str = "\x1b[38;5;216m"; // salmon
const DIM: &str = "\x1b[38;5;240m"; // gray

// ── Nexus-agent /statusline types ────────────────────────────────────────────

#[derive(Deserialize)]
struct StatuslineResponse {
    sessions: Vec<StatuslineSession>,
    machine: Option<Machine>,
}

#[derive(Deserialize)]
struct StatuslineSession {
    project: Option<String>,
    #[allow(dead_code)]
    status: Option<String>,
    model: Option<String>,
    spec: Option<String>,
}

#[derive(Deserialize)]
struct Machine {
    cpu_percent: f32,
    mem_percent: f32,
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

// ── Rendering helpers ─────────────────────────────────────────────────────────

/// Map 0–100 → one of 8 block chars.
fn bar_char(pct: f32) -> char {
    const BARS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
    let idx = ((pct * 7.0) / 100.0).round() as usize;
    BARS[idx.min(7)]
}

/// Color for a usage percentage (higher = worse).
fn usage_color(pct: f32) -> &'static str {
    if pct < 50.0 {
        CTX_HIGH
    } else if pct < 80.0 {
        CTX_MED
    } else {
        CTX_LOW
    }
}

/// Shorten "Claude Sonnet 4.5" → "Sonnet" (second word, or full string).
fn shorten_model(model: &str) -> &str {
    let mut parts = model.split_whitespace();
    parts.next(); // skip first word ("Claude")
    parts.next().unwrap_or(model)
}

// ── Fetch ─────────────────────────────────────────────────────────────────────

fn fetch_statusline() -> Option<StatuslineResponse> {
    let client = reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(1))
        .build()
        .ok()?;
    let resp = client.get("http://localhost:7401/statusline").send().ok()?;
    resp.json().ok()
}

// ── Render ────────────────────────────────────────────────────────────────────

fn print_statusline(
    project_code: &str,
    git: &Option<GitInfo>,
    data: &StatuslineResponse,
    session: Option<&StatuslineSession>,
) {
    let session_count = data.sessions.len();
    let mut parts: Vec<String> = Vec::new();

    // Session count indicator
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
    if let Some(g) = git {
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

    // Active spec
    if let Some(sess) = session {
        if let Some(spec) = &sess.spec {
            if !spec.is_empty() {
                parts.push(format!("⚡ {SPEC}{spec}{RESET}"));
            }
        }

        // Model
        if let Some(model) = &sess.model {
            if !model.is_empty() {
                parts.push(format!("{DIM}{}{RESET}", shorten_model(model)));
            }
        }
    }

    // CPU metric (only when non-trivial)
    if let Some(machine) = &data.machine {
        let cpu = machine.cpu_percent;
        if cpu > 0.0 {
            let color = usage_color(cpu);
            let bar = bar_char(cpu);
            parts.push(format!(
                "{color}{bar}{RESET} {DIM}CPU{RESET} {color}{:.0}%{RESET}",
                cpu
            ));
        }

        let mem = machine.mem_percent;
        let color = usage_color(mem);
        let bar = bar_char(mem);
        parts.push(format!(
            "{color}{bar}{RESET} {DIM}MEM{RESET} {color}{:.0}%{RESET}",
            mem
        ));
    }

    print!("{}", parts.join("  "));
}

// ── Main ──────────────────────────────────────────────────────────────────────

fn main() {
    let project_dir = std::env::var("CLAUDE_PROJECT_DIR").unwrap_or_else(|_| {
        std::env::current_dir()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string()
    });
    let project_code = derive_project_code(&project_dir);

    let git = get_git_status(&project_dir);

    let Some(data) = fetch_statusline() else {
        // Offline fallback — show local info only
        print!("{DIM}◌{RESET}  {PROJ}{project_code}{RESET}");
        if let Some(g) = &git {
            if g.dirty {
                print!("  {GIT_DIRTY}{}*{RESET}", g.branch);
            } else {
                print!("  {GIT}{}{RESET}", g.branch);
            }
        }
        return;
    };

    let session = data
        .sessions
        .iter()
        .find(|s| s.project.as_deref() == Some(&project_code));

    print_statusline(&project_code, &git, &data, session);
}
