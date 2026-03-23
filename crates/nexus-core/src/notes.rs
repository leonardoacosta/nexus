use std::collections::HashMap;
use std::path::PathBuf;

/// Per-project notes persisted to `~/.config/nexus/project-notes.toml`.
#[derive(Debug, Clone, Default)]
pub struct ProjectNotes {
    pub notes: HashMap<String, String>,
    path: PathBuf,
}

impl ProjectNotes {
    /// Load notes from disk. Returns an empty map if the file is missing or malformed.
    pub fn load() -> Self {
        let path = Self::notes_path();
        let notes = match std::fs::read_to_string(&path) {
            Ok(content) => toml::from_str::<HashMap<String, String>>(&content).unwrap_or_default(),
            Err(_) => HashMap::new(),
        };
        Self { notes, path }
    }

    /// Persist notes to disk via atomic write (write to `.tmp`, then rename).
    pub fn save(&self) -> anyhow::Result<()> {
        // Ensure the parent directory exists.
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let content = toml::to_string_pretty(&self.notes)?;
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, &content)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    /// Get the note for a project, if any.
    pub fn get(&self, project: &str) -> Option<&String> {
        self.notes.get(project)
    }

    /// Set a note for a project. Empty/whitespace-only notes remove the entry.
    pub fn set(&mut self, project: String, note: String) {
        if note.trim().is_empty() {
            self.notes.remove(&project);
        } else {
            self.notes.insert(project, note);
        }
    }

    fn notes_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home).join(".config/nexus/project-notes.toml")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_missing_file_returns_empty() {
        // ProjectNotes::load() should not panic when file is missing.
        // We can't easily redirect the path in tests, but we can verify the
        // default behavior of from_str on invalid content.
        let notes: HashMap<String, String> =
            toml::from_str::<HashMap<String, String>>("not valid toml {{{{").unwrap_or_default();
        assert!(notes.is_empty());
    }

    #[test]
    fn set_empty_note_removes_entry() {
        let mut notes = ProjectNotes::default();
        notes.set("myproject".to_string(), "some note".to_string());
        assert!(notes.get("myproject").is_some());

        notes.set("myproject".to_string(), "   ".to_string());
        assert!(notes.get("myproject").is_none());
    }

    #[test]
    fn round_trip_serialization() {
        let mut map = HashMap::new();
        map.insert("proj-a".to_string(), "note for a".to_string());
        map.insert("proj-b".to_string(), "note for b\nwith newline".to_string());

        let serialized = toml::to_string_pretty(&map).unwrap();
        let deserialized: HashMap<String, String> = toml::from_str(&serialized).unwrap();
        assert_eq!(deserialized, map);
    }
}
