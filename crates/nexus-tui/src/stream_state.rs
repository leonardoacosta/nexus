//! Stream view state extracted from app.rs.
//!
//! Contains StreamViewState, ThinkingSegment, classify_diff_line, textwrap_simple.

use std::time::Instant;

use crate::app::{CodeBlockRange, LineStyle, SearchState, StreamLine, StreamVerbosity, StyledLine};
use crate::markdown;

/// State for the stream attach view (rendered by screens/stream.rs).
pub struct StreamViewState {
    pub session_id: String,
    pub session_label: String,
    pub agent_name: String,
    pub lines: Vec<StreamLine>,
    pub scroll_offset: usize,
    pub auto_scroll: bool,
    /// Buffer for accumulating partial text chunks.
    pub partial_buf: String,
    /// Buffer for accumulating complete lines before markdown rendering.
    markdown_buf: String,

    // Telemetry fields (updated from session data on poll).
    pub model: Option<String>,
    pub rate_limit_utilization: Option<f32>,
    pub total_cost_usd: Option<f64>,

    // Session metadata.
    pub session_type: Option<String>,

    // Heartbeat tracking.
    pub last_heartbeat_ts: Option<String>,
    pub heartbeat_alive: bool,
    pub last_heartbeat_tick: usize,

    // Input history.
    pub input_history: Vec<String>,
    pub history_index: Option<usize>,

    // Verbosity filter.
    pub verbosity: StreamVerbosity,

    // Message framing.
    pub assistant_header_emitted: bool,

    // System event count.
    pub system_event_count: usize,

    // Event debouncing.
    pub last_status_event: Option<(String, Instant)>,

    // Search state.
    pub search: Option<SearchState>,

    // Code block ranges.
    pub code_blocks: Vec<CodeBlockRange>,

    // Transient notification.
    pub notification_message: Option<(String, usize)>,

    /// Current terminal width for text wrapping (updated by the render loop).
    pub terminal_width: u16,

    /// Cached total display lines — invalidated on push/toggle.
    cached_total_display_lines: usize,
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
            partial_buf: String::new(),
            markdown_buf: String::new(),
            model: None,
            rate_limit_utilization: None,
            total_cost_usd: None,
            session_type: None,
            last_heartbeat_ts: None,
            heartbeat_alive: false,
            last_heartbeat_tick: 0,
            input_history: Vec::new(),
            history_index: None,
            verbosity: StreamVerbosity::default(),
            assistant_header_emitted: false,
            system_event_count: 0,
            last_status_event: None,
            search: None,
            code_blocks: Vec::new(),
            notification_message: None,
            terminal_width: 120,
            cached_total_display_lines: 0,
        }
    }

    pub fn push_history(&mut self, prompt: String) {
        if !prompt.is_empty() {
            self.input_history.push(prompt);
            const MAX_HISTORY: usize = 50;
            if self.input_history.len() > MAX_HISTORY {
                let excess = self.input_history.len() - MAX_HISTORY;
                self.input_history.drain(0..excess);
            }
        }
        self.history_index = None;
    }

    pub fn push_line(&mut self, line: StyledLine) {
        self.push_stream_line(StreamLine::Styled(line));
    }

    fn push_markdown(&mut self, text: &str, width: u16) {
        let rich_lines = markdown::render_markdown(text, width);
        for line in rich_lines {
            self.push_stream_line(StreamLine::RichText { line });
        }
    }

    fn accumulate_markdown_line(&mut self, line: &str) {
        if !self.markdown_buf.is_empty() {
            self.markdown_buf.push('\n');
        }
        self.markdown_buf.push_str(line);
    }

    fn flush_markdown_buf(&mut self) {
        if self.markdown_buf.is_empty() {
            return;
        }
        let buf = std::mem::take(&mut self.markdown_buf);
        let width = self.terminal_width;
        self.push_markdown(&buf, width);
    }

    pub fn push_stream_line(&mut self, entry: StreamLine) {
        self.cached_total_display_lines += entry.display_lines();
        self.lines.push(entry);
        if self.lines.len() > MAX_STREAM_LINES {
            let excess = self.lines.len() - MAX_STREAM_LINES;
            let drained_display: usize = self.lines[..excess]
                .iter()
                .map(|l| l.display_lines())
                .sum();
            self.cached_total_display_lines -= drained_display;
            self.lines.drain(0..excess);
            self.scroll_offset = self.scroll_offset.saturating_sub(excess);
        }
    }

    pub fn total_display_lines(&self) -> usize {
        self.cached_total_display_lines
    }

    fn recompute_display_lines(&mut self) {
        self.cached_total_display_lines = self.lines.iter().map(|l| l.display_lines()).sum();
    }

    pub fn scroll_up(&mut self) {
        if self.scroll_offset > 0 {
            self.scroll_offset -= 1;
        }
        self.auto_scroll = false;
    }

    pub fn scroll_down(&mut self, visible_height: usize) {
        let total = self.total_display_lines();
        let max = total.saturating_sub(visible_height);
        if self.scroll_offset < max {
            self.scroll_offset += 1;
        }
        if self.scroll_offset >= max {
            self.auto_scroll = true;
        }
    }

    pub fn page_up(&mut self, visible_height: usize) {
        self.scroll_offset = self.scroll_offset.saturating_sub(visible_height);
        self.auto_scroll = false;
    }

    pub fn page_down(&mut self, visible_height: usize) {
        let total = self.total_display_lines();
        let max = total.saturating_sub(visible_height);
        self.scroll_offset = (self.scroll_offset + visible_height).min(max);
        if self.scroll_offset >= max {
            self.auto_scroll = true;
        }
    }

    pub fn scroll_to_end(&mut self) {
        self.auto_scroll = true;
    }

    pub fn update_auto_scroll(&mut self, visible_height: usize) {
        if self.auto_scroll {
            let total = self.total_display_lines();
            self.scroll_offset = total.saturating_sub(visible_height);
        }
    }

    pub fn toggle_block_at_scroll(&mut self, visible_height: usize) {
        let target = self.scroll_offset;
        let mut display_pos: usize = 0;
        for entry in self.lines.iter_mut() {
            let entry_display = entry.display_lines();
            if display_pos + entry_display > target {
                if let StreamLine::CollapsibleBlock { expanded, .. } = entry {
                    *expanded = !*expanded;
                }
                break;
            }
            display_pos += entry_display;
        }
        self.recompute_display_lines();
        let total = self.cached_total_display_lines;
        let max = total.saturating_sub(visible_height);
        if self.auto_scroll {
            self.scroll_offset = max;
        } else {
            self.scroll_offset = self.scroll_offset.min(max);
        }
    }

    pub fn push_command_output(&mut self, output: &nexus_core::proto::CommandOutput) {
        use nexus_core::proto::command_output::Content;

        match &output.content {
            Some(Content::Text(chunk)) => {
                if !self.assistant_header_emitted {
                    self.push_line(StyledLine::new(
                        "\u{2500}\u{2500} assistant \u{2500}\u{2500}",
                        LineStyle::AssistantHeader,
                    ));
                    self.assistant_header_emitted = true;
                }

                if chunk.partial {
                    self.partial_buf.push_str(&chunk.text);
                    while let Some(nl_pos) = self.partial_buf.find('\n') {
                        let line = self.partial_buf[..nl_pos].to_string();
                        self.partial_buf = self.partial_buf[nl_pos + 1..].to_string();
                        self.accumulate_markdown_line(&line);
                    }
                } else {
                    self.flush_partial_buf();
                    let text = &chunk.text;
                    let processed = Self::extract_thinking_blocks(text);
                    for segment in processed {
                        match segment {
                            ThinkingSegment::Text(t) => {
                                for line in t.lines() {
                                    self.accumulate_markdown_line(line);
                                }
                            }
                            ThinkingSegment::Thinking(content) => {
                                self.flush_markdown_buf();
                                let line_count = content.lines().count();
                                let header_text = format!(
                                    "\u{2500}\u{2500} thinking ({line_count} lines) \u{2500}\u{2500}"
                                );
                                let body_lines: Vec<StyledLine> = content
                                    .lines()
                                    .map(|l| StyledLine::new(l.to_string(), LineStyle::Plain))
                                    .collect();
                                self.push_stream_line(StreamLine::CollapsibleBlock {
                                    header: StyledLine::new(header_text, LineStyle::DoneSummary),
                                    lines: body_lines,
                                    expanded: false,
                                });
                            }
                        }
                    }
                    self.flush_markdown_buf();
                }
            }
            Some(Content::ToolUse(info)) => {
                self.flush_partial_buf();
                let header = format!("\u{23FA} {}", info.tool_name);
                for wrapped in textwrap_simple(&header, self.terminal_width as usize) {
                    self.push_line(StyledLine::new(wrapped, LineStyle::ToolHeader));
                }
                let input = format!("  $ {}", info.input_preview);
                for wrapped in textwrap_simple(&input, self.terminal_width as usize) {
                    self.push_line(StyledLine::new(wrapped, LineStyle::ToolInput));
                }
            }
            Some(Content::ToolResult(result)) => {
                self.flush_partial_buf();
                let (icon, style) = if result.success {
                    ("\u{2713}", LineStyle::ToolResult)
                } else {
                    ("\u{2717}", LineStyle::ToolError)
                };
                let line_count = result.output_preview.lines().count();
                if line_count > 5 {
                    let body_lines: Vec<StyledLine> = result
                        .output_preview
                        .lines()
                        .flat_map(|l| {
                            let diff_style = classify_diff_line(l);
                            textwrap_simple(l, 116).into_iter().map(move |wrapped| {
                                StyledLine::new(
                                    format!("    {wrapped}"),
                                    diff_style.unwrap_or(style),
                                )
                            })
                        })
                        .collect();
                    let header_text = format!(
                        "  {icon} {} [+{} lines] [Enter] to expand",
                        result.tool_name,
                        body_lines.len()
                    );
                    let header = StyledLine::new(header_text, style);
                    self.push_stream_line(StreamLine::CollapsibleBlock {
                        header,
                        lines: body_lines,
                        expanded: false,
                    });
                } else {
                    for l in result.output_preview.lines() {
                        let diff_style = classify_diff_line(l);
                        let line_text = format!("  {icon} {}: {l}", result.tool_name);
                        for wrapped in textwrap_simple(&line_text, self.terminal_width as usize) {
                            self.push_line(StyledLine::new(wrapped, diff_style.unwrap_or(style)));
                        }
                    }
                    if result.output_preview.is_empty() {
                        let line = format!("  {icon} {}", result.tool_name);
                        self.push_line(StyledLine::new(line, style));
                    }
                }
            }
            Some(Content::Error(err)) => {
                self.flush_partial_buf();
                let line = format!("ERROR: {} (exit {})", err.message, err.exit_code);
                self.push_line(StyledLine::new(line, LineStyle::Error));
            }
            Some(Content::Done(done)) => {
                self.flush_partial_buf();
                let line = format!(
                    "\u{2500}\u{2500} done ({:.1}s, {} tool calls) \u{2500}\u{2500}",
                    done.duration_ms as f64 / 1000.0,
                    done.tool_calls
                );
                self.push_line(StyledLine::new(line, LineStyle::DoneSummary));
                self.push_line(StyledLine::new("", LineStyle::Plain));
                self.assistant_header_emitted = false;
            }
            Some(Content::Progress(progress)) => {
                self.flush_partial_buf();
                let pct = progress
                    .percent
                    .map(|p| format!(" {p:.0}%"))
                    .unwrap_or_default();
                let summary = if progress.summary.is_empty() {
                    String::new()
                } else {
                    format!(" \u{2014} {}", progress.summary)
                };
                let line = format!("\u{25B6} [{}]{pct}{summary}", progress.phase);
                self.push_line(StyledLine::new(line, LineStyle::Plain));
            }
            None => {}
        }
    }

    fn flush_partial_buf(&mut self) {
        if !self.partial_buf.is_empty() {
            let buf = std::mem::take(&mut self.partial_buf);
            for line in buf.lines() {
                self.accumulate_markdown_line(line);
            }
        }
        self.flush_markdown_buf();
    }
}

// ---------------------------------------------------------------------------
// Thinking block extraction
// ---------------------------------------------------------------------------

enum ThinkingSegment {
    Text(String),
    Thinking(String),
}

impl StreamViewState {
    fn extract_thinking_blocks(text: &str) -> Vec<ThinkingSegment> {
        let mut segments = Vec::new();
        let mut remaining = text;

        loop {
            if let Some(start_idx) = remaining.find("<thinking>") {
                let before = &remaining[..start_idx];
                if !before.is_empty() {
                    segments.push(ThinkingSegment::Text(before.to_string()));
                }
                let after_open = &remaining[start_idx + "<thinking>".len()..];
                if let Some(end_idx) = after_open.find("</thinking>") {
                    let content = &after_open[..end_idx];
                    segments.push(ThinkingSegment::Thinking(content.to_string()));
                    remaining = &after_open[end_idx + "</thinking>".len()..];
                } else {
                    segments.push(ThinkingSegment::Thinking(after_open.to_string()));
                    break;
                }
            } else {
                if !remaining.is_empty() {
                    segments.push(ThinkingSegment::Text(remaining.to_string()));
                }
                break;
            }
        }

        if segments.is_empty() {
            segments.push(ThinkingSegment::Text(text.to_string()));
        }
        segments
    }
}

// ---------------------------------------------------------------------------
// Diff line classification
// ---------------------------------------------------------------------------

/// Classify a line as a diff addition, removal, or neither.
pub fn classify_diff_line(line: &str) -> Option<LineStyle> {
    let trimmed = line.trim_start();
    if trimmed.starts_with("+++") || trimmed.starts_with("---") {
        None
    } else if trimmed.starts_with('+') {
        Some(LineStyle::DiffAdd)
    } else if trimmed.starts_with('-') {
        Some(LineStyle::DiffRemove)
    } else {
        None
    }
}

/// Simple character-boundary line wrapping for stream output.
pub(crate) fn textwrap_simple(text: &str, width: usize) -> Vec<String> {
    if text.len() <= width {
        return vec![text.to_string()];
    }
    text.chars()
        .collect::<Vec<_>>()
        .chunks(width)
        .map(|c| c.iter().collect::<String>())
        .collect()
}
