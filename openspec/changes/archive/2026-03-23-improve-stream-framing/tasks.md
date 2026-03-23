## 1. Message Framing
- [x] 1.1 Added `LineStyle::UserHeader` and `LineStyle::AssistantHeader` variants
- [x] 1.2 User messages render with green `│ ` left-border accent via `render_styled_line()` helper
- [x] 1.3 "── assistant ──" header emitted before first text chunk, tracked via `assistant_header_emitted`
- [x] 1.4 Blank separator lines after done summaries; reset tracking on Done events
- [x] 1.5 UserHeader → PRIMARY+DIM, AssistantHeader → SECONDARY+DIM (consistent rule pattern)

## 2. Event Filtering
- [x] 2.1 `StreamVerbosity` enum (Minimal/Normal/Verbose) added, default Normal
- [x] 2.2 Minimal: UserPrompt, UserHeader, AssistantText, AssistantHeader, RichText, DoneSummary
- [x] 2.3 Normal: + ToolHeader, ToolInput, ToolResult, ToolError, Error, Plain, CollapsibleBlock
- [x] 2.4 Verbose: everything
- [x] 2.5 `v` key cycles verbosity in StreamAttach normal mode
- [x] 2.6 Event debouncing: skip duplicate status text within 5s via `last_status_event`

## 3. Status Bar Enhancements
- [x] 3.1 Verbosity indicator [M]/[N]/[V] in status bar
- [x] 3.2 System event count "{N} sys" shown when count > 0

## 4. Validation
- [x] 4.1 User/assistant blocks visually distinct (border + headers + colors)
- [x] 4.2 Verbosity toggle cycles, render-time filtering applies immediately
- [x] 4.3 Collapsible blocks and tool rendering preserved
- [x] 4.4 `cargo clippy && cargo test` — 32 tests pass, 0 clippy warnings
