# Implementation Tasks

<!-- beads:epic:TBD -->

## Extract from app.rs Batch

- [ ] [1.1] [P-1] Extract StreamViewState + impl blocks (~420 lines) into stream_state.rs [owner:engineer]
- [ ] [1.2] [P-1] Extract NotificationManager + notification types into notification.rs [owner:engineer]
- [ ] [1.3] [P-1] Extract format/color utilities (format_duration, format_age, status_dot, status_color, status_sparkline, session_type_indicator) into theme.rs [owner:engineer]
- [ ] [1.4] [P-2] Update app.rs imports to use new modules, keep App struct + core state only [owner:engineer]

## Extract from main.rs Batch

- [ ] [2.1] [P-1] Extract per-mode key handlers (handle_list_key, handle_detail_key, handle_stream_key, etc.) into keys.rs or keys/ directory [owner:engineer]
- [ ] [2.2] [P-2] Extract mouse handler, tab rendering, editor launcher into ui_helpers.rs [owner:engineer]
- [ ] [2.3] [P-2] Update main.rs to dispatch to extracted modules, keep event loop + startup only [owner:engineer]

## Verification Batch

- [ ] [3.1] Verify cargo build -p nexus-tui succeeds [owner:engineer]
- [ ] [3.2] Verify cargo test -p nexus-tui passes with no regressions [owner:engineer]
- [ ] [3.3] Verify main.rs is under 400 lines and app.rs is under 800 lines [owner:engineer]
