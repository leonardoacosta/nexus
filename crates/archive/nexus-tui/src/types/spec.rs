// ---------------------------------------------------------------------------
// Spec review types
// ---------------------------------------------------------------------------

/// Lightweight spec record for the spec list view (mirrors SpecRecord from nexus-core).
#[derive(Debug, Clone, serde::Deserialize)]
pub struct SpecListEntry {
    pub project: String,
    pub name: String,
    pub status: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tasks_total: Option<i32>,
    pub tasks_done: Option<i32>,
    pub discovered_at: Option<String>,
}

impl SpecListEntry {
    /// Sort key: unread=0, read=1, approved=2, applied=3, rejected=4, other=5.
    pub fn status_sort_key(&self) -> u8 {
        match self.status.as_str() {
            "unread" => 0,
            "read" => 1,
            "approved" => 2,
            "applied" => 3,
            "rejected" => 4,
            _ => 5,
        }
    }
}

/// State for the spec detail overlay view.
#[derive(Debug, Clone)]
pub struct SpecDetailState {
    pub project: String,
    pub name: String,
    pub status: String,
    pub title: Option<String>,
    pub summary: Option<String>,
    pub tasks_total: Option<i32>,
    pub tasks_done: Option<i32>,
    pub scroll_offset: usize,
}
