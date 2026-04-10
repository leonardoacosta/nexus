use super::screen::Screen;

// ---------------------------------------------------------------------------
// Palette entry
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum PaletteAction {
    /// Navigate to session detail.
    GoSession {
        session_id: String,
        agent_name: String,
    },
    /// Switch to a screen.
    GoScreen(Screen),
    /// Trigger start session flow.
    StartSession,
    /// Stop a specific session.
    StopSession { session_id: String },
}

#[derive(Debug, Clone)]
pub struct PaletteEntry {
    pub label: String,
    pub action: PaletteAction,
}
