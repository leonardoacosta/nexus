# Change: pty-raw-interactive-input

## Why

Typing in the dashboard PTY viewer is unusable for interactive TUIs (like Claude Code's prompt): every keystroke is sent as a tmux `send-keys` command line that appends Enter, so each character submits immediately and the TUI redraws on every key — producing the repeated-statusline jumble seen in `docs/screenshots/img-20260524-182445.png`. It does NOT behave like a direct tmux connection.

The agent already exposes the correct path — a `WS /sessions/:id/interact` channel that writes raw bytes to the PTY behind a single-writer mutex (`apps/agent/src/server-websocket.ts`) — but the Swift client never opens it. It only uses `POST /commands/send-text` → `send-keys` (line-oriented, Enter-appending).

This change routes interactive keystrokes through the raw `/interact` WebSocket (no Enter), making the PTY behave like a real terminal. `send-text` is retained for its correct use — programmatic command-line injection (e.g. the STT transcript from `airpods-stt-command`, which deliberately wants `"command\n"`).

## What Changes

- Add a raw-input WebSocket channel to the Swift client: open an `NWConnection` to `WS /sessions/:id/interact` (reusing the scheme-rewrite + `NWProtocolWebSocket` pattern from `consumePtyStream`) and write SwiftTerm keystroke bytes raw, with no Enter appended.
- Rewire `PtyViewer.forwardInput` to send keystrokes over the `/interact` channel instead of `POST /commands/send-text`. Remains managed-gated (`sessionType == "managed"`).
- Lifecycle: open the interact channel when a managed PTY viewer attaches; close on detach. Handle the agent's single-writer-mutex denial (WS close code 4009 "interactive session already held") gracefully — log + degrade to read-only, no crash.
- `send-text` is unchanged and still used for programmatic command-line injection (STT transcript routing).

## Context

- depends on: (none — agent `/interact` channel already exists)
- touches: `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/nexus-mac/Sources/Dashboard/PtyViewer.swift`, `apps/swift/NexusSharedTests/PtyAttachTests.swift`

## Impact

- **Capability:** terminal-attach
- **Breaking:** No — additive. `send-text` path retained for programmatic injection. If the interact channel fails to open, input degrades to no-op (read-only stream still works).
- **Permissions:** none new.
- **Expected secondary fix:** removing the Enter-per-keystroke spam should also resolve the repeated-statusline redraw jumble (the TUI no longer re-renders on every key). If geometry jumble persists independent of input, it's a separate follow-up.
- **Files changed:** ~3 Swift + 1 test. Mac-only. Agent unchanged (interact channel already built).

## Design Notes

- **Two input paths, by intent:** raw keystrokes (interactive typing) → `/interact` WS (no Enter); programmatic command lines (STT transcript, "run this") → `POST /commands/send-text` (Enter-appending). Do not collapse them.
- **Single-writer contract:** the agent grants the interact-writer mutex to one client; a second viewer attempting to write is closed with 4009. The Swift client treats that as read-only mode (stream still flows) and surfaces a non-fatal indicator.
- **Reuse:** the `/interact` NWConnection mirrors `consumePtyStream`'s NWConnection setup (http→ws scheme rewrite, `NWProtocolWebSocket`, finite-timeout session) — but is write-oriented (`connection.send` raw bytes) rather than receive-looping.
