//! Command Registry Service
//!
//! Discovers and caches available Claude Code slash commands from
//! `~/.claude/commands/`. Scans recursively for `.md` files, derives
//! namespace/name from the directory structure, reads the first line of each
//! file for a description, and applies a static tier + cost categorization
//! table for known commands.
//!
//! ## Naming convention
//!
//! - `~/.claude/commands/apply.md`           → full_name = "apply"
//! - `~/.claude/commands/audit/code.md`      → full_name = "audit:code"
//! - `~/.claude/commands/plan/roadmap.md`    → full_name = "plan:roadmap"
//!
//! Subdirectories named `references/` (used for reference docs, not commands)
//! and files named `README.md` are excluded.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, warn};

use nexus_core::command::{CommandInfo, CommandTier, CostCategory};

// ---------------------------------------------------------------------------
// Static categorization
// ---------------------------------------------------------------------------

/// Return the (tier, cost) classification for a known command.
/// Unknown commands default to `(Analysis, Medium)` — a safe middle ground.
fn categorize(full_name: &str) -> (CommandTier, CostCategory) {
    match full_name {
        // Status tier — fast, read-only
        "next" | "recon" | "workflow:check" => (CommandTier::Status, CostCategory::Low),

        // Analysis tier — longer running
        "audit:code" | "audit:arch-review" | "audit:services" | "audit:arewedone"
        | "audit:preflight" => (CommandTier::Analysis, CostCategory::High),
        "monitor:costs" | "monitor:triage" => (CommandTier::Analysis, CostCategory::Low),
        "monitor:sentry" | "monitor:logs" | "monitor:posthog" => {
            (CommandTier::Analysis, CostCategory::Medium)
        }
        "ci:gh" => (CommandTier::Analysis, CostCategory::Medium),
        "project:discover" | "project:explore" => (CommandTier::Analysis, CostCategory::High),

        // Action tier — mutates state
        "apply" | "apply:all" => (CommandTier::Action, CostCategory::High),
        "feature" => (CommandTier::Action, CostCategory::Medium),
        "commit" | "p2p" => (CommandTier::Action, CostCategory::Medium),
        "test:e2e" | "test:fix-types" | "test:run-quality-gates" => {
            (CommandTier::Action, CostCategory::Medium)
        }
        "review:local" => (CommandTier::Action, CostCategory::Low),

        // Default: analysis/medium (safe middle ground)
        _ => (CommandTier::Analysis, CostCategory::Medium),
    }
}

// ---------------------------------------------------------------------------
// Scanning logic
// ---------------------------------------------------------------------------

/// Read the first non-empty line from a file, stripping a leading `#` prefix.
/// Returns an empty string on any IO error.
fn read_description(path: &Path) -> String {
    let content = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            warn!(path = %path.display(), err = %e, "failed to read command file");
            return String::new();
        }
    };

    let first_line = content.lines().find(|l| !l.trim().is_empty()).unwrap_or("");

    // Strip a leading `#` (markdown heading) and surrounding whitespace.
    first_line.trim().trim_start_matches('#').trim().to_owned()
}

/// Recursively scan `dir` for `.md` command files.
///
/// `base` is the root commands directory (used to derive namespace from the
/// relative path). `namespace` is the current namespace derived from the
/// directory path relative to `base`.
fn scan_dir(dir: &Path, base: &Path, commands: &mut Vec<CommandInfo>) {
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            warn!(dir = %dir.display(), err = %e, "failed to read commands directory");
            return;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                warn!(path = %path.display(), err = %e, "failed to get file type");
                continue;
            }
        };

        let file_name = entry.file_name();
        let name_str = file_name.to_string_lossy();

        if file_type.is_dir() {
            // Skip `references/` subdirectories — they hold reference docs, not commands.
            if name_str == "references" {
                debug!(path = %path.display(), "skipping references/ directory");
                continue;
            }
            scan_dir(&path, base, commands);
        } else if file_type.is_file() {
            // Only process `.md` files; skip `README.md`.
            if !name_str.ends_with(".md") {
                continue;
            }
            if name_str.eq_ignore_ascii_case("README.md") {
                continue;
            }

            // Derive namespace from the relative path between base and the
            // file's parent directory.
            let parent = path.parent().unwrap_or(base);
            let namespace = if parent == base {
                String::new()
            } else {
                // Build a colon-separated namespace from the path components
                // between base and the file's parent.
                match parent.strip_prefix(base) {
                    Ok(rel) => rel
                        .components()
                        .map(|c| c.as_os_str().to_string_lossy().into_owned())
                        .collect::<Vec<_>>()
                        .join(":"),
                    Err(_) => String::new(),
                }
            };

            // Command name is the file stem (filename without `.md`).
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();

            if name.is_empty() {
                continue;
            }

            let full_name = if namespace.is_empty() {
                name.clone()
            } else {
                format!("{}:{}", namespace, name)
            };

            let description = read_description(&path);
            let (tier, cost) = categorize(&full_name);

            debug!(full_name, "discovered command");

            commands.push(CommandInfo {
                name,
                namespace,
                full_name,
                description,
                tier,
                cost,
            });
        }
    }
}

/// Synchronous filesystem scan — called once at startup (not perf-critical).
///
/// Returns an empty `Vec` if `dir` does not exist.
fn scan_commands(dir: &Path) -> Vec<CommandInfo> {
    if !dir.exists() {
        debug!(dir = %dir.display(), "commands directory does not exist — returning empty list");
        return Vec::new();
    }

    let mut commands = Vec::new();
    scan_dir(dir, dir, &mut commands);

    // Sort for deterministic ordering: namespace first, then name.
    commands.sort_by(|a, b| {
        a.namespace
            .cmp(&b.namespace)
            .then_with(|| a.name.cmp(&b.name))
    });

    debug!(count = commands.len(), dir = %dir.display(), "command scan complete");
    commands
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

struct CommandRegistryInner {
    commands: Vec<CommandInfo>,
    /// Maps full_name → index into `commands`.
    by_name: HashMap<String, usize>,
}

impl CommandRegistryInner {
    fn from_commands(commands: Vec<CommandInfo>) -> Self {
        let by_name = commands
            .iter()
            .enumerate()
            .map(|(i, c)| (c.full_name.clone(), i))
            .collect();
        Self { commands, by_name }
    }
}

/// Clone-friendly command registry backed by a shared `Arc<RwLock<...>>`.
///
/// All clones share the same underlying data, so a `refresh()` call on any
/// clone is immediately visible to all others.
#[derive(Clone)]
pub struct CommandRegistry {
    inner: Arc<RwLock<CommandRegistryInner>>,
    commands_dir: PathBuf,
}

impl CommandRegistry {
    /// Create a new registry, scanning `commands_dir` immediately.
    ///
    /// Defaults to `~/.claude/commands/` when called via [`CommandRegistry::with_default_dir`].
    pub fn new(commands_dir: PathBuf) -> Self {
        let commands = scan_commands(&commands_dir);
        Self {
            inner: Arc::new(RwLock::new(CommandRegistryInner::from_commands(commands))),
            commands_dir,
        }
    }

    /// Convenience constructor using the default `~/.claude/commands/` path.
    pub fn with_default_dir() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_owned());
        let dir = PathBuf::from(home).join(".claude").join("commands");
        Self::new(dir)
    }

    /// Return all commands, optionally filtered by namespace and/or tier.
    pub async fn list(
        &self,
        namespace: Option<&str>,
        tier: Option<CommandTier>,
    ) -> Vec<CommandInfo> {
        let guard = self.inner.read().await;
        guard
            .commands
            .iter()
            .filter(|c| {
                namespace.is_none_or(|ns| c.namespace == ns) && tier.is_none_or(|t| c.tier == t)
            })
            .cloned()
            .collect()
    }

    /// Look up a command by its full name (e.g., `"audit:code"` or `"apply"`).
    pub async fn get(&self, full_name: &str) -> Option<CommandInfo> {
        let guard = self.inner.read().await;
        guard
            .by_name
            .get(full_name)
            .and_then(|&idx| guard.commands.get(idx))
            .cloned()
    }

    /// Return the filesystem path for a command by full_name.
    /// E.g. `"audit:code"` → `commands_dir/audit/code.md`
    /// Returns `None` if the file does not exist.
    pub fn get_path(&self, full_name: &str) -> Option<PathBuf> {
        let parts: Vec<&str> = full_name.split(':').collect();
        let mut path = self.commands_dir.clone();
        for part in &parts {
            path = path.join(part);
        }
        path.set_extension("md");
        if path.exists() { Some(path) } else { None }
    }

    /// Return the commands directory path.
    pub fn commands_dir(&self) -> &PathBuf {
        &self.commands_dir
    }

    /// Re-scan the commands directory and replace the cached command list.
    pub async fn refresh(&self) {
        let commands = scan_commands(&self.commands_dir);
        let mut guard = self.inner.write().await;
        *guard = CommandRegistryInner::from_commands(commands);
        debug!(dir = %self.commands_dir.display(), "command registry refreshed");
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_cmd_file(dir: &Path, rel_path: &str, content: &str) {
        let full = dir.join(rel_path);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(full, content).unwrap();
    }

    #[test]
    fn scan_empty_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let commands = scan_commands(tmp.path());
        assert!(commands.is_empty());
    }

    #[test]
    fn scan_missing_dir_returns_empty() {
        let commands = scan_commands(Path::new("/nonexistent/path/commands"));
        assert!(commands.is_empty());
    }

    #[test]
    fn scan_top_level_command() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "apply.md", "# Apply Changes\nSome description.");

        let commands = scan_commands(tmp.path());
        assert_eq!(commands.len(), 1);
        let cmd = &commands[0];
        assert_eq!(cmd.name, "apply");
        assert_eq!(cmd.namespace, "");
        assert_eq!(cmd.full_name, "apply");
        assert_eq!(cmd.description, "Apply Changes");
    }

    #[test]
    fn scan_namespaced_command() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(
            tmp.path(),
            "audit/code.md",
            "# Audit Code\nDoes a code audit.",
        );

        let commands = scan_commands(tmp.path());
        assert_eq!(commands.len(), 1);
        let cmd = &commands[0];
        assert_eq!(cmd.name, "code");
        assert_eq!(cmd.namespace, "audit");
        assert_eq!(cmd.full_name, "audit:code");
        assert_eq!(cmd.description, "Audit Code");
    }

    #[test]
    fn scan_excludes_readme() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "README.md", "# Commands Index");
        make_cmd_file(tmp.path(), "apply.md", "# Apply");

        let commands = scan_commands(tmp.path());
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].full_name, "apply");
    }

    #[test]
    fn scan_excludes_references_dir() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "references/some-ref.md", "# Reference");
        make_cmd_file(tmp.path(), "apply.md", "# Apply");

        let commands = scan_commands(tmp.path());
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].full_name, "apply");
    }

    #[test]
    fn scan_description_strips_hash_prefix() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "next.md", "# Suggest Next Action\nMore text.");

        let commands = scan_commands(tmp.path());
        assert_eq!(commands[0].description, "Suggest Next Action");
    }

    #[test]
    fn scan_description_no_hash() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "next.md", "Plain description line.");

        let commands = scan_commands(tmp.path());
        assert_eq!(commands[0].description, "Plain description line.");
    }

    #[test]
    fn categorize_known_status_command() {
        let (tier, cost) = categorize("next");
        assert_eq!(tier, CommandTier::Status);
        assert_eq!(cost, CostCategory::Low);
    }

    #[test]
    fn categorize_known_action_command() {
        let (tier, cost) = categorize("apply");
        assert_eq!(tier, CommandTier::Action);
        assert_eq!(cost, CostCategory::High);
    }

    #[test]
    fn categorize_unknown_defaults_to_analysis_medium() {
        let (tier, cost) = categorize("some:unknown:command");
        assert_eq!(tier, CommandTier::Analysis);
        assert_eq!(cost, CostCategory::Medium);
    }

    #[tokio::test]
    async fn registry_list_all() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "apply.md", "# Apply");
        make_cmd_file(tmp.path(), "audit/code.md", "# Audit Code");

        let registry = CommandRegistry::new(tmp.path().to_path_buf());
        let all = registry.list(None, None).await;
        assert_eq!(all.len(), 2);
    }

    #[tokio::test]
    async fn registry_list_by_namespace() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "apply.md", "# Apply");
        make_cmd_file(tmp.path(), "audit/code.md", "# Audit Code");
        make_cmd_file(tmp.path(), "audit/arch-review.md", "# Arch Review");

        let registry = CommandRegistry::new(tmp.path().to_path_buf());
        let audit = registry.list(Some("audit"), None).await;
        assert_eq!(audit.len(), 2);
        assert!(audit.iter().all(|c| c.namespace == "audit"));
    }

    #[tokio::test]
    async fn registry_list_by_tier() {
        let tmp = TempDir::new().unwrap();
        // "next" → Status tier
        make_cmd_file(tmp.path(), "next.md", "# Next");
        // "apply" → Action tier
        make_cmd_file(tmp.path(), "apply.md", "# Apply");

        let registry = CommandRegistry::new(tmp.path().to_path_buf());
        let status_cmds = registry.list(None, Some(CommandTier::Status)).await;
        assert_eq!(status_cmds.len(), 1);
        assert_eq!(status_cmds[0].full_name, "next");
    }

    #[tokio::test]
    async fn registry_get_found() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "audit/code.md", "# Audit Code");

        let registry = CommandRegistry::new(tmp.path().to_path_buf());
        let cmd = registry.get("audit:code").await;
        assert!(cmd.is_some());
        assert_eq!(cmd.unwrap().full_name, "audit:code");
    }

    #[tokio::test]
    async fn registry_get_not_found() {
        let tmp = TempDir::new().unwrap();
        let registry = CommandRegistry::new(tmp.path().to_path_buf());
        let cmd = registry.get("nonexistent:command").await;
        assert!(cmd.is_none());
    }

    #[tokio::test]
    async fn registry_refresh_picks_up_new_files() {
        let tmp = TempDir::new().unwrap();
        make_cmd_file(tmp.path(), "apply.md", "# Apply");

        let registry = CommandRegistry::new(tmp.path().to_path_buf());
        assert_eq!(registry.list(None, None).await.len(), 1);

        // Add a new file and refresh.
        make_cmd_file(tmp.path(), "commit.md", "# Commit");
        registry.refresh().await;

        assert_eq!(registry.list(None, None).await.len(), 2);
    }
}
