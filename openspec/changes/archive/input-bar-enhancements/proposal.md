# Change: Input Bar Enhancements

## Change ID
`input-bar-enhancements`

## Summary
Improve the stream view input bar with external editor support, multi-line input, input history,
and placeholder text. These enhancements make the TUI command broker more productive for longer
prompts and repeated interactions.

## Context
- Modifies: `crates/nexus-tui/src/main.rs` (StreamInput key handling)
- Modifies: `crates/nexus-tui/src/screens/stream.rs` (render_input_bar)
- Modifies: `crates/nexus-tui/src/app.rs` (App state fields, StreamViewState or new InputHistory)
- Depends on: `session-broker` (completed) which introduced InputMode::StreamInput and the input bar

## Motivation
The current input bar is single-line, has no history, no placeholder guidance, and no way to
compose longer prompts. Users sending multi-line code snippets or complex instructions must
type everything on one line. Ctrl+E editor support (matching the old attach.rs pattern of
leaving/entering alternate screen) lets users compose in their preferred editor. Input history
avoids retyping common prompts.

## Requirements

### Req-1: External Editor (Ctrl+E)
Press Ctrl+E in StreamInput mode to open `$EDITOR` with a temp file. The TUI leaves the
alternate screen, spawns the editor as a child process, waits for exit, reads the temp file
contents, and sends the result as the prompt. Uses the same crossterm leave/enter alternate
screen pattern that the old attach.rs used for SSH.

### Req-2: Multi-line Input
Shift+Enter or Ctrl+J inserts a newline into the input buffer. The input bar grows dynamically
to show up to 5 lines, then scrolls the visible portion. Enter (without Shift) still sends the
complete buffer as the prompt.

### Req-3: Input History
Up/Down arrow cycles through previously sent prompts. History is stored in a `Vec<String>` with
a max capacity of 50 entries. History navigation is only active when the input buffer is empty
and in StreamInput mode. History is per-session (stored in StreamViewState) and not persisted
to disk.

### Req-4: Placeholder Text
When the input buffer is empty and no command is executing, show dim placeholder text:
"type a prompt, Ctrl+E for editor". The placeholder disappears as soon as the user types.

## Scope
- **IN**: Ctrl+E editor launch, multi-line input (Shift+Enter / Ctrl+J), input history
  (Up/Down), placeholder text
- **OUT**: @file autocomplete, vim keybindings, voice input, persistent history across sessions,
  syntax highlighting in input bar

## Impact
| Area | Change |
|------|--------|
| `crates/nexus-tui/src/main.rs` | Add Ctrl+E, Shift+Enter/Ctrl+J, Up/Down key handling in StreamInput mode |
| `crates/nexus-tui/src/screens/stream.rs` | Dynamic input bar height (1-5 lines), placeholder rendering, multi-line display |
| `crates/nexus-tui/src/app.rs` | Add input history fields to App or StreamViewState, cursor position tracking |

## Risks
| Risk | Mitigation |
|------|-----------|
| Ctrl+E leaves alternate screen which may disrupt stream subscription | Stream subscription runs in background task; only rendering is paused. Re-enter alternate screen after editor exits. |
| Shift+Enter may not be distinguishable from Enter on all terminals | Also support Ctrl+J as alternative. crossterm can detect KeyModifiers::SHIFT on most terminals. |
| Multi-line input changes the layout constraint from fixed Length(3) to dynamic | Use Constraint::Min(3) with Constraint::Max(7) to cap growth. Recalculate on each render. |
| $EDITOR not set | Fall back to `vi`, then `nano`. Show error in status bar if none found. |
