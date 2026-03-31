//! Shared path utilities for the Nexus workspace.
//!
//! Centralises home-directory resolution and config-directory derivation
//! that was previously duplicated across `config.rs`, `project_registry.rs`,
//! and `notes.rs`.

use std::path::PathBuf;

/// Return the current user's home directory.
///
/// Reads `$HOME`; falls back to `/tmp` if the variable is unset or empty.
pub fn home_dir() -> PathBuf {
    std::env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// Return the Nexus configuration directory (`~/.config/nexus`).
pub fn nexus_config_dir() -> PathBuf {
    home_dir().join(".config").join("nexus")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn home_dir_returns_non_empty_path() {
        let home = home_dir();
        assert!(
            !home.as_os_str().is_empty(),
            "home_dir() should return a non-empty path"
        );
    }

    #[test]
    fn nexus_config_dir_is_under_home() {
        let home = home_dir();
        let config = nexus_config_dir();
        assert!(
            config.starts_with(&home),
            "nexus_config_dir() should be under home_dir()"
        );
        assert!(
            config.ends_with(".config/nexus"),
            "nexus_config_dir() should end with .config/nexus, got {:?}",
            config
        );
    }

    #[test]
    fn nexus_config_dir_structure() {
        let config = nexus_config_dir();
        // Should be exactly home/.config/nexus
        let home = home_dir();
        assert_eq!(config, home.join(".config").join("nexus"));
    }
}
