## 1. Message Framing
- [ ] 1.1 Add `LineStyle::UserHeader` and `LineStyle::AssistantHeader` variants for section headers
- [ ] 1.2 Render user messages with green left-border accent (use `│` character as first column)
- [ ] 1.3 Add "── assistant ──" header line (styled `SECONDARY`, dim) before each assistant response block
- [ ] 1.4 Add blank separator lines between message groups (user block, assistant block, done summary)
- [ ] 1.5 Style "── you ──" and "── assistant ──" consistently with `DoneSummary` horizontal rule pattern

## 2. Event Filtering
- [ ] 2.1 Add `StreamVerbosity` enum: `Minimal`, `Normal`, `Verbose` to `StreamViewState`
- [ ] 2.2 Minimal mode: show only user prompts + assistant text + done summaries (hide tool calls, system events)
- [ ] 2.3 Normal mode (default): show user + assistant + tool calls + errors + done summaries
- [ ] 2.4 Verbose mode: show everything including status changes and system events
- [ ] 2.5 Bind `v` key in StreamAttach normal mode to cycle verbosity; show current mode in status bar
- [ ] 2.6 Suppress duplicate/rapid status change events (debounce: skip if same status within 5s)

## 3. Status Bar Enhancements
- [ ] 3.1 Show current verbosity mode indicator in status bar (M/N/V)
- [ ] 3.2 Move system event count to status bar (e.g., "12 events" instead of inline rendering)

## 4. Validation
- [ ] 4.1 Visual test: user and assistant blocks clearly distinguishable at a glance
- [ ] 4.2 Visual test: verbosity toggle cycles correctly, filters apply immediately to new events
- [ ] 4.3 Visual test: existing collapsible blocks and tool call rendering unaffected
- [ ] 4.4 `cargo clippy && cargo test`
