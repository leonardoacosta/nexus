# Implementation Tasks

<!-- beads:epic:nx-blm -->

## Onboarding Batch

- [ ] [1.1] [P-1] Update empty Dashboard state with welcome message: what Nexus is, press n to start, ? for help [beads:nx-dqj]
- [ ] [1.2] [P-1] Add ?: help to ALL title bar hint strings (dashboard, health, projects, specs, detail, stream) [beads:nx-h17]
- [ ] [1.3] [P-1] Graceful config fallback in main.rs — catch load error, show warning, start with empty agents [beads:nx-722]

## Behavior Batch

- [ ] [2.1] [P-1] Guard approve/reject in keys.rs — check spec status, block if already finalized, show status message [beads:nx-bmt]
- [ ] [2.2] [P-1] Wire Tab/Shift-Tab in handle_detail_key to cycle screens (close detail + next_screen) [beads:nx-ctt]
- [ ] [2.3] [P-1] Update stream placeholder to "press i to type a prompt" when not in input mode [beads:nx-umj]
- [ ] [2.4] [P-1] Fix hardcoded 20 in scroll_down and toggle_block_at_scroll to use terminal height [beads:nx-pj5]
- [ ] [2.5] [P-1] Remove Shift-A correction message — silently ignore instead [beads:nx-i85]

## Verify Batch

- [ ] [3.1] Verify cargo build + clippy + test [beads:nx-p4r]
