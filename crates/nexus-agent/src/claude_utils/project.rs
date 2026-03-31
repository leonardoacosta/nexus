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

/// Get display info for a project code.
/// Returns (icon, name) for known projects, or ("🔭", "Nexus") as fallback.
pub fn get_project_display(code: &str) -> (&'static str, &'static str) {
    if code.is_empty() || code == "global" {
        return ("🔭", "Nexus");
    }
    for project in get_projects() {
        if project.code.eq_ignore_ascii_case(code) {
            return (&project.icon, &project.name);
        }
    }
    ("🔭", "Nexus")
}

/// Get all configured projects.
/// Reads from ~/.claude/scripts/config/projects.json if available,
/// otherwise returns an empty list.
pub fn get_projects() -> &'static [ProjectConfig] {
    PROJECTS.get_or_init(|| {
        let home = nexus_core::paths::home_dir();
        let path = home.join(".claude/scripts/config/projects.json");
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
