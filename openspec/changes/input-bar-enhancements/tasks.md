# Implementation Tasks

## DB Batch

(no database changes)

## API Batch

(no API/agent changes)

## UI Batch

- [x] [1.1] [P-1] Add input history fields to App or StreamViewState: `input_history: Vec<String>`, `history_index: Option<usize>`, max capacity 50 [owner:ui-engineer]
- [x] [1.2] [P-1] Add placeholder text rendering to `render_input_bar` — show dim "type a prompt, Ctrl+E for editor" when input is empty and not executing [owner:ui-engineer]
- [x] [1.3] [P-1] Implement multi-line input: handle Shift+Enter and Ctrl+J to insert newline in StreamInput key handler [owner:ui-engineer]
- [x] [1.4] [P-1] Update `render_input_bar` layout to support dynamic height (1-5 lines) based on newline count in stream_input [owner:ui-engineer]
- [x] [1.5] [P-1] Update stream layout in `render_stream` — change input bar constraint from fixed `Length(3)` to dynamic based on input line count [owner:ui-engineer]
- [x] [1.6] [P-1] Implement input history: record sent prompts in history vec, handle Up/Down to navigate when input is empty [owner:ui-engineer]
- [x] [1.7] [P-2] Implement Ctrl+E external editor: leave alternate screen, spawn $EDITOR with temp file, read result, re-enter alternate screen, send prompt [owner:ui-engineer]
- [x] [1.8] [P-2] Add $EDITOR fallback chain: try $EDITOR, then `vi`, then `nano`; show error in status bar if none found [owner:ui-engineer]

## E2E Batch

- [x] [2.1] Verify: placeholder text appears when input is empty, disappears on keypress [owner:e2e-engineer]
- [x] [2.2] Verify: Shift+Enter or Ctrl+J inserts newline, input bar grows up to 5 lines [owner:e2e-engineer]
- [x] [2.3] Verify: Enter sends multi-line content as single prompt [owner:e2e-engineer]
- [x] [2.4] Verify: Up/Down cycles through sent prompts when input is empty [owner:e2e-engineer]
- [x] [2.5] Verify: Ctrl+E opens editor, sends result on save, aborts on empty [owner:e2e-engineer]
- [x] [2.6] Verify: all input enhancements are blocked during command execution [owner:e2e-engineer]
