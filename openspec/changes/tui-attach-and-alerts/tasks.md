## 1. Stream Attach View

- [x] 1.1 Create `crates/nexus-tui/src/stream.rs` with `StreamView` struct holding session_id, scrollable log buffer (`Vec<String>`), scroll offset, and a `tokio::sync::mpsc::Receiver<SessionEvent>`
- [x] 1.2 Implement `StreamView::start(client, session_id)` — call gRPC `StreamEvents` with `EventFilter { session_id: Some(id) }`, spawn tokio task that forwards events into bounded mpsc channel (capacity 256)
- [x] 1.3 Implement `StreamView::poll()` — drain channel non-blocking, format each `SessionEvent` variant into a log line (timestamp + event type + payload summary), append to log buffer
- [x] 1.4 Implement `StreamView::render(frame, area)` — render log buffer as scrollable list using ratatui `List` widget, auto-scroll to bottom unless user has scrolled up
- [x] 1.5 Handle 'q' key to exit stream view and return to previous screen
- [x] 1.6 Handle Up/Down/PageUp/PageDown for manual scroll, disable auto-scroll when user scrolls up, re-enable on End key

## 2. Full Attach

- [x] 2.1 Create `crates/nexus-tui/src/attach.rs` with `attach_full(agent_host, agent_user, tmux_session)` async function
- [x] 2.2 On invocation: disable crossterm raw mode via `crossterm::terminal::disable_raw_mode()`, call `crossterm::execute!(stdout, LeaveAlternateScreen)`
- [x] 2.3 Spawn child process: `ssh {user}@{host} -t 'tmux a -t {tmux_session}'` via `tokio::process::Command`, await exit
- [x] 2.4 On child exit: re-enable raw mode via `crossterm::terminal::enable_raw_mode()`, call `crossterm::execute!(stdout, EnterAlternateScreen)`, return to dashboard
- [x] 2.5 Handle child process failure (tmux session not found, SSH failure) — return error to caller for status bar display

## 3. Notification System

- [x] 3.1 Create `crates/nexus-tui/src/notifications.rs` with `NotificationManager` struct holding notification queue (`VecDeque<Notification>`) and background event subscription
- [x] 3.2 Define `Notification` struct: message string, severity (Warning/Error), created_at timestamp
- [x] 3.3 Implement `NotificationManager::start(client)` — subscribe to `StreamEvents` with empty filter (all sessions), spawn background task that watches for `StatusChanged` events where new status is Stale or Errored
- [x] 3.4 On status transition: push notification with format "session_label errored" or "session_label stale (duration)" where session_label is `{project}#{short_id}` (e.g., "oo#1")
- [x] 3.5 Implement `NotificationManager::poll()` — remove notifications older than 10s
- [x] 3.6 Implement `NotificationManager::dismiss_all()` — clear queue on any keypress (called from app event loop)
- [x] 3.7 Implement `NotificationManager::render(frame, area)` — render most recent notification in status bar area, color-coded: yellow for Stale, red for Errored

## 4. App Integration

- [x] 4.1 Add `StreamView` and `Attaching` variants to the screen enum in `app.rs`
- [x] 4.2 Wire 'a' key handler: when a session is selected on dashboard or detail, transition to `StreamView` screen, call `StreamView::start()` with selected session
- [x] 4.3 Wire 'A' key handler: when a session is selected, check `session_type == Managed`; if yes, call `attach_full()` with agent host/user and tmux_session; if ad-hoc, show status bar message "ad-hoc session -- stream only (start via nexus for full attach)"
- [x] 4.4 Integrate `NotificationManager` into app state: start on app init, poll on each tick, render in status bar area
- [x] 4.5 Call `NotificationManager::dismiss_all()` on any keypress event in the main event loop
- [x] 4.6 Add `mod stream; mod attach; mod notifications;` to `main.rs`

## 5. Verification

- [x] 5.1 `cargo build -p nexus-tui` compiles without errors
- [x] 5.2 `cargo clippy -p nexus-tui` passes with no warnings
- [x] 5.3 `cargo fmt --check` passes
