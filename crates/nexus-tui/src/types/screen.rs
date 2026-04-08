// ---------------------------------------------------------------------------
// Screen enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Dashboard,
    Detail,
    Health,
    Projects,
    Specs,
    Palette,
    StreamAttach,
}

/// Screens that participate in Tab-cycling.
const TAB_SCREENS: [Screen; 4] = [
    Screen::Dashboard,
    Screen::Health,
    Screen::Projects,
    Screen::Specs,
];

impl Screen {
    pub fn next(self) -> Screen {
        let idx = TAB_SCREENS.iter().position(|s| *s == self).unwrap_or(0);
        TAB_SCREENS[(idx + 1) % TAB_SCREENS.len()]
    }

    pub fn prev(self) -> Screen {
        let idx = TAB_SCREENS.iter().position(|s| *s == self).unwrap_or(0);
        TAB_SCREENS[(idx + TAB_SCREENS.len() - 1) % TAB_SCREENS.len()]
    }

    pub fn title(self) -> &'static str {
        match self {
            Screen::Dashboard => "SESSION DASHBOARD",
            Screen::Detail => "SESSION DETAIL",
            Screen::Health => "HEALTH OVERVIEW",
            Screen::Projects => "PROJECT OVERVIEW",
            Screen::Specs => "SPEC REVIEW",
            Screen::Palette => "COMMAND PALETTE",
            Screen::StreamAttach => "STREAM ATTACH",
        }
    }
}

// ---------------------------------------------------------------------------
// Input mode
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InputMode {
    Normal,
    PaletteInput,
    StartSessionAgent,
    StartSessionProjectSelect,
    StartSessionCwd,
    StreamInput,
    StreamSearch,
    ScratchpadEdit,
    /// Notification settings panel overlay.
    NotificationPanel,
}
