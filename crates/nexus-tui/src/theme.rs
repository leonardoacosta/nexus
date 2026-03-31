//! Format/color utilities extracted from app.rs

use chrono::{DateTime, Utc};
use nexus_core::session::{Session, SessionStatus};
use ratatui::style::Color;

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

/// Type indicator for a session: [M] if managed (has tmux_session), [A] if ad-hoc.
pub fn session_type_indicator(session: &Session) -> &'static str {
    if session.tmux_session.is_some() {
        "[M]"
    } else {
        "[A]"
    }
}
