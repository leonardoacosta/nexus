## 1. Color Constants and Shared Types

- [x] 1.1 Define color constants module in `app.rs` with all brand palette values as `Color::Rgb` (PRIMARY, PRIMARY_BRIGHT, PRIMARY_DIM, SECONDARY, WARNING, ERROR, TEXT, DIM, BG, SURFACE, SURFACE_HIGHLIGHT)
- [x] 1.2 Define `Screen` enum: `Dashboard`, `Health`, `Projects` (Detail and Palette added in spec 8)
- [x] 1.3 Define `AgentData` struct: agent name, connection status, sessions vec, health option, last_seen timestamp

## 2. App State

- [x] 2.1 Define `App` struct: current screen, agents vec, selected_index, should_quit flag, uptime tracker
- [x] 2.2 Implement `App::new()` — initialize with Dashboard screen, empty agents, index 0
- [x] 2.3 Implement `App::next_screen()` / `App::prev_screen()` — Tab cycles through Screen enum
- [x] 2.4 Implement `App::move_up()` / `App::move_down()` — j/k navigation with bounds clamping
- [x] 2.5 Implement `App::all_sessions()` — flatten agents into sorted-by-project session list for Dashboard
- [x] 2.6 Implement `App::session_count()` / `App::agent_count()` — aggregation helpers for status bar
- [x] 2.7 Implement `App::update_agents(data: Vec<AgentData>)` — replace agent data from poll, preserve selected_index by session ID

## 3. Dashboard Screen

- [x] 3.1 Implement `render_dashboard(frame, app)` — layout: title bar, session list, status bar
- [x] 3.2 Render sessions grouped by project with group headers (project name, session count)
- [x] 3.3 Render per-session row: status dot (● ○ ◌ ✖), type indicator ([M]/[A]), project, branch, age, command/spec, sparkline
- [x] 3.4 Apply brand colors: green=active, amber=idle, dim=stale, red=error
- [x] 3.5 Highlight selected row with PRIMARY_DIM background (#0A4A2A)
- [x] 3.6 Render title bar: "SESSION DASHBOARD" uppercase bold green
- [x] 3.7 Render status bar: "{N} agents . {N} sessions . uptime"

## 4. Health Screen

- [x] 4.1 Implement `render_health(frame, app)` — layout: title bar, agent cards, status bar
- [x] 4.2 Render per-agent card: name, host, connection status indicator
- [x] 4.3 Render machine metrics: CPU %, RAM used/total, disk used/total, load avg, uptime
- [x] 4.4 Render Docker container list with running/stopped indicators
- [x] 4.5 Disconnected agents: show ✖ in red with "last seen {duration} ago"
- [x] 4.6 Render title bar: "HEALTH OVERVIEW" uppercase bold green

## 5. Projects Screen

- [x] 5.1 Implement `render_projects(frame, app)` — layout: title bar, project table, status bar
- [x] 5.2 Render table: project code, total sessions, active/idle/stale/error counts, agents hosting
- [x] 5.3 Highlight selected row, j/k navigation within project table
- [x] 5.4 Render title bar: "PROJECT OVERVIEW" uppercase bold green

## 6. Screen Module Wiring

- [x] 6.1 Update `screens.rs` to export render functions from dashboard, health, projects submodules

## 7. Main Event Loop

- [x] 7.1 Terminal setup: `crossterm::terminal::enable_raw_mode()`, `EnterAlternateScreen`, `CrosstermBackend`
- [x] 7.2 Terminal teardown: `disable_raw_mode()`, `LeaveAlternateScreen` (in Drop or defer)
- [x] 7.3 Load config via `NexusConfig::load()`, create `NexusClient` from spec 4
- [x] 7.4 Spawn background polling task: 2s `tokio::time::interval`, calls `client.get_sessions()`, sends `AgentData` via `mpsc::channel`
- [x] 7.5 Main loop: `crossterm::event::poll(200ms)` for keyboard, check mpsc channel for agent data updates
- [x] 7.6 Dispatch keyboard: `q` = quit, `j`/`Down` = move_down, `k`/`Up` = move_up, `Tab` = next_screen, `BackTab` = prev_screen
- [x] 7.7 Render: match `app.current_screen` to call the appropriate `render_*` function
- [x] 7.8 Handle graceful shutdown on `q` keypress or Ctrl+C

## 8. Verification

- [x] 8.1 `cargo build -p nexus-tui` compiles without errors
- [x] 8.2 `cargo clippy -p nexus-tui` passes with no warnings
- [x] 8.3 `cargo fmt --check` passes
