use std::path::PathBuf;

/// Expand `~` to the user's home directory.
pub fn expand_home(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        return nexus_core::paths::home_dir().join(&path[2..]);
    }
    PathBuf::from(path)
}
