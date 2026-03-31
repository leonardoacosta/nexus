use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Result;
use serde::{Deserialize, Serialize};

/// A resolved project location on disk.
#[derive(Debug, Clone)]
pub struct ProjectPath {
    /// Short project code, e.g. `"oo"`, `"nx"`.
    pub code: String,
    /// Human-readable project name, e.g. `"Otaku Odyssey"`.
    pub name: String,
    /// Absolute path to the project root.
    pub cwd: PathBuf,
}

/// Snapshot of a single openspec change — used for cross-project change detection.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SpecSnapshot {
    pub name: String,
    pub status: String,
    pub completed_tasks: u32,
    pub total_tasks: u32,
    pub last_modified: Option<String>,
}

/// Raw entry as stored in `~/.claude/scripts/config/projects.json`.
#[derive(Debug, Deserialize)]
struct RawProject {
    code: String,
    name: String,
    path: String,
}

#[derive(Debug, Deserialize)]
struct RawRegistry {
    projects: Vec<RawProject>,
}

/// Thin, cheaply-cloneable wrapper around the loaded project map.
///
/// Backed by an `Arc` so cloning is O(1) and all clones share the same data.
/// Thread-safe for concurrent reads — no interior mutability is needed since
/// the registry is immutable after construction.
#[derive(Debug, Clone)]
pub struct ProjectRegistry {
    inner: Arc<HashMap<String, ProjectPath>>,
}

impl ProjectRegistry {
    /// Load the registry from `~/.claude/scripts/config/projects.json`.
    ///
    /// Tilde expansion in `path` values is performed for `~` (home directory).
    /// If the file does not exist or cannot be parsed, an error is returned.
    pub fn load() -> Result<Self> {
        let path = Self::registry_path();

        tracing::debug!("Loading project registry from {}", path.display());

        let contents = std::fs::read_to_string(&path)
            .map_err(|e| anyhow::anyhow!("Failed to read {}: {e}", path.display()))?;

        let raw: RawRegistry = serde_json::from_str(&contents)
            .map_err(|e| anyhow::anyhow!("Failed to parse {}: {e}", path.display()))?;

        let map: HashMap<String, ProjectPath> = raw
            .projects
            .into_iter()
            .map(|p| {
                let cwd = expand_tilde(&p.path);
                let pp = ProjectPath {
                    code: p.code.clone(),
                    name: p.name,
                    cwd,
                };
                (p.code, pp)
            })
            .collect();

        tracing::debug!("Loaded {} projects from registry", map.len());

        Ok(Self {
            inner: Arc::new(map),
        })
    }

    /// Resolve a project code to its on-disk location.
    ///
    /// Lookup order:
    /// 1. Exact match in the loaded registry.
    /// 2. Fallback: `~/dev/<code>/` if that directory exists on this machine.
    ///
    /// Returns `None` if neither source produces a result.
    pub fn resolve(&self, code: &str) -> Option<ProjectPath> {
        if let Some(pp) = self.inner.get(code) {
            return Some(pp.clone());
        }

        // Fallback: ~/dev/<code>
        let fallback = crate::paths::home_dir().join("dev").join(code);
        if fallback.is_dir() {
            tracing::debug!(
                "Project '{}' not in registry; using fallback path {}",
                code,
                fallback.display()
            );
            return Some(ProjectPath {
                code: code.to_string(),
                name: code.to_string(),
                cwd: fallback,
            });
        }

        None
    }

    /// Return all registered projects.
    pub fn all(&self) -> Vec<ProjectPath> {
        self.inner.values().cloned().collect()
    }

    /// Create an empty registry with no projects (used as a fallback).
    pub fn load_empty() -> Self {
        Self {
            inner: Arc::new(HashMap::new()),
        }
    }

    /// Path to the projects registry JSON file.
    pub fn registry_path() -> PathBuf {
        crate::paths::home_dir().join(".claude/scripts/config/projects.json")
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Expand a leading `~` to the current user's home directory.
fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        crate::paths::home_dir().join(rest)
    } else if path == "~" {
        crate::paths::home_dir()
    } else {
        PathBuf::from(path)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
impl ProjectRegistry {
    /// Construct a registry directly from a pre-built map (test helper only).
    fn from_map(map: HashMap<String, ProjectPath>) -> Self {
        Self {
            inner: Arc::new(map),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_registry(entries: &[(&str, &str, &str)]) -> ProjectRegistry {
        let map: HashMap<String, ProjectPath> = entries
            .iter()
            .map(|(code, name, path)| {
                (
                    code.to_string(),
                    ProjectPath {
                        code: code.to_string(),
                        name: name.to_string(),
                        cwd: PathBuf::from(path),
                    },
                )
            })
            .collect();
        ProjectRegistry::from_map(map)
    }

    #[test]
    fn expand_tilde_replaces_home() {
        // Use the real home directory to avoid mutating HOME (which would race
        // with other tests that also read it).
        let home = crate::paths::home_dir();
        assert_eq!(expand_tilde("~/dev/oo"), home.join("dev/oo"));
        assert_eq!(expand_tilde("~"), home.clone());
        // Absolute paths that do not start with ~ must be returned unchanged.
        assert_eq!(expand_tilde("/abs/path"), PathBuf::from("/abs/path"));
    }

    #[test]
    fn resolve_known_project_returns_correct_path() {
        let registry = make_registry(&[("oo", "otaku-odyssey", "/home/user/dev/oo")]);

        let result = registry.resolve("oo");
        assert!(result.is_some(), "expected 'oo' to resolve");
        let pp = result.unwrap();
        assert_eq!(pp.code, "oo");
        assert_eq!(pp.name, "otaku-odyssey");
        assert_eq!(pp.cwd, PathBuf::from("/home/user/dev/oo"));
    }

    #[test]
    fn resolve_unknown_code_with_no_fallback_dir_returns_none() {
        // Use a code that almost certainly doesn't exist as ~/dev/<code>/.
        let registry = make_registry(&[("oo", "otaku-odyssey", "/home/user/dev/oo")]);

        let result = registry.resolve("__nonexistent_project_xyzzy__");
        assert!(
            result.is_none(),
            "expected None for a code with no registry entry and no fallback dir"
        );
    }

    #[test]
    fn load_empty_creates_registry_with_no_entries() {
        let registry = ProjectRegistry::load_empty();
        // Nothing should resolve from an empty registry (unless a ~/dev/<code> dir exists,
        // which is very unlikely for this sentinel value).
        let result = registry.resolve("__empty_registry_sentinel__");
        assert!(result.is_none());
    }

    #[test]
    fn resolve_prefers_registry_over_fallback() {
        // Register "nx" with a custom path so we know the exact value returned.
        let registry = make_registry(&[("nx", "nexus", "/custom/path/nx")]);

        let result = registry.resolve("nx");
        assert!(result.is_some());
        let pp = result.unwrap();
        // Must come from the registry, not the fallback ~/dev/nx.
        assert_eq!(pp.cwd, PathBuf::from("/custom/path/nx"));
    }

    #[test]
    fn all_returns_all_registered_projects() {
        let registry = make_registry(&[
            ("oo", "otaku-odyssey", "/home/user/dev/oo"),
            ("nx", "nexus", "/home/user/dev/nx"),
            ("tc", "top-chef", "/home/user/dev/tc"),
        ]);

        let mut all = registry
            .all()
            .into_iter()
            .map(|p| p.code.clone())
            .collect::<Vec<_>>();
        all.sort();
        assert_eq!(all, vec!["nx", "oo", "tc"]);
    }

    #[test]
    fn all_empty_registry_returns_empty_vec() {
        let registry = ProjectRegistry::load_empty();
        assert!(registry.all().is_empty());
    }

    #[test]
    fn load_parses_real_registry() {
        // This test is skipped if the registry file doesn't exist (CI / other machines).
        let path = ProjectRegistry::registry_path();
        if !path.exists() {
            return;
        }
        let registry = ProjectRegistry::load().expect("registry should load");
        // Nexus itself is always in the registry.
        let nx = registry.resolve("nx");
        assert!(nx.is_some(), "expected 'nx' project in registry");
        let nx = nx.unwrap();
        assert_eq!(nx.code, "nx");
        assert!(!nx.name.is_empty());
    }
}
