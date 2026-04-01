use std::collections::{HashMap, VecDeque};
use std::time::Instant;

use chrono::{DateTime, Utc};
use ratatui::style::Color;
use ratatui::text::Line;
use ratatui::widgets::{ScrollbarState, TableState};
use tui_textarea::TextArea;

use nexus_core::agent::AgentSnapshot;
use nexus_core::notes::ProjectNotes;
use nexus_core::session::{Session, SessionStatus};

// Re-export extracted modules so existing `crate::app::*` imports work.
#[allow(unused_imports)] // Used by tests and re-exported for submodules
pub use crate::notification::{Notification, NotificationPanelRow};
pub use crate::notification::{NotificationManager, NotificationPanelState, Severity};
pub use crate::stream_state::StreamViewState;
#[allow(unused_imports)] // Used by tests
pub use crate::stream_state::classify_diff_line;
pub use crate::theme::{
    colors, format_age, format_duration, session_type_indicator, status_color, status_dot,
};

// ---------------------------------------------------------------------------
// Search state for stream view
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct SearchState {
    pub query: String,
    pub match_positions: Vec<usize>, // display line indices with matches
    pub current_match: usize,
}

// ---------------------------------------------------------------------------
// Code block range for clipboard
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct CodeBlockRange {
    pub start_line: usize,
    pub end_line: usize,
    pub content: String,
}

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

// ---------------------------------------------------------------------------
// Stream verbosity levels
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum StreamVerbosity {
    Minimal,
    #[default]
    Normal,
    Verbose,
}

// ---------------------------------------------------------------------------
// Line style metadata for stream view
// ---------------------------------------------------------------------------

/// Semantic style for a single line in the stream view.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // AssistantText kept for exhaustive match; text now uses RichText path.
pub enum LineStyle {
    UserPrompt,
    UserHeader,
    AssistantText,
    AssistantHeader,
    ToolHeader,
    ToolInput,
    ToolResult,
    ToolError,
    Error,
    DoneSummary,
    Plain,
    DiffAdd,
    DiffRemove,
}

impl LineStyle {
    /// The minimum verbosity level at which this style is visible.
    pub fn min_verbosity(self) -> StreamVerbosity {
        match self {
            LineStyle::UserPrompt
            | LineStyle::UserHeader
            | LineStyle::AssistantText
            | LineStyle::AssistantHeader
            | LineStyle::DoneSummary => StreamVerbosity::Minimal,
            LineStyle::ToolHeader
            | LineStyle::ToolInput
            | LineStyle::ToolResult
            | LineStyle::ToolError
            | LineStyle::Error
            | LineStyle::Plain
            | LineStyle::DiffAdd
            | LineStyle::DiffRemove => StreamVerbosity::Normal,
        }
    }
}

/// A single log line with associated style metadata.
#[derive(Debug, Clone)]
pub struct StyledLine {
    pub text: String,
    pub style: LineStyle,
}

impl StyledLine {
    pub fn new(text: impl Into<String>, style: LineStyle) -> Self {
        Self {
            text: text.into(),
            style,
        }
    }
}

/// A single entry in the stream view log — either a plain styled line, a
/// pre-styled rich-text line (from markdown rendering), or a collapsible block
/// of tool output.
#[derive(Debug, Clone)]
pub enum StreamLine {
    /// A single styled line rendered as-is.
    Styled(StyledLine),
    /// A pre-styled line produced by the markdown renderer. Each `Line` may
    /// contain multiple `Span`s with different styles (bold, italic, code, etc.)
    RichText { line: Line<'static> },
    /// A collapsible block with a header and zero or more body lines.
    CollapsibleBlock {
        header: StyledLine,
        lines: Vec<StyledLine>,
        expanded: bool,
    },
}

impl StreamLine {
    /// Number of display lines this entry occupies.
    ///
    /// - `Styled`: always 1
    /// - `CollapsibleBlock` (collapsed): 1 (header only)
    /// - `CollapsibleBlock` (expanded): 1 (header) + body line count
    pub fn display_lines(&self) -> usize {
        match self {
            StreamLine::Styled(_) => 1,
            StreamLine::RichText { .. } => 1,
            StreamLine::CollapsibleBlock {
                lines, expanded, ..
            } => {
                if *expanded {
                    1 + lines.len()
                } else {
                    1
                }
            }
        }
    }

    /// Whether this line should be visible at the given verbosity level.
    ///
    /// `RichText` lines are always visible at `Minimal` (they are assistant text).
    /// `CollapsibleBlock` uses the header's style for the check.
    pub fn is_visible(&self, verbosity: StreamVerbosity) -> bool {
        let min = match self {
            StreamLine::Styled(s) => s.style.min_verbosity(),
            StreamLine::RichText { .. } => StreamVerbosity::Minimal,
            StreamLine::CollapsibleBlock { header, .. } => header.style.min_verbosity(),
        };
        verbosity_rank(verbosity) >= verbosity_rank(min)
    }
}

/// Map verbosity levels to a numeric rank for comparison.
fn verbosity_rank(v: StreamVerbosity) -> u8 {
    match v {
        StreamVerbosity::Minimal => 0,
        StreamVerbosity::Normal => 1,
        StreamVerbosity::Verbose => 2,
    }
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
    pub info: AgentSnapshot,
    pub sessions: Vec<Session>,
    pub connected: bool,
    pub last_seen: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    /// `Some(n)` when the agent is actively reconnecting (n = attempt number).
    pub reconnect_attempt: Option<u32>,
    /// True when the disconnect was caused by DNS resolution failure (no retry).
    pub dns_failure: bool,
}

// ---------------------------------------------------------------------------
// Flattened session row for dashboard display
// ---------------------------------------------------------------------------

/// A session with its owning agent name attached, used for flat list rendering.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub session: Session,
    pub agent_name: String,
    pub disconnected: bool,
}

// ---------------------------------------------------------------------------
// Activity status for project badges
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityStatus {
    Active,  // at least one Active session
    Idle,    // all sessions Idle
    Stale,   // all sessions Stale
    Errored, // any session Errored
    None,    // no sessions
}

impl ActivityStatus {
    /// Return the brand color for this activity status.
    pub fn color(self) -> Color {
        match self {
            ActivityStatus::Active => colors::PRIMARY,
            ActivityStatus::Idle => colors::WARNING,
            ActivityStatus::Stale => colors::TEXT_DIM,
            ActivityStatus::Errored => colors::ERROR,
            ActivityStatus::None => colors::TEXT_DIM,
        }
    }

    /// Return a status dot character for this activity status.
    pub fn dot(self) -> &'static str {
        match self {
            ActivityStatus::Active => "\u{25CF}",  // ●
            ActivityStatus::Idle => "\u{25CB}",    // ○
            ActivityStatus::Stale => "\u{25CC}",   // ◌
            ActivityStatus::Errored => "\u{2716}", // ✖
            ActivityStatus::None => "\u{25CC}",    // ◌
        }
    }
}

// ---------------------------------------------------------------------------
// Project summary for projects screen
// ---------------------------------------------------------------------------

/// Sync status for a project's git repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum SyncStatus {
    Synced,
    Behind,
    #[default]
    Unknown,
}

#[derive(Debug, Clone)]
pub struct ProjectSummary {
    pub name: String,
    pub total: usize,
    pub active: usize,
    pub idle: usize,
    pub stale: usize,
    pub errored: usize,
    pub agents: Vec<String>,
    pub activity_status: ActivityStatus,
    pub last_activity: Option<DateTime<Utc>>,
    pub sync_status: SyncStatus,
    pub commits_behind: Option<i32>,
    pub git_branch: Option<String>,
}

// ---------------------------------------------------------------------------
// Health history ring buffer
// ---------------------------------------------------------------------------

/// Ring-buffer holding ~1 hour of CPU and RAM history (1800 samples at 2s intervals).
#[derive(Debug, Clone)]
pub struct AgentHealthHistory {
    /// CPU utilization samples as integer percentages (0–100).
    pub cpu: VecDeque<u64>,
    /// RAM utilization samples as integer percentages (0–100).
    pub ram: VecDeque<u64>,
}

impl AgentHealthHistory {
    const CAPACITY: usize = 1800;

    pub fn new() -> Self {
        Self {
            cpu: VecDeque::with_capacity(Self::CAPACITY),
            ram: VecDeque::with_capacity(Self::CAPACITY),
        }
    }

    pub fn push_cpu(&mut self, value: u64) {
        if self.cpu.len() >= Self::CAPACITY {
            self.cpu.pop_front();
        }
        self.cpu.push_back(value);
    }

    pub fn push_ram(&mut self, value: u64) {
        if self.ram.len() >= Self::CAPACITY {
            self.ram.pop_front();
        }
        self.ram.push_back(value);
    }
}

// ---------------------------------------------------------------------------
// Enriched project detail (from ListProjects enriched response)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ProjectDetail {
    pub sync_status: SyncStatus,
    pub commits_behind: Option<i32>,
    pub git_branch: Option<String>,
    /// Filesystem path to the project root, sourced from the agent.
    pub path: Option<String>,
}

// NotificationPanelRow and NotificationPanelState — re-exported from crate::notification

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

// ---------------------------------------------------------------------------
// Confirm kind for two-step destructive actions
// ---------------------------------------------------------------------------

/// Pending confirmation for destructive actions (approve/reject spec).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConfirmKind {
    ApproveSpec,
    RejectSpec,
}

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

pub struct App {
    pub current_screen: Screen,
    pub agents: Vec<AgentData>,
    pub selected_index: usize,
    pub dashboard_table_state: TableState,
    pub should_quit: bool,
    pub started_at: DateTime<Utc>,

    // Detail screen state
    pub selected_session: Option<(Session, AgentSnapshot)>,

    // Palette state
    pub input_mode: InputMode,
    pub palette_query: String,
    pub palette_results: Vec<PaletteEntry>,
    pub palette_selected: usize,

    // Start session wizard state
    pub start_agent_idx: usize,
    pub start_project: String,
    pub start_cwd: String,
    pub start_projects: Vec<String>,
    pub start_project_idx: usize,
    pub start_project_filter: String,

    // Status message (shown in status bar, cleared on next action).
    pub status_message: Option<String>,

    // Notification system
    pub notifications: NotificationManager,

    // Stream attach view
    pub stream_view: Option<StreamViewState>,

    /// TextArea widget for the stream view command input bar.
    pub stream_textarea: TextArea<'static>,
    /// Whether a command is currently executing.
    pub stream_executing: bool,

    /// When the current command execution started (for elapsed time display).
    pub stream_exec_start: Option<Instant>,

    /// Frame counter for animations (spinner, etc.). Incremented each render tick.
    pub tick_count: usize,

    // Session tabs (max 9)
    pub session_tabs: Vec<SessionTab>,
    pub active_tab: Option<usize>,

    // Scratchpad state
    pub scratchpad_text: String,
    pub project_notes: ProjectNotes,
    pub scratchpad_project: Option<String>,

    /// Per-agent health history ring buffers keyed by agent name.
    pub health_history: HashMap<String, AgentHealthHistory>,

    /// Enriched project git details keyed by project name.
    /// Populated from `ListProjects` enriched responses.
    pub project_details_map: HashMap<String, ProjectDetail>,

    /// Scrollbar state for the stream message area.
    pub stream_scroll_state: ScrollbarState,

    /// Total number of visible display lines in the stream view (updated each
    /// render frame so the scrollbar knows the content length).
    pub stream_total_lines: usize,

    /// State for the notification settings panel overlay.
    /// `None` when the panel is closed.
    pub notification_panel: Option<NotificationPanelState>,

    /// Cached flattened session rows, recomputed on `update_agents`.
    cached_sessions: Vec<SessionRow>,
    /// Cached project summaries, recomputed on `update_agents`.
    cached_project_summaries: Vec<ProjectSummary>,

    // Spec review screen state
    /// Cached spec records fetched from the agent HTTP API.
    pub cached_specs: Vec<SpecListEntry>,
    /// Whether the spec detail view is open (showing proposal content).
    pub spec_detail: Option<SpecDetailState>,
    /// Number of specs with status "unread" or "read" (pending review).
    pub pending_spec_count: usize,

    /// Cached health timeseries from SQLite (24h), keyed by agent name.
    pub health_time_series: HashMap<String, Vec<nexus_core::proto::HealthTimeSeriesEntry>>,

    /// Cached session history (daily counts/costs).
    pub session_history: Vec<nexus_core::proto::SessionHistoryEntry>,

    /// Cached failure trends (daily + by tool).
    pub failure_trends_daily: Vec<nexus_core::proto::FailureTrendEntry>,
    pub failure_trends_by_tool: Vec<nexus_core::proto::FailureByTool>,

    /// Cached spec velocity entries.
    pub spec_velocity: Vec<nexus_core::proto::SpecVelocityEntry>,

    /// Screen to return to when closing Palette or StreamAttach.
    pub previous_screen: Option<Screen>,

    /// Whether the ? help overlay is showing.
    pub help_overlay: bool,

    /// Pending two-step confirmation action with timestamp.
    pub confirm_action: Option<(ConfirmKind, std::time::Instant)>,
}

impl App {
    pub fn new() -> Self {
        Self {
            current_screen: Screen::Dashboard,
            agents: Vec::new(),
            selected_index: 0,
            dashboard_table_state: TableState::default().with_selected(Some(0)),
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
            start_projects: Vec::new(),
            start_project_idx: 0,
            start_project_filter: String::new(),
            status_message: None,
            notifications: NotificationManager::new(),
            stream_view: None,
            stream_textarea: TextArea::default(),
            stream_executing: false,
            stream_exec_start: None,
            tick_count: 0,
            session_tabs: Vec::new(),
            active_tab: None,
            scratchpad_text: String::new(),
            project_notes: ProjectNotes::load(),
            scratchpad_project: None,
            health_history: HashMap::new(),
            project_details_map: HashMap::new(),
            stream_scroll_state: ScrollbarState::default(),
            stream_total_lines: 0,
            notification_panel: None,
            cached_sessions: Vec::new(),
            cached_project_summaries: Vec::new(),
            cached_specs: Vec::new(),
            spec_detail: None,
            pending_spec_count: 0,
            health_time_series: HashMap::new(),
            session_history: Vec::new(),
            failure_trends_daily: Vec::new(),
            failure_trends_by_tool: Vec::new(),
            spec_velocity: Vec::new(),
            previous_screen: None,
            help_overlay: false,
            confirm_action: None,
        }
    }

    // -------------------------------------------------------------------------
    // Stream textarea helpers
    // -------------------------------------------------------------------------

    /// Return the current textarea content as a single `String` (lines joined
    /// with `\n`). An empty textarea returns an empty string.
    pub fn stream_input_text(&self) -> String {
        let lines = self.stream_textarea.lines();
        if lines.is_empty() || (lines.len() == 1 && lines[0].is_empty()) {
            String::new()
        } else {
            lines.join("\n")
        }
    }

    /// Return `true` if the textarea is empty (no content).
    pub fn stream_input_is_empty(&self) -> bool {
        let lines = self.stream_textarea.lines();
        lines.is_empty() || (lines.len() == 1 && lines[0].is_empty())
    }

    /// Clear the textarea content.
    pub fn stream_input_clear(&mut self) {
        self.stream_textarea = TextArea::default();
    }

    /// Set the textarea content to an arbitrary string (used for history
    /// navigation).
    pub fn stream_input_set(&mut self, text: &str) {
        let lines: Vec<String> = text.lines().map(str::to_owned).collect();
        self.stream_textarea = TextArea::new(lines);
        // Move cursor to end of content.
        self.stream_textarea
            .move_cursor(tui_textarea::CursorMove::End);
    }

    /// Submit a prompt to the currently attached session.
    ///
    /// Clears the input, marks the session as executing, pushes the prompt
    /// into stream history and view, and sends the RPC command. Returns `true`
    /// if the prompt was sent, `false` if it was empty or no stream view is
    /// attached.
    pub fn submit_prompt(&mut self, rpc_tx: &tokio::sync::mpsc::Sender<crate::RpcCommand>) -> bool {
        let prompt = self.stream_input_text();
        if prompt.is_empty() {
            return false;
        }

        self.stream_input_clear();
        self.stream_executing = true;
        self.stream_exec_start = Some(std::time::Instant::now());

        if let Some(sv) = &mut self.stream_view {
            sv.push_history(prompt.clone());
            sv.push_line(StyledLine::new(
                "\u{2500}\u{2500} you \u{2500}\u{2500}",
                LineStyle::UserHeader,
            ));
            for line in prompt.lines() {
                sv.push_line(StyledLine::new(line.to_string(), LineStyle::UserPrompt));
            }
            // Blank separator after user prompt block.
            sv.push_line(StyledLine::new("", LineStyle::Plain));
            // Reset assistant header for the upcoming response.
            sv.assistant_header_emitted = false;
        }

        if let Some(sv) = &self.stream_view {
            let session_id = sv.session_id.clone();
            let _ = rpc_tx.try_send(crate::RpcCommand::SendCommand { session_id, prompt });
        }

        true
    }

    pub fn next_screen(&mut self) {
        self.current_screen = self.current_screen.next();
        self.selected_index = 0;
        self.dashboard_table_state.select(Some(0));
    }

    pub fn prev_screen(&mut self) {
        self.current_screen = self.current_screen.prev();
        self.selected_index = 0;
        self.dashboard_table_state.select(Some(0));
    }

    pub fn move_down(&mut self) {
        let max = self.selectable_count();
        if max > 0 {
            self.selected_index = (self.selected_index + 1).min(max - 1);
            if self.current_screen == Screen::Dashboard {
                self.dashboard_table_state.select(Some(self.selected_index));
            }
        }
    }

    pub fn move_up(&mut self) {
        if self.selected_index > 0 {
            self.selected_index -= 1;
            if self.current_screen == Screen::Dashboard {
                self.dashboard_table_state.select(Some(self.selected_index));
            }
        }
    }

    /// Number of selectable rows for the current screen.
    fn selectable_count(&self) -> usize {
        match self.current_screen {
            Screen::Dashboard => self.cached_sessions.len(),
            Screen::Detail => 0,
            Screen::Health => self.agents.len(),
            Screen::Projects => self.cached_project_summaries.len(),
            Screen::Specs => self.cached_specs.len(),
            Screen::Palette => self.palette_results.len(),
            Screen::StreamAttach => 0,
        }
    }

    /// Return the cached flattened session rows (recomputed on each `update_agents` call).
    pub fn cached_sessions(&self) -> &[SessionRow] {
        &self.cached_sessions
    }

    /// Return the cached project summaries (recomputed on each `update_agents` call).
    pub fn cached_project_summaries(&self) -> &[ProjectSummary] {
        &self.cached_project_summaries
    }

    /// Flatten all agents' sessions into a list sorted by project name.
    /// Sessions from disconnected agents are included but marked as such.
    fn recompute_sessions(&self) -> Vec<SessionRow> {
        let mut rows: Vec<SessionRow> = self
            .agents
            .iter()
            .flat_map(|a| {
                let disconnected = !a.connected;
                a.sessions.iter().map(move |s| SessionRow {
                    session: s.clone(),
                    agent_name: a.info.name.clone(),
                    disconnected,
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
    fn recompute_project_summaries(&self) -> Vec<ProjectSummary> {
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
                    activity_status: ActivityStatus::None,
                    last_activity: None,
                    sync_status: SyncStatus::Unknown,
                    commits_behind: None,
                    git_branch: None,
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
                // Track last_activity as the max last_heartbeat across sessions.
                let hb = session.last_heartbeat;
                entry.last_activity = Some(match entry.last_activity {
                    Some(prev) => prev.max(hb),
                    None => hb,
                });
            }
        }

        // Compute activity_status per project (priority: Errored > Active > Idle > Stale > None).
        for entry in map.values_mut() {
            entry.activity_status = if entry.errored > 0 {
                ActivityStatus::Errored
            } else if entry.active > 0 {
                ActivityStatus::Active
            } else if entry.idle > 0 {
                ActivityStatus::Idle
            } else if entry.stale > 0 {
                ActivityStatus::Stale
            } else {
                ActivityStatus::None
            };

            // Merge sync details from the enriched project details map.
            if let Some(detail) = self.project_details_map.get(&entry.name) {
                entry.sync_status = detail.sync_status;
                entry.commits_behind = detail.commits_behind;
                entry.git_branch = detail.git_branch.clone();
            }
        }

        map.into_values().collect()
    }

    // -----------------------------------------------------------------------
    // Project detail helpers
    // -----------------------------------------------------------------------

    /// Update the enriched project details map from `ListProjects` response data.
    #[allow(dead_code)]
    pub fn update_projects(&mut self, details: Vec<ProjectDetail>, names: Vec<String>) {
        // Insert or update details for each project in the response.
        for (name, detail) in names.into_iter().zip(details.into_iter()) {
            self.project_details_map.insert(name, detail);
        }
    }

    // -----------------------------------------------------------------------
    // Scratchpad helpers
    // -----------------------------------------------------------------------

    /// Open the scratchpad overlay for a given project.
    pub fn open_scratchpad(&mut self, project: &str) {
        self.scratchpad_project = Some(project.to_string());
        self.scratchpad_text = self.project_notes.get(project).cloned().unwrap_or_default();
        self.input_mode = InputMode::ScratchpadEdit;
    }

    /// Save the scratchpad text and close the overlay.
    pub fn close_scratchpad(&mut self) {
        if let Some(project) = self.scratchpad_project.take() {
            self.project_notes
                .set(project, self.scratchpad_text.clone());
            if let Err(e) = self.project_notes.save() {
                self.status_message = Some(format!("notes save failed: {e}"));
            }
        }
        self.scratchpad_text.clear();
        self.input_mode = InputMode::Normal;
    }

    // -----------------------------------------------------------------------
    // Previous screen helper
    // -----------------------------------------------------------------------

    pub fn save_previous_screen(&mut self) {
        self.previous_screen = Some(self.current_screen);
    }

    // -----------------------------------------------------------------------
    // Help overlay helpers
    // -----------------------------------------------------------------------

    pub fn toggle_help(&mut self) {
        self.help_overlay = !self.help_overlay;
    }

    pub fn close_help(&mut self) {
        self.help_overlay = false;
    }

    // -----------------------------------------------------------------------
    // Two-step confirm helpers
    // -----------------------------------------------------------------------

    /// Start a confirmation. Returns true if this is the confirming second press within 3s.
    pub fn confirm_or_start(&mut self, kind: ConfirmKind) -> bool {
        if let Some((pending_kind, started)) = self.confirm_action {
            if pending_kind == kind && started.elapsed().as_secs() < 3 {
                self.confirm_action = None;
                return true; // Confirmed!
            }
        }
        self.confirm_action = Some((kind, std::time::Instant::now()));
        false
    }

    /// Clear expired confirmations (call each tick).
    pub fn clear_expired_confirm(&mut self) {
        if let Some((_, started)) = self.confirm_action {
            if started.elapsed().as_secs() >= 3 {
                self.confirm_action = None;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Palette helpers
    // -----------------------------------------------------------------------

    /// Open the command palette.
    pub fn open_palette(&mut self) {
        self.save_previous_screen();
        self.input_mode = InputMode::PaletteInput;
        self.current_screen = Screen::Palette;
        self.palette_query.clear();
        self.palette_selected = 0;
        self.refresh_palette();
    }

    /// Close the palette and return to the previous normal screen.
    pub fn close_palette(&mut self) {
        self.input_mode = InputMode::Normal;
        self.current_screen = self.previous_screen.unwrap_or(Screen::Dashboard);
        self.previous_screen = None;
        self.palette_query.clear();
        self.palette_results.clear();
    }

    /// Open the notification settings panel overlay.
    pub fn open_notification_panel(&mut self) {
        self.notification_panel = Some(NotificationPanelState::load());
        self.input_mode = InputMode::NotificationPanel;
    }

    /// Close the notification settings panel. Any unsaved mutations are lost
    /// (each toggle already persists immediately, so this is just UI cleanup).
    pub fn close_notification_panel(&mut self) {
        self.notification_panel = None;
        self.input_mode = InputMode::Normal;
    }

    /// Rebuild palette results based on current query.
    pub fn refresh_palette(&mut self) {
        let query = self.palette_query.to_ascii_lowercase();
        let mut entries: Vec<PaletteEntry> = Vec::new();

        // Sessions.
        for row in &self.cached_sessions {
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
        for screen in [
            Screen::Dashboard,
            Screen::Health,
            Screen::Projects,
            Screen::Specs,
        ] {
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
        for row in &self.cached_sessions {
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
    pub fn open_detail(&mut self, session: Session, agent: AgentSnapshot) {
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
    pub fn open_stream_attach(
        &mut self,
        session_id: String,
        session_label: String,
        agent_name: String,
    ) {
        self.stream_view = Some(StreamViewState::new(session_id, session_label, agent_name));
        self.current_screen = Screen::StreamAttach;
    }

    /// Leave stream attach view and return to dashboard.
    pub fn close_stream_attach(&mut self) {
        self.stream_view = None;
        self.active_tab = None;
        self.current_screen = Screen::Dashboard;
    }

    /// Ensure the current stream session is tracked as a tab.
    /// Returns the tab index if a new tab was added.
    pub fn ensure_session_tab(&mut self) -> Option<usize> {
        let sv = self.stream_view.as_ref()?;
        let session_id = sv.session_id.clone();
        if let Some(idx) = self
            .session_tabs
            .iter()
            .position(|t| t.session_id == session_id)
        {
            self.active_tab = Some(idx);
            return Some(idx);
        }
        if self.session_tabs.len() >= 9 {
            return None; // max 9 tabs
        }
        let tab = SessionTab {
            session_id: sv.session_id.clone(),
            project: None, // filled from session data
            session_label: sv.session_label.clone(),
            agent_name: sv.agent_name.clone(),
        };
        self.session_tabs.push(tab);
        let idx = self.session_tabs.len() - 1;
        self.active_tab = Some(idx);
        Some(idx)
    }

    // -----------------------------------------------------------------------
    // Start session wizard helpers
    // -----------------------------------------------------------------------

    /// Begin the start-session flow.
    ///
    /// Returns `Some(agent_name)` when the project list RPC should be triggered
    /// (single agent auto-selected), or `None` when agent selection is needed first.
    pub fn begin_start_session(&mut self) -> Option<String> {
        let connected: Vec<_> = self.agents.iter().filter(|a| a.connected).collect();
        if connected.is_empty() {
            self.status_message = Some("no connected agents".to_string());
            return None;
        }
        self.start_project.clear();
        self.start_cwd.clear();
        self.start_projects.clear();
        self.start_project_idx = 0;
        self.start_project_filter.clear();
        self.start_agent_idx = 0;

        if connected.len() == 1 {
            // Skip agent selection, transition directly to project select.
            self.input_mode = InputMode::StartSessionProjectSelect;
            Some(connected[0].info.name.clone())
        } else {
            self.input_mode = InputMode::StartSessionAgent;
            None
        }
    }

    /// Return filtered projects based on current type-ahead filter.
    pub fn filtered_projects(&self) -> Vec<&String> {
        if self.start_project_filter.is_empty() {
            self.start_projects.iter().collect()
        } else {
            let filter = self.start_project_filter.to_ascii_lowercase();
            self.start_projects
                .iter()
                .filter(|p| p.to_ascii_lowercase().contains(&filter))
                .collect()
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
            self.cached_sessions
                .get(self.selected_index)
                .map(|r| r.session.id.clone())
        } else {
            None
        };

        // Push health samples into per-agent ring buffers.
        for agent in &data {
            if agent.connected
                && let Some(health) = &agent.info.health
            {
                let entry = self
                    .health_history
                    .entry(agent.info.name.clone())
                    .or_insert_with(AgentHealthHistory::new);

                let cpu_sample = health.cpu_percent.clamp(0.0, 100.0) as u64;
                entry.push_cpu(cpu_sample);

                let ram_sample = if health.memory_total_gb > 0.0 {
                    ((health.memory_used_gb / health.memory_total_gb) * 100.0).clamp(0.0, 100.0)
                        as u64
                } else {
                    0
                };
                entry.push_ram(ram_sample);
            }
        }

        // Remove history entries for agents that are no longer in the config.
        let active_names: std::collections::HashSet<&str> =
            data.iter().map(|a| a.info.name.as_str()).collect();
        self.health_history
            .retain(|name, _| active_names.contains(name.as_str()));

        self.agents = data;

        // Sync telemetry into the stream view from the matching session.
        if let Some(ref mut sv) = self.stream_view {
            for agent in &self.agents {
                if let Some(session) = agent.sessions.iter().find(|s| s.id == sv.session_id) {
                    sv.model = session.model.clone();
                    sv.rate_limit_utilization = session.rate_limit_utilization;
                    sv.total_cost_usd = session.total_cost_usd;
                    break;
                }
            }
        }

        // Recompute caches now that agent data is updated.
        self.cached_sessions = self.recompute_sessions();
        self.cached_project_summaries = self.recompute_project_summaries();

        // Try to restore selection by session ID.
        if let Some(id) = selected_session_id {
            if let Some(pos) = self.cached_sessions.iter().position(|r| r.session.id == id) {
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

    pub fn update_health_time_series(
        &mut self,
        data: Vec<(String, Vec<nexus_core::proto::HealthTimeSeriesEntry>)>,
    ) {
        for (agent_name, samples) in data {
            self.health_time_series.insert(agent_name, samples);
        }
    }

    pub fn update_session_history(
        &mut self,
        entries: Vec<nexus_core::proto::SessionHistoryEntry>,
    ) {
        self.session_history = entries;
    }

    pub fn update_failure_trends(
        &mut self,
        daily: Vec<nexus_core::proto::FailureTrendEntry>,
        by_tool: Vec<nexus_core::proto::FailureByTool>,
    ) {
        self.failure_trends_daily = daily;
        self.failure_trends_by_tool = by_tool;
    }

    pub fn update_spec_velocity(
        &mut self,
        entries: Vec<nexus_core::proto::SpecVelocityEntry>,
    ) {
        self.spec_velocity = entries;
    }
}

// ---------------------------------------------------------------------------
// Notification system (re-exported from crate::notification)
// ---------------------------------------------------------------------------

// Severity, Notification, NotificationManager — re-exported from crate::notification
// StreamViewState, ThinkingSegment, classify_diff_line, textwrap_simple — re-exported from crate::stream_state

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // ---- NotificationManager -----------------------------------------------

    #[test]
    fn notification_push_adds_to_queue() {
        let mut mgr = NotificationManager::new();
        assert!(mgr.latest().is_none());
        mgr.push("hello".to_string(), Severity::Info);
        assert!(mgr.latest().is_some());
        assert_eq!(mgr.latest().unwrap().message, "hello");
    }

    #[test]
    fn notification_dismiss_all_clears_queue() {
        let mut mgr = NotificationManager::new();
        mgr.push("a".to_string(), Severity::Info);
        mgr.push("b".to_string(), Severity::Warning);
        assert_eq!(mgr.queue.len(), 2);
        mgr.dismiss_all();
        assert!(mgr.queue.is_empty());
        assert!(mgr.latest().is_none());
    }

    #[test]
    fn notification_tick_retains_fresh_entries() {
        let mut mgr = NotificationManager::new();
        mgr.push("fresh".to_string(), Severity::Info);
        // Immediately after pushing, elapsed << 10s — should be retained.
        mgr.tick();
        assert_eq!(mgr.queue.len(), 1, "fresh notification should survive tick");
    }

    #[test]
    fn notification_severity_variants_stored_correctly() {
        let mut mgr = NotificationManager::new();
        mgr.push("info".to_string(), Severity::Info);
        mgr.push("warn".to_string(), Severity::Warning);
        mgr.push("err".to_string(), Severity::Error);
        assert_eq!(mgr.queue.len(), 3);
        assert_eq!(mgr.queue[0].severity, Severity::Info);
        assert_eq!(mgr.queue[1].severity, Severity::Warning);
        assert_eq!(mgr.queue[2].severity, Severity::Error);
    }

    // ---- Session tab management --------------------------------------------

    #[test]
    fn ensure_session_tab_adds_tab_and_sets_active() {
        let mut app = App::new();
        app.open_stream_attach(
            "sess-1".to_string(),
            "label-1".to_string(),
            "agent-a".to_string(),
        );
        let idx = app.ensure_session_tab();
        assert!(idx.is_some());
        assert_eq!(app.session_tabs.len(), 1);
        assert_eq!(app.active_tab, Some(0));
        assert_eq!(app.session_tabs[0].session_id, "sess-1");
    }

    #[test]
    fn ensure_session_tab_deduplicates_same_session() {
        let mut app = App::new();
        app.open_stream_attach(
            "sess-1".to_string(),
            "label-1".to_string(),
            "agent-a".to_string(),
        );
        app.ensure_session_tab();
        // Call again with the same session — should not add a duplicate.
        app.ensure_session_tab();
        assert_eq!(
            app.session_tabs.len(),
            1,
            "duplicate session should not be added"
        );
    }

    #[test]
    fn ensure_session_tab_caps_at_nine() {
        let mut app = App::new();
        // Fill 9 tabs by repeatedly opening different sessions.
        for i in 0..9usize {
            app.open_stream_attach(
                format!("sess-{i}"),
                format!("label-{i}"),
                "agent-a".to_string(),
            );
            app.ensure_session_tab();
        }
        assert_eq!(app.session_tabs.len(), 9);

        // Attempt to add a 10th — should be rejected.
        app.open_stream_attach(
            "sess-tenth".to_string(),
            "label-tenth".to_string(),
            "agent-a".to_string(),
        );
        let result = app.ensure_session_tab();
        assert!(result.is_none(), "10th tab should be rejected (max 9)");
        assert_eq!(app.session_tabs.len(), 9, "tab count should remain at 9");
    }

    #[test]
    fn close_stream_attach_clears_tabs_and_screen() {
        let mut app = App::new();
        app.open_stream_attach(
            "sess-1".to_string(),
            "label-1".to_string(),
            "agent-a".to_string(),
        );
        app.ensure_session_tab();
        assert_eq!(app.current_screen, Screen::StreamAttach);
        app.close_stream_attach();
        assert!(app.stream_view.is_none());
        assert!(app.active_tab.is_none());
        assert_eq!(app.current_screen, Screen::Dashboard);
    }

    // ---- Diff line classification -------------------------------------------

    #[test]
    fn diff_addition_line_classified_as_diff_add() {
        let result = classify_diff_line("+ added line");
        assert_eq!(result, Some(LineStyle::DiffAdd));
    }

    #[test]
    fn diff_removal_line_classified_as_diff_remove() {
        let result = classify_diff_line("- removed line");
        assert_eq!(result, Some(LineStyle::DiffRemove));
    }

    #[test]
    fn diff_header_lines_not_classified_as_changes() {
        assert!(
            classify_diff_line("+++ b/foo.rs").is_none(),
            "+++ is a header"
        );
        assert!(
            classify_diff_line("--- a/foo.rs").is_none(),
            "--- is a header"
        );
    }

    #[test]
    fn diff_context_line_returns_none() {
        assert!(classify_diff_line(" context line").is_none());
        assert!(classify_diff_line("plain text").is_none());
    }

    // ---- Screen cycling ----------------------------------------------------

    #[test]
    fn screen_next_cycles_through_tab_screens() {
        // TAB_SCREENS = [Dashboard, Health, Projects, Specs]
        assert_eq!(Screen::Dashboard.next(), Screen::Health);
        assert_eq!(Screen::Health.next(), Screen::Projects);
        assert_eq!(Screen::Projects.next(), Screen::Specs);
        assert_eq!(Screen::Specs.next(), Screen::Dashboard);
    }

    #[test]
    fn screen_prev_cycles_in_reverse() {
        assert_eq!(Screen::Dashboard.prev(), Screen::Specs);
        assert_eq!(Screen::Specs.prev(), Screen::Projects);
        assert_eq!(Screen::Projects.prev(), Screen::Health);
        assert_eq!(Screen::Health.prev(), Screen::Dashboard);
    }

    #[test]
    fn next_screen_updates_current_screen_and_resets_selection() {
        let mut app = App::new();
        assert_eq!(app.current_screen, Screen::Dashboard);
        app.next_screen();
        assert_eq!(app.current_screen, Screen::Health);
        assert_eq!(app.selected_index, 0);
    }

    #[test]
    fn prev_screen_updates_current_screen_and_resets_selection() {
        let mut app = App::new();
        app.next_screen(); // Dashboard → Health
        app.next_screen(); // Health → Projects
        assert_eq!(app.current_screen, Screen::Projects);
        app.prev_screen(); // Projects → Health
        assert_eq!(app.current_screen, Screen::Health);
        assert_eq!(app.selected_index, 0);
    }

    #[test]
    fn full_screen_cycle_returns_to_start() {
        let mut app = App::new();
        let start = app.current_screen;
        // Cycle through all 4 tab screens and back.
        app.next_screen();
        app.next_screen();
        app.next_screen();
        app.next_screen();
        assert_eq!(app.current_screen, start);
    }

    // ---- Quit flag ---------------------------------------------------------

    #[test]
    fn should_quit_defaults_to_false() {
        let app = App::new();
        assert!(!app.should_quit);
    }

    #[test]
    fn setting_should_quit_to_true_persists() {
        let mut app = App::new();
        app.should_quit = true;
        assert!(app.should_quit);
    }

    // ---- StreamVerbosity ---------------------------------------------------

    #[test]
    fn verbosity_rank_ordering_is_minimal_normal_verbose() {
        assert!(verbosity_rank(StreamVerbosity::Minimal) < verbosity_rank(StreamVerbosity::Normal));
        assert!(verbosity_rank(StreamVerbosity::Normal) < verbosity_rank(StreamVerbosity::Verbose));
    }

    #[test]
    fn line_style_min_verbosity_user_prompt_is_minimal() {
        assert_eq!(
            LineStyle::UserPrompt.min_verbosity(),
            StreamVerbosity::Minimal
        );
    }

    #[test]
    fn line_style_min_verbosity_tool_header_is_normal() {
        assert_eq!(
            LineStyle::ToolHeader.min_verbosity(),
            StreamVerbosity::Normal
        );
    }

    #[test]
    fn stream_line_styled_has_one_display_line() {
        let line = StreamLine::Styled(StyledLine::new("hello", LineStyle::Plain));
        assert_eq!(line.display_lines(), 1);
    }

    #[test]
    fn stream_line_collapsible_collapsed_has_one_display_line() {
        let block = StreamLine::CollapsibleBlock {
            header: StyledLine::new("header", LineStyle::ToolHeader),
            lines: vec![
                StyledLine::new("body1", LineStyle::ToolResult),
                StyledLine::new("body2", LineStyle::ToolResult),
            ],
            expanded: false,
        };
        assert_eq!(block.display_lines(), 1);
    }

    #[test]
    fn stream_line_collapsible_expanded_counts_header_plus_body() {
        let block = StreamLine::CollapsibleBlock {
            header: StyledLine::new("header", LineStyle::ToolHeader),
            lines: vec![
                StyledLine::new("body1", LineStyle::ToolResult),
                StyledLine::new("body2", LineStyle::ToolResult),
            ],
            expanded: true,
        };
        assert_eq!(block.display_lines(), 3); // 1 header + 2 body
    }

    #[test]
    fn stream_line_is_visible_at_correct_verbosity() {
        let tool_line = StreamLine::Styled(StyledLine::new("tool", LineStyle::ToolHeader));
        // Tool lines require Normal — not visible at Minimal.
        assert!(!tool_line.is_visible(StreamVerbosity::Minimal));
        assert!(tool_line.is_visible(StreamVerbosity::Normal));
        assert!(tool_line.is_visible(StreamVerbosity::Verbose));
    }
}
