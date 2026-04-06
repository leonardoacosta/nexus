## MODIFIED Requirements

### Requirement: TUI Key Handler Extraction
All per-mode key handler functions SHALL be extracted from `main.rs` into dedicated key handler
modules. `main.rs` SHALL retain only the event loop, startup, and top-level dispatch. Every key
handler module SHALL emit a structured `tracing::debug!` call for each dispatched key event,
gated behind the `nexus_tui::keys` target so it only appears when `RUST_LOG=nexus_tui::keys=debug`
is set.

#### Scenario: Key handlers extracted from main.rs
- **WHEN** per-mode key handlers (handle_list_key, handle_detail_key, handle_stream_key,
  handle_palette_key, handle_notification_panel_key, handle_agent_select_key,
  handle_project_select_key, handle_cwd_input_key, handle_stream_search_key) are moved to key
  handler modules
- **THEN** main.rs dispatches to the extracted modules and contains under 400 lines

#### Scenario: Build and tests pass after key handler extraction
- **WHEN** key handlers are extracted
- **THEN** `cargo build -p nexus-tui` and `cargo test -p nexus-tui` pass with no regressions

#### Scenario: Key events logged at debug level
- **WHEN** `RUST_LOG=nexus_tui::keys=debug` is set
- **AND** the user presses any key
- **THEN** a structured debug log line is emitted containing the key code and current mode

#### Scenario: Key logging suppressed by default
- **WHEN** `RUST_LOG` does not include `nexus_tui::keys=debug`
- **THEN** no per-key log lines appear in the output

### Requirement: TUI App Module Decomposition
`StreamViewState`, `NotificationManager`, and format/color utilities SHALL be extracted from
`app.rs` into focused modules. `app.rs` SHALL retain only the `App` struct definition and core
state management. The stream buffer within `StreamViewState` SHALL use `VecDeque<StreamLine>`
with a maximum capacity of `STREAM_BUFFER_MAX = 10_000` lines; when new lines arrive that
exceed the cap, the oldest lines SHALL be evicted from the front.

#### Scenario: StreamViewState extracted
- **WHEN** StreamViewState and its impl blocks are moved to stream_state.rs
- **THEN** app.rs no longer contains StreamViewState and imports it from the new module

#### Scenario: Format and color utilities extracted
- **WHEN** format_duration, format_age, status_dot, status_color, status_sparkline, and
  session_type_indicator are moved to theme.rs
- **THEN** app.rs no longer contains these functions and imports them from the new module

#### Scenario: App.rs reduced in size
- **WHEN** all extractions are complete
- **THEN** app.rs contains under 800 lines focused on App struct and core state

#### Scenario: Stream buffer evicts oldest lines at cap
- **WHEN** `STREAM_BUFFER_MAX` lines are already in the buffer
- **AND** a new line arrives
- **THEN** the oldest line is removed from the front
- **AND** the buffer length remains `STREAM_BUFFER_MAX`

#### Scenario: Stream buffer cap indicated to user
- **WHEN** at least one line has been evicted
- **THEN** the stream view displays a dim header line: "Showing last 10,000 lines"

## ADDED Requirements

### Requirement: Navigation state machine unit tests
The navigation state transitions SHALL be covered by unit tests in the `nexus-tui` crate.
Tests SHALL cover all primary transitions and boundary conditions without requiring a running
terminal.

#### Scenario: Dashboard to Detail transition
- **WHEN** `handle_list_key` receives the select/enter key on a non-empty session list
- **THEN** the app mode transitions to `AppMode::Detail` with the correct session ID

#### Scenario: Detail to Dashboard transition
- **WHEN** `handle_detail_key` receives the back/Esc key
- **THEN** the app mode transitions back to `AppMode::List`

#### Scenario: Palette opens from Projects and returns
- **WHEN** `handle_project_select_key` opens the palette
- **AND** the palette is closed via Esc
- **THEN** the app mode returns to `AppMode::Projects` (not `AppMode::List`)

#### Scenario: Navigate past end of list
- **WHEN** the focused index is at the last item
- **AND** the user presses Down
- **THEN** the focused index remains at the last item (no wrap or panic)

#### Scenario: Navigate on empty list
- **WHEN** the session list is empty
- **AND** the user presses Up or Down
- **THEN** the focused index remains 0 and no panic occurs
