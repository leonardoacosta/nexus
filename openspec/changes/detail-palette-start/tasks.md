## 1. Session Detail Screen

- [x] 1.1 Implement `render_detail()` in `detail.rs` that takes `&Session`, `&AgentInfo`, and `Frame` and renders full session metadata
- [x] 1.2 Layout: title bar ("SESSION DETAIL"), key-value pairs in two columns using box-drawing borders (consistent with dashboard)
- [x] 1.3 Display fields: session ID, PID, project, branch, cwd, started_at, age (human-readable), status (with color dot), spec, command, agent, type ([M]/[A]), tmux session name
- [x] 1.4 Status dot uses brand colors: Active (#00D26A), Idle (#FFB700), Stale (#666666), Errored (#FF3B3B)
- [x] 1.5 Footer shows keybindings: `q` back, `a` stream attach, `A` full attach (managed only), `s` stop session

## 2. Command Palette Screen

- [x] 2.1 Implement `render_palette()` in `palette.rs` as an overlay rendered on top of the current screen
- [x] 2.2 Input line at top with `>` prompt and blinking cursor; results list below
- [x] 2.3 Implement fuzzy match function: case-insensitive substring matching on session name/project/ID and action names
- [x] 2.4 Populate palette entries: all sessions (label: `project:branch (agent)`) , all screens (Dashboard, Health, Projects), actions (Start Session, Stop Session)
- [x] 2.5 Results update on every keystroke; j/k or arrow keys to navigate results; Enter to select; Esc to dismiss
- [x] 2.6 Selected result action: sessions navigate to Detail screen; screens switch to that screen; Start Session triggers the start flow

## 3. App State Extensions

- [x] 3.1 Add `InputMode` enum to `app.rs`: `Normal`, `PaletteInput`, `StartSessionAgent`, `StartSessionProject`, `StartSessionCwd`
- [x] 3.2 Add palette state to App: `palette_query: String`, `palette_results: Vec<PaletteEntry>`, `palette_selected: usize`
- [x] 3.3 Add start session wizard state to App: `start_agent_idx: usize`, `start_project: String`, `start_cwd: String`
- [x] 3.4 Add `selected_session: Option<(Session, AgentInfo)>` for Detail screen context

## 4. Key Bindings and Screen Transitions

- [x] 4.1 `:` or `/` key in Normal mode -> switch to `InputMode::PaletteInput`, show palette overlay
- [x] 4.2 `n` key in Normal mode from Dashboard -> if single agent, skip to `StartSessionProject`; if multiple agents, enter `StartSessionAgent` (show agent list with j/k selection)
- [x] 4.3 Enter key on dashboard selected row -> switch to `Screen::Detail` with selected session
- [x] 4.4 `q` key on Detail screen -> return to Dashboard
- [x] 4.5 Esc key in any input mode -> cancel and return to `InputMode::Normal`

## 5. Start Session Flow

- [x] 5.1 Agent selection (if multiple): render agent list with j/k navigation, Enter to select, Esc to cancel
- [x] 5.2 Project input: text input field with prompt "project:", Enter to confirm (store in `start_project`)
- [x] 5.3 CWD input: text input field with prompt "cwd:", Enter to confirm (store in `start_cwd`)
- [x] 5.4 On final Enter: call `NexusClient::start_session(agent, project, cwd)` via gRPC `StartSession` RPC
- [x] 5.5 On success: return to Dashboard, new managed session appears on next poll cycle
- [x] 5.6 On error: display error in status bar, return to Normal mode

## 6. Verification

- [x] 6.1 `cargo build -p nexus-tui` compiles without errors
- [x] 6.2 `cargo clippy -p nexus-tui` passes
- [x] 6.3 `cargo fmt --check` passes
