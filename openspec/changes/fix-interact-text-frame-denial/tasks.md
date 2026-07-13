<!-- beads:epic:nx-l7a1u -->
<!-- beads:feature:nx-iz22c -->

# Implementation Tasks

## UI Batch

- [x] [3.1] [P-1] Rework `PtyInteractChannel.receiveLoop` text-frame handling in `apps/swift/NexusShared/Networking/NexusClient.swift` (~line 1701): parse the text payload as JSON and treat ONLY `{"type":"error"}` as writer-denial (markReadOnly + warning); ignore `geometry`, `replay_done`, `writer_disconnected`, and unknown types (debug log), and CONTINUE the receive loop after every non-denial text frame — loop exits only on close or transport error; keep existing 4009 eviction handling untouched. [owner:swift-engineer] [type:ui] [beads:nx-ai5m6]
- [x] [3.2] [P-1] Replace `ptyLog`'s hardcoded `dev.leonardoacosta.nexus.mac` subsystem (`NexusClient.swift:19-22`) with a `Bundle.main.bundleIdentifier`-derived subsystem, falling back to the current literal, so interact warnings surface under each platform's own device-log filter. [owner:swift-engineer] [type:ui] [beads:nx-e6wcd]
- [x] [3.3] [P-2] Headless typecheck gate per the swift-engineer contract (remote Mac swiftc -typecheck over the NexusShared sources) — paste the command output as runtime evidence. [owner:swift-engineer] [type:testing] [beads:nx-w158e]

## E2E Batch

- [ ] [4.1] Simulator verification of the nx-qq3qu repro: attach to a live managed session on the iOS Simulator, type several keystrokes, and paste agent journal lines showing `NXPTY interact binary -> pty.write()` for the session plus tmux capture-pane output proving the characters landed; confirm the read-only warning (if any) now appears under the app's own log subsystem. [owner:swift-engineer] [type:testing] [beads:nx-edjzx]
- [x] [4.2] [user] On-device dual-client verification (macOS PtyViewer attached, then iOS opens the same session and types — keys land AND the macOS viewer flips to its read-only badge); this is archived ios-session-navigation task 3.3 / nx-kwq1w — searched: swift skill, mac-swift-deploy notes, terminal-attach spec; codesign + GUI run require the physical Mac/iPhone, no documented headless path covers on-device keyboard + badge verification. [owner:user] [type:testing] [beads:nx-ylnlx] — resolved: user-confirmed verified during Phase 0d gate (2026-07-13)
