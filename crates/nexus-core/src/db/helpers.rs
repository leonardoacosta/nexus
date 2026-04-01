//! Utility functions and extension traits for the database layer.

use sha2::{Digest, Sha256};

/// Compute SHA-256 of file content, returned as a hex string.
pub fn proposal_hash(content: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(content);
    format!("{:x}", hasher.finalize())
}

/// Truncate a string to at most `max_len` characters (first line only).
pub(crate) fn truncate_summary(s: &str, max_len: usize) -> String {
    let first_line = s.lines().next().unwrap_or(s);
    if first_line.len() > max_len {
        format!(
            "{}...",
            &first_line[..first_line.floor_char_boundary(max_len)]
        )
    } else {
        first_line.to_string()
    }
}

/// Extension trait to convert `rusqlite::Error` into `Option` for missing rows.
pub(crate) trait OptionalExt<T> {
    fn optional(self) -> std::result::Result<Option<T>, rusqlite::Error>;
}

impl<T> OptionalExt<T> for std::result::Result<T, rusqlite::Error> {
    fn optional(self) -> std::result::Result<Option<T>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}
