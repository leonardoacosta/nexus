## 1. Proto Changes
- [x] 1.1 Add `ProgressUpdate` message: `phase` (string), `percent` (optional float), `summary` (string)
- [x] 1.2 Add `ProgressUpdate progress` to `CommandOutput.content` oneof

## 2. Parser Enhancement
- [x] 2.1 Identify CC stream-json markers that indicate progress (tool starts, phase transitions)
- [x] 2.2 Emit `ProgressUpdate` events from parser when tool_use events begin (phase = tool name)
- [x] 2.3 Emit `ProgressUpdate` on `result` events with cost/duration summary

## 3. Agent Implementation
- [x] 3.1 Forward `ProgressUpdate` events through the `SendCommand` response stream
- [x] 3.2 Include tool call count in `CommandDone` (verified: populated from `num_turns` in parse_result_event)

## 4. Validation
- [x] 4.1 Test: ProgressUpdate emitted during multi-tool command execution (2 new tests)
- [x] 4.2 Test: existing TextChunk/ToolUse/Done flow unchanged
- [x] 4.3 `cargo clippy && cargo test` — 26 tests pass, 0 clippy errors
