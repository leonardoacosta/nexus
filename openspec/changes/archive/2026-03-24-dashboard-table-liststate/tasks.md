## 1. State Migration
- [ ] 1.1 Add `dashboard_table_state: TableState` field to App struct (app.rs ~line 374)
- [ ] 1.2 Initialize TableState with `selected(Some(0))` in App::new()
- [ ] 1.3 Update `move_up()` / `move_down()` in dashboard context to use `TableState::select()` instead of bare `selected_index`

## 2. Table Rendering
- [ ] 2.1 Replace manual Line composition (dashboard.rs lines 49-179) with `Table::new(rows, widths)` + `Row::new()` per session
- [ ] 2.2 Add header row with column labels (Status, Session, Project, Branch, Uptime, Agent, etc.)
- [ ] 2.3 Define column width constraints using `Constraint::Length` / `Constraint::Min` / `Constraint::Fill`
- [ ] 2.4 Preserve project group headers as styled separator rows (non-selectable)
- [ ] 2.5 Preserve status-colored dots and session formatting from current Line composition
- [ ] 2.6 Apply highlight style to selected row via `Table::highlight_style()`

## 3. Scrollbar
- [ ] 3.1 Add `Scrollbar::new(ScrollbarOrientation::VerticalRight)` alongside the Table
- [ ] 3.2 Create `ScrollbarState` from table content length + viewport height
- [ ] 3.3 Position scrollbar to track `TableState` selection

## 4. Key Handler Update
- [ ] 4.1 Update main.rs dashboard key handlers (Up/Down/Enter) to drive `dashboard_table_state` instead of `selected_index`
- [ ] 4.2 Ensure Enter on a session row still navigates to stream/detail view

## 5. Validation
- [ ] 5.1 `cargo build` passes
- [ ] 5.2 `cargo test` — all tests pass
- [ ] 5.3 Manual smoke: launch TUI, verify table columns align, selection scrolls, scrollbar tracks position
