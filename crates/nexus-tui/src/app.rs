use std::time::Instant;

use chrono::{DateTime, Utc};
use ratatui::style::Color;

use nexus_core::agent::AgentInfo;
use nexus_core::session::{Session, SessionStatus};

// ---------------------------------------------------------------------------
// Brand colors (§6.1 of PRD)
// ---------------------------------------------------------------------------

#[allow(dead_code)] // Design tokens — all defined per brand spec, used incrementally.
pub mod colors {
    use super::*;

    pub const PRIMARY: Color = Color::Rgb(0x00, 0xD2, 0x6A);
    pub const PRIMARY_BRIGHT: Color = Color::Rgb(0x39, 0xFF, 0x14);
    pub const PRIMARY_DIM: Color = Color::Rgb(0x0A, 0x4A, 0x2A);
    pub const SECONDARY: Color = Color::Rgb(0x00, 0xCE, 0xD1);
    pub const WARNING: Color = Color::Rgb(0xFF, 0xB7, 0x00);
    pub const ERROR: Color = Color::Rgb(0xFF, 0x3B, 0x3B);
    pub const TEXT: Color = Color::Rgb(0xC0, 0xC0, 0xC0);
    pub const TEXT_DIM: Color = Color::Rgb(0x66, 0x66, 0x66);
    pub const BG: Color = Color::Rgb(0x0D, 0x0D, 0x0D);
    pub const SURFACE: Color = Color::Rgb(0x1A, 0x1A, 0x1A);
    pub const SURFACE_HIGHLIGHT: Color = Color::Rgb(0x2A, 0x2A, 0x2A);
}

// ---------------------------------------------------------------------------
// Screen enum
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Dashboard,
    Detail,
    Health,
    Projects,
    Palette,
    StreamAttach,
}

/// Screens that participate in Tab-cycling.
const TAB_SCREENS: [Screen; 3] = [Screen::Dashboard, Screen::Health, Screen::Projects];

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
    StartSessionProject,
    StartSessionCwd,
}

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

// ---------------------------------------------------------------------------
// Agent data for TUI state
// ---------------------------------------------------------------------------

/// Aggregated data for a single agent, received from the polling task.
#[derive(Debug, Clone)]
pub struct AgentData {
    pub info: AgentInfo,
    pub sessions: Vec<Session>,
    pub connected: bool,
    pub last_seen: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    /// SSH user for full attach (from agent config).
    pub user: String,
}

// ---------------------------------------------------------------------------
// Flattened session row for dashboard display
// ---------------------------------------------------------------------------

/// A session with its owning agent name attached, used for flat list rendering.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub session: Session,
    pub agent_name: String,
}

// ---------------------------------------------------------------------------
// Project summary for projects screen
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProjectSummary {
    pub name: String,
    pub total: usize,
    pub active: usize,
    pub idle: usize,
    pub stale: usize,
    pub errored: usize,
    pub agents: Vec<String>,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct App {
    pub current_screen: Screen,
    pub agents: Vec<AgentData>,
    pub selected_index: usize,
    pub should_quit: bool,
    pub started_at: DateTime<Utc>,

    // Detail screen state
    pub selected_session: Option<(Session, AgentInfo)>,

    // Palette state
    pub input_mode: InputMode,
    pub palette_query: String,
    pub palette_results: Vec<PaletteEntry>,
    pub palette_selected: usize,

    // Start session wizard state
    pub start_agent_idx: usize,
    pub start_project: String,
    pub start_cwd: String,

    // Status message (shown in status bar, cleared on next action).
    pub status_message: Option<String>,

    // Notification system
    pub notifications: NotificationManager,

    // Stream attach view
    pub stream_view: Option<StreamViewState>,
}

impl App {
    pub fn new() -> Self {
        Self {
            current_screen: Screen::Dashboard,
            agents: Vec::new(),
            selected_index: 0,
            should_quit: false,
            started_at: Utc::now(),
            selected_session: None,
            input_mode: InputMode::Normal,
            palette_query: String::new(),
            palette_results: Vec::new(),
            palette_selected: 0,
            start_agent_idx: 0,
            start_project: String::new(),
            start_cwd: String::new(),
            status_message: None,
            notifications: NotificationManager::new(),
            stream_view: None,
        }
    }

    pub fn next_screen(&mut self) {
        self.current_screen = self.current_screen.next();
        self.selected_index = 0;
    }

    pub fn prev_screen(&mut self) {
        self.current_screen = self.current_screen.prev();
        self.selected_index = 0;
    }

    pub fn move_down(&mut self) {
        let max = self.selectable_count();
        if max > 0 {
            self.selected_index = (self.selected_index + 1).min(max - 1);
        }
    }

    pub fn move_up(&mut self) {
        if self.selected_index > 0 {
            self.selected_index -= 1;
        }
    }

    /// Number of selectable rows for the current screen.
    fn selectable_count(&self) -> usize {
        match self.current_screen {
            Screen::Dashboard => self.all_sessions().len(),
            Screen::Detail => 0,
            Screen::Health => self.agents.len(),
            Screen::Projects => self.project_summaries().len(),
            Screen::Palette => self.palette_results.len(),
            Screen::StreamAttach => 0,
        }
    }

    /// Flatten all connected agents' sessions into a list sorted by project name.
    pub fn all_sessions(&self) -> Vec<SessionRow> {
        let mut rows: Vec<SessionRow> = self
            .agents
            .iter()
            .filter(|a| a.connected)
            .flat_map(|a| {
                a.sessions.iter().map(|s| SessionRow {
                    session: s.clone(),
                    agent_name: a.info.name.clone(),
                })
            })
            .collect();

        rows.sort_by(|a, b| {
            let pa = a.session.project.as_deref().unwrap_or("~no project");
            let pb = b.session.project.as_deref().unwrap_or("~no project");
            pa.cmp(pb)
                .then_with(|| a.session.started_at.cmp(&b.session.started_at))
        });

        rows
    }

    /// Aggregate project summaries from all connected agents.
    pub fn project_summaries(&self) -> Vec<ProjectSummary> {
        use std::collections::BTreeMap;

        let mut map: BTreeMap<String, ProjectSummary> = BTreeMap::new();

        for agent in &self.agents {
            if !agent.connected {
                continue;
            }
            for session in &agent.sessions {
                let name = session
                    .project
                    .clone()
                    .unwrap_or_else(|| "(no project)".to_string());
                let entry = map.entry(name.clone()).or_insert_with(|| ProjectSummary {
                    name,
                    total: 0,
                    active: 0,
                    idle: 0,
                    stale: 0,
                    errored: 0,
                    agents: Vec::new(),
                });
                entry.total += 1;
                match session.status {
                    SessionStatus::Active => entry.active += 1,
                    SessionStatus::Idle => entry.idle += 1,
                    SessionStatus::Stale => entry.stale += 1,
                    SessionStatus::Errored => entry.errored += 1,
                }
                if !entry.agents.contains(&agent.info.name) {
                    entry.agents.push(agent.info.name.clone());
                }
            }
        }

        map.into_values().collect()
    }

    // -----------------------------------------------------------------------
    // Palette helpers
    // -----------------------------------------------------------------------

    /// Open the command palette.
    pub fn open_palette(&mut self) {
        self.input_mode = InputMode::PaletteInput;
        self.current_screen = Screen::Palette;
        self.palette_query.clear();
        self.palette_selected = 0;
        self.refresh_palette();
    }

    /// Close the palette and return to the previous normal screen.
    pub fn close_palette(&mut self) {
        self.input_mode = InputMode::Normal;
        // Return to dashboard (palette is an overlay concept, but we track it
        // as a screen variant for rendering).
        self.current_screen = Screen::Dashboard;
        self.palette_query.clear();
        self.palette_results.clear();
    }

    /// Rebuild palette results based on current query.
    pub fn refresh_palette(&mut self) {
        let query = self.palette_query.to_ascii_lowercase();
        let mut entries: Vec<PaletteEntry> = Vec::new();

        // Sessions.
        for row in self.all_sessions() {
            let project = row.session.project.as_deref().unwrap_or("-");
            let branch = row.session.branch.as_deref().unwrap_or("-");
            let label = format!("{project}:{branch} ({agent})", agent = row.agent_name);
            entries.push(PaletteEntry {
                label,
                action: PaletteAction::GoSession {
                    session_id: row.session.id.clone(),
                    agent_name: row.agent_name.clone(),
                },
            });
        }

        // Screens.
        for screen in [Screen::Dashboard, Screen::Health, Screen::Projects] {
            entries.push(PaletteEntry {
                label: format!("screen: {}", screen.title().to_ascii_lowercase()),
                action: PaletteAction::GoScreen(screen),
            });
        }

        // Actions.
        entries.push(PaletteEntry {
            label: "start session".to_string(),
            action: PaletteAction::StartSession,
        });

        // Stop session actions.
        for row in self.all_sessions() {
            let project = row.session.project.as_deref().unwrap_or("-");
            entries.push(PaletteEntry {
                label: format!(
                    "stop: {project} ({})",
                    row.session.id.chars().take(8).collect::<String>()
                ),
                action: PaletteAction::StopSession {
                    session_id: row.session.id.clone(),
                },
            });
        }

        // Filter by query.
        if !query.is_empty() {
            entries.retain(|e| e.label.to_ascii_lowercase().contains(&query));
        }

        self.palette_results = entries;
        // Clamp selection.
        if self.palette_selected >= self.palette_results.len() {
            self.palette_selected = self.palette_results.len().saturating_sub(1);
        }
    }

    /// Enter the detail screen for a given session.
    pub fn open_detail(&mut self, session: Session, agent: AgentInfo) {
        self.selected_session = Some((session, agent));
        self.current_screen = Screen::Detail;
    }

    /// Leave detail screen and go back to dashboard.
    pub fn close_detail(&mut self) {
        self.selected_session = None;
        self.current_screen = Screen::Dashboard;
    }

    // -----------------------------------------------------------------------
    // Stream attach helpers
    // -----------------------------------------------------------------------

    /// Enter stream attach view for a given session.
    pub fn open_stream_attach(&mut self, session_id: String, session_label: String, agent_name: String) {
        self.stream_view = Some(StreamViewState::new(session_id, session_label, agent_name));
        self.current_screen = Screen::StreamAttach;
    }

    /// Leave stream attach view and return to dashboard.
    pub fn close_stream_attach(&mut self) {
        self.stream_view = None;
        self.current_screen = Screen::Dashboard;
    }

    // -----------------------------------------------------------------------
    // Start session wizard helpers
    // -----------------------------------------------------------------------

    /// Begin the start-session flow.
    pub fn begin_start_session(&mut self) {
        let connected: Vec<_> = self.agents.iter().filter(|a| a.connected).collect();
        if connected.is_empty() {
            self.status_message = Some("no connected agents".to_string());
            return;
        }
        self.start_project.clear();
        self.start_cwd.clear();
        self.start_agent_idx = 0;

        if connected.len() == 1 {
            // Skip agent selection.
            self.input_mode = InputMode::StartSessionProject;
        } else {
            self.input_mode = InputMode::StartSessionAgent;
        }
    }

    /// Return the list of connected agents (for agent selection).
    pub fn connected_agents(&self) -> Vec<&AgentData> {
        self.agents.iter().filter(|a| a.connected).collect()
    }

    pub fn session_count(&self) -> usize {
        self.agents
            .iter()
            .filter(|a| a.connected)
            .map(|a| a.sessions.len())
            .sum()
    }


    /// Replace agent data from a poll, preserving selected_index by session ID
    /// when possible.
    pub fn update_agents(&mut self, data: Vec<AgentData>) {
        // Remember the currently selected session ID (if on dashboard).
        let selected_session_id = if self.current_screen == Screen::Dashboard {
            self.all_sessions()
                .get(self.selected_index)
                .map(|r| r.session.id.clone())
        } else {
            None
        };

        self.agents = data;

        // Try to restore selection by session ID.
        if let Some(id) = selected_session_id {
            let sessions = self.all_sessions();
            if let Some(pos) = sessions.iter().position(|r| r.session.id == id) {
                self.selected_index = pos;
            } else {
                // Session gone — clamp.
                let max = self.selectable_count();
                if max > 0 {
                    self.selected_index = self.selected_index.min(max - 1);
                } else {
                    self.selected_index = 0;
                }
            }
        } else {
            // Clamp for non-dashboard screens or no previous selection.
            let max = self.selectable_count();
            if max > 0 {
                self.selected_index = self.selected_index.min(max - 1);
            } else {
                self.selected_index = 0;
            }
        }
    }

    /// Uptime string for the status bar.
    pub fn uptime_string(&self) -> String {
        let secs = Utc::now()
            .signed_duration_since(self.started_at)
            .num_seconds()
            .max(0) as u64;
        format_duration(secs)
    }
}

/// Format seconds into a human-readable short duration string.
pub fn format_duration(secs: u64) -> String {
    if secs < 60 {
        format!("{secs}s")
    } else if secs < 3600 {
        format!("{}m", secs / 60)
    } else if secs < 86400 {
        let h = secs / 3600;
        let m = (secs % 3600) / 60;
        if m > 0 {
            format!("{h}h{m}m")
        } else {
            format!("{h}h")
        }
    } else {
        let d = secs / 86400;
        let h = (secs % 86400) / 3600;
        if h > 0 {
            format!("{d}d{h}h")
        } else {
            format!("{d}d")
        }
    }
}

/// Format a chrono DateTime as a relative "age" string.
pub fn format_age(dt: DateTime<Utc>) -> String {
    let secs = Utc::now().signed_duration_since(dt).num_seconds().max(0) as u64;
    format!("{} ago", format_duration(secs))
}

/// Return the status dot character for a session status.
pub fn status_dot(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Active => "\u{25CF}",  // ●
        SessionStatus::Idle => "\u{25CB}",    // ○
        SessionStatus::Stale => "\u{25CC}",   // ◌
        SessionStatus::Errored => "\u{2716}", // ✖
    }
}

/// Return the brand color for a session status.
pub fn status_color(status: SessionStatus) -> Color {
    match status {
        SessionStatus::Active => colors::PRIMARY,
        SessionStatus::Idle => colors::WARNING,
        SessionStatus::Stale => colors::TEXT_DIM,
        SessionStatus::Errored => colors::ERROR,
    }
}

/// Return a static sparkline string based on current status.
pub fn status_sparkline(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Active => "\u{28FF}\u{28F8}\u{28F0}\u{2838}", // ⣿⣸⣰⠸
        SessionStatus::Idle => "\u{2820}\u{2830}\u{2800}\u{2800}",   // ⠠⠰⠀⠀
        SessionStatus::Stale => "\u{2800}\u{2800}\u{2800}\u{2800}",  // ⠀⠀⠀⠀
        SessionStatus::Errored => "",
    }
}

/// Type indicator for a session: [M] if managed (has tmux_session), [A] if ad-hoc.
pub fn session_type_indicator(session: &Session) -> &'static str {
    if session.tmux_session.is_some() {
        "[M]"
    } else {
        "[A]"
    }
}

// ---------------------------------------------------------------------------
// Notification system
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Warning,
    Error,
}

#[derive(Debug, Clone)]
pub struct Notification {
    pub message: String,
    pub severity: Severity,
    pub created_at: Instant,
}

/// Manages transient notifications displayed in the status bar.
pub struct NotificationManager {
    pub queue: std::collections::VecDeque<Notification>,
}

impl std::fmt::Debug for NotificationManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NotificationManager")
            .field("queue_len", &self.queue.len())
            .finish()
    }
}

impl NotificationManager {
    pub fn new() -> Self {
        Self {
            queue: std::collections::VecDeque::new(),
        }
    }

    /// Add a notification.
    pub fn push(&mut self, message: String, severity: Severity) {
        self.queue.push_back(Notification {
            message,
            severity,
            created_at: Instant::now(),
        });
    }

    /// Remove notifications older than 10 seconds.
    pub fn tick(&mut self) {
        let cutoff = std::time::Duration::from_secs(10);
        self.queue.retain(|n| n.created_at.elapsed() < cutoff);
    }

    /// Clear all notifications (called on keypress).
    pub fn dismiss_all(&mut self) {
        self.queue.clear();
    }

    /// Return the most recent notification, if any.
    pub fn latest(&self) -> Option<&Notification> {
        self.queue.back()
    }
}

// ---------------------------------------------------------------------------
// Stream view state
// ---------------------------------------------------------------------------

/// State for the stream attach view (rendered by screens/stream.rs).
pub struct StreamViewState {
    pub session_id: String,
    pub session_label: String,
    pub agent_name: String,
    pub lines: Vec<String>,
    pub scroll_offset: usize,
    pub auto_scroll: bool,
}

impl std::fmt::Debug for StreamViewState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StreamViewState")
            .field("session_id", &self.session_id)
            .field("lines_count", &self.lines.len())
            .field("scroll_offset", &self.scroll_offset)
            .field("auto_scroll", &self.auto_scroll)
            .finish()
    }
}

const MAX_STREAM_LINES: usize = 1000;

impl StreamViewState {
    pub fn new(session_id: String, session_label: String, agent_name: String) -> Self {
        Self {
            session_id,
            session_label,
            agent_name,
            lines: Vec::new(),
            scroll_offset: 0,
            auto_scroll: true,
        }
    }

    /// Append a formatted event line, maintaining the bounded buffer.
    pub fn push_line(&mut self, line: String) {
        self.lines.push(line);
        if self.lines.len() > MAX_STREAM_LINES {
            let excess = self.lines.len() - MAX_STREAM_LINES;
            self.lines.drain(0..excess);
            self.scroll_offset = self.scroll_offset.saturating_sub(excess);
        }
    }

    /// Scroll up by one line.
    pub fn scroll_up(&mut self) {
        if self.scroll_offset > 0 {
            self.scroll_offset -= 1;
        }
        self.auto_scroll = false;
    }

    /// Scroll down by one line.
    pub fn scroll_down(&mut self, visible_height: usize) {
        let max = self.lines.len().saturating_sub(visible_height);
        if self.scroll_offset < max {
            self.scroll_offset += 1;
        }
        // Re-enable auto_scroll if we scrolled to bottom.
        if self.scroll_offset >= max {
            self.auto_scroll = true;
        }
    }

    /// Scroll up by a page.
    pub fn page_up(&mut self, visible_height: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(visible_height);
        self.auto_scroll = false;
    }

    /// Scroll down by a page.
    pub fn page_down(&mut self, visible_height: usize) {
        let max = self.lines.len().saturating_sub(visible_height);
        self.scroll_offset = (self.scroll_offset + visible_height).min(max);
        if self.scroll_offset >= max {
            self.auto_scroll = true;
        }
    }

    /// Jump to the end (re-enable auto-scroll).
    pub fn scroll_to_end(&mut self) {
        self.auto_scroll = true;
    }

    /// Update scroll offset for auto-scroll mode.
    pub fn update_auto_scroll(&mut self, visible_height: usize) {
        if self.auto_scroll {
            self.scroll_offset = self.lines.len().saturating_sub(visible_height);
        }
    }
}
