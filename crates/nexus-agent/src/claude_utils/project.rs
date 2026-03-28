use serde::Deserialize;
use std::sync::OnceLock;

/// Project configuration
#[derive(Debug, Clone, Deserialize)]
pub struct ProjectConfig {
    pub code: String,
    pub name: String,
    pub icon: String,
    pub path: String,
    #[serde(rename = "cursorUri")]
    pub cursor_uri: Option<String>,
}

#[derive(Deserialize)]
struct ProjectsFile {
    projects: Vec<ProjectConfig>,
}

static PROJECTS: OnceLock<Vec<ProjectConfig>> = OnceLock::new();

/// Get all configured projects.
/// Reads from ~/.claude/scripts/state/projects.json if available,
/// otherwise returns an empty list.
pub fn get_projects() -> &'static [ProjectConfig] {
    PROJECTS.get_or_init(|| {
        let home = dirs::home_dir().unwrap_or_default();
        let path = home.join(".claude/scripts/state/projects.json");
        match std::fs::read_to_string(&path) {
            Ok(content) => match serde_json::from_str::<ProjectsFile>(&content) {
                Ok(file) => file.projects,
                Err(e) => {
                    tracing::warn!("Failed to parse projects.json: {}", e);
                    vec![]
                }
            },
            Err(_) => vec![],
        }
    })
}
