## Context

The TUI needs an app state machine to manage screen transitions, a render pipeline for three
screens (Dashboard, Health, Projects), and a polling loop that aggregates sessions from all
configured agents via the gRPC client (delivered by spec 4: tui-grpc-client). Brand identity
dictates specific colors, status indicators, typography, and box-drawing conventions.

## Goals / Non-Goals

- Goals:
  - App state struct that holds current screen, selected row, aggregated agent data
  - Event loop: crossterm keyboard events + 2s tick for auto-refresh polling
  - Dashboard screen: grouped-by-project session list with full brand styling
  - Health screen: per-machine metrics with connection status
  - Projects screen: project table with session counts
  - Disconnected agent handling with visual indicators
- Non-Goals:
  - Detail screen (spec 8)
  - Command palette (spec 8)
  - Stream/full attach (spec 9)
  - gRPC StreamEvents (spec 7) — this spec uses polling only

## Decisions

- **App state pattern**: Single `App` struct owns all state. Screens are pure render functions
  that borrow `&App`. No trait objects or dynamic dispatch — match on `Screen` enum.
  - Alternative: Each screen is a trait object with `render()` and `handle_key()`. Rejected
    because ratatui idiom is simpler: plain functions with shared state.

- **Event loop model**: `crossterm::event::poll()` with 200ms timeout for responsive keyboard
  input. Separate 2s `tokio::time::interval` drives agent polling in a background task. Polled
  data is written to `App` state via `tokio::sync::mpsc` channel.
  - Alternative: Single-threaded loop with `select!` on crossterm + timer. Rejected because
    crossterm's blocking `read()` does not play well with tokio select.

- **Color constants**: Defined as a `colors` module (or `const` block) in `app.rs` using
  `ratatui::style::Color::Rgb()`. All brand hex values from `brand-identity.md` mapped to
  named constants: `PRIMARY`, `PRIMARY_BRIGHT`, `PRIMARY_DIM`, `SECONDARY`, `WARNING`, `ERROR`,
  `TEXT`, `DIM`, `BG`, `SURFACE`, `SURFACE_HIGHLIGHT`.
  - Alternative: Use ANSI named colors. Rejected because the brand specifies exact RGB hex values
    and ratatui supports `Color::Rgb`.

- **Session grouping**: Dashboard groups sessions by `session.project` field (Option<String>).
  Sessions with `None` project are grouped under "(no project)". Groups sorted alphabetically
  by project name.

- **Sparkline data**: Each session stores a `Vec<f32>` of recent activity values (heartbeat
  cadence). On each poll tick, the current activity level is appended. Fixed-width window of
  last 8 values. Rendered as braille characters: `⠀⠠⠰⠸⣰⣸⣿` mapping 0.0-1.0 to braille levels.
  - Simplification: MVP sparklines show static patterns based on current status (Active=high,
    Idle=low, Stale=flat, Error=none) rather than tracking historical data. Historical tracking
    deferred to a future spec.

- **Selected row tracking**: Single `usize` index into a flattened list of sessions (across all
  project groups). j/k increment/decrement. Wraps at boundaries. Selection persists across
  refresh ticks (matched by session ID, falls back to clamped index if session disappears).

- **Disconnected agent display**: Agents with `ConnectionStatus::Disconnected` are shown in
  the Dashboard status bar and Health screen with `✖` indicator and `last_seen` timestamp.
  Their sessions are removed from the aggregated list (stale data is worse than missing data).

## Risks / Trade-offs

- **200ms poll timeout**: Keyboard input can lag up to 200ms. Acceptable for a dashboard —
  not a text editor. If users report sluggishness, reduce to 50ms.
- **Sparkline simplification**: Static sparklines based on status lose temporal information.
  Acceptable for MVP — the status dot already conveys the same info. Real sparklines need
  historical heartbeat data which requires agent-side changes.

## Open Questions

- None — all decisions resolved from PRD and brand identity.
