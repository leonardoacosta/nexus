## ADDED Requirements

### Requirement: TUI Key Handler Extraction
All per-mode key handler functions SHALL be extracted from `main.rs` into dedicated key handler modules. `main.rs` SHALL retain only the event loop, startup, and top-level dispatch.

#### Scenario: Key handlers extracted from main.rs
- **WHEN** per-mode key handlers (handle_list_key, handle_detail_key, handle_stream_key, handle_palette_key, handle_notification_panel_key, handle_agent_select_key, handle_project_select_key, handle_cwd_input_key, handle_stream_search_key) are moved to key handler modules
- **THEN** main.rs dispatches to the extracted modules and contains under 400 lines

#### Scenario: Build and tests pass after key handler extraction
- **WHEN** key handlers are extracted
- **THEN** cargo build -p nexus-tui and cargo test -p nexus-tui pass with no regressions

### Requirement: TUI App Module Decomposition
`StreamViewState`, `NotificationManager`, and format/color utilities SHALL be extracted from `app.rs` into focused modules. `app.rs` SHALL retain only the `App` struct definition and core state management.

#### Scenario: StreamViewState extracted
- **WHEN** StreamViewState and its impl blocks are moved to stream_state.rs
- **THEN** app.rs no longer contains StreamViewState and imports it from the new module

#### Scenario: Format and color utilities extracted
- **WHEN** format_duration, format_age, status_dot, status_color, status_sparkline, and session_type_indicator are moved to theme.rs
- **THEN** app.rs no longer contains these functions and imports them from the new module

#### Scenario: App.rs reduced in size
- **WHEN** all extractions are complete
- **THEN** app.rs contains under 800 lines focused on App struct and core state
