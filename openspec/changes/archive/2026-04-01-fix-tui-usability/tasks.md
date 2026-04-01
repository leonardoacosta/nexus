# Implementation Tasks

<!-- beads:epic:nx-jha -->

## State Batch

- [x] [1.1] [P-1] Add previous_screen field to App struct — set before entering Palette/StreamAttach, use in close_palette() [beads:nx-nhe]
- [x] [1.2] [P-1] Add help_overlay: bool field to App struct + toggle on ? key + render method [beads:nx-qt1]
- [x] [1.3] [P-1] Add confirm_action: Option<(ConfirmKind, Instant)> field to App struct for two-step confirmation with 3s timeout [beads:nx-7k6]

## Keys Batch

- [x] [2.1] [P-1] Update Dashboard title bar hints to include "a: attach  n: new session" [beads:nx-cpq]
- [x] [2.2] [P-1] Update Stream title bar hints to include "i: input" and expand verbosity label [M]/[N]/[V] to [MIN]/[NRM]/[VRB] [beads:nx-fnl]
- [x] [2.3] [P-1] Update Health title bar hints to include "n: notifications" [beads:nx-8i3]
- [x] [2.4] [P-1] Update Projects title bar hints to include "n: notifications  e: edit notes" [beads:nx-188]
- [x] [2.5] [P-1] Remap spec approve from "a" to Enter, reject from "x" to Backspace/Delete, update Specs title bar hints [beads:nx-eia]
- [x] [2.6] [P-2] Wire two-step confirmation for approve/reject — first press sets confirm_action, second press within 3s fires POST, timeout clears [beads:nx-dzs]
- [x] [2.7] [P-2] Wire ? key on all screens to toggle help_overlay, Esc/? to close [beads:nx-1sc]
- [x] [2.8] [P-2] Fix palette close to use previous_screen instead of hardcoded Dashboard [beads:nx-bpb]

## Render Batch

- [x] [3.1] [P-1] Add help overlay render function — centered Clear block listing keybindings per screen, grouped by action [beads:nx-181]
- [x] [3.2] [P-1] Update Dashboard to show disconnected agent sessions dimmed with "(disconnected)" badge — change recompute_sessions filter [beads:nx-2f5]
- [x] [3.3] [P-1] Rename Dashboard "ST" column to "STATUS", add Projects table scrollbar [beads:nx-01y]
- [x] [3.4] [P-1] Use terminal height for Stream PageUp/Down instead of hardcoded 20 [beads:nx-ea1]

## Cleanup Batch

- [x] [4.1] Delete orphaned tmp files: screens/tmp.pBbC5BnFEg.rs, screens/tmp.GWn3PanY0V.rs, screens/tmp.LlfDq8fYSp.rs [beads:nx-tp0]
