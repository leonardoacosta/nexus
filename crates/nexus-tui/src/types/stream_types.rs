use ratatui::text::Line;

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
pub fn verbosity_rank(v: StreamVerbosity) -> u8 {
    match v {
        StreamVerbosity::Minimal => 0,
        StreamVerbosity::Normal => 1,
        StreamVerbosity::Verbose => 2,
    }
}
