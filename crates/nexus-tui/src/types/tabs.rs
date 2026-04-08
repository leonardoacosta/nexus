// ---------------------------------------------------------------------------
// Session tab for quick switching
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SessionTab {
    pub session_id: String,
    pub project: Option<String>,
    pub session_label: String,
    pub agent_name: String,
}
