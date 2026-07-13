---
status: draft
---

# Proposal: Fix Interact Channel Text-Frame Denial Misclassification

## Change ID
`fix-interact-text-frame-denial`

## Summary
`PtyInteractChannel.receiveLoop` treats ANY non-empty text frame on the interact WebSocket as a
writer-denial, so the agent's benign `{"type":"geometry"}` frame (sent milliseconds after open via
`addViewer`) silently flips the channel read-only and every subsequent keystroke is dropped with
zero logging (nx-qq3qu, P1). Fix the client to parse text frames — only `{"type":"error"}` (plus
eviction close 4009) is a denial — and fix the hardcoded macOS log subsystem that hid the one
diagnostic warning from iOS log filters.

## Context
- Extends: `apps/swift/NexusShared/Networking/NexusClient.swift` (PtyInteractChannel, ptyLog)
- Related: archived `2026-07-12-ios-session-navigation` (writer-claim last-open-wins rework);
  root-cause trace recorded on bead nx-qq3qu (2026-07-13)
- touches: `apps/swift/NexusShared/Networking/NexusClient.swift`

## Motivation
Both halves of the contradiction landed the same day (2026-05-24: `85cbeb0e` interact channel with
the "any text = denial" assumption; `de27a6b0` geometry text frames on all viewer sockets), so the
interact channel has plausibly never delivered input from a client that receives the geometry
frame before its first keystroke. Ground truth (journalctl + tmux capture-pane) shows writer-claim
`claimed:true` but zero binary frames arriving — including the automatic Ctrl-L redraw byte. The
sole client-side warning is emitted under hardcoded subsystem `dev.leonardoacosta.nexus.mac`
(`NexusClient.swift:19-22`) even on iOS, invisible to `dev.priceless.nexus` filters, which is why
this shipped undetected. macOS `PtyViewer.forwardInput` uses the same channel and is likely
equally broken against the current agent. Blocks archived ios-session-navigation task 3.3
(nx-kwq1w) — on-device writer-claim verification is impossible while input never reaches the PTY.

Client-side parse is chosen over suppressing `addViewer`'s geometry frame for interact sockets:
the agent's frames are spec'd viewer output (`terminal-attach` § Scrollback Replay Format,
§ geometry broadcasts), two more benign text frames also reach interact sockets
(source-initiated geometry broadcasts, `writer_disconnected`), and changing agent viewer
registration would alter viewer-count/eviction semantics for zero client-robustness gain.

## Requirements

### Requirement: Interact client text-frame denial discrimination
`PtyInteractChannel.receiveLoop` parses text frames as JSON control messages. Only
`{"type":"error"}` marks the channel read-only; `geometry`, `replay_done`,
`writer_disconnected`, and unknown types are ignored, and the receive loop continues running
after every non-denial text frame (it exits only on close or transport error). Existing
close-code 4009 eviction handling is preserved.

### Requirement: Per-platform interact diagnostics subsystem
`ptyLog` derives its subsystem from `Bundle.main.bundleIdentifier` (falling back to the current
literal) so interact-channel warnings are visible under each platform's own device-log filter.

## Scope
- **IN**: `PtyInteractChannel.receiveLoop` text-frame parsing + loop continuation;
  `ptyLog` subsystem derivation; simulator + on-device verification of the nx-qq3qu repro.
- **OUT**: agent-side changes (`addViewer`, `stream-manager.ts`, `server-websocket.ts`);
  `NexusAggregateClient.rebootstrap()` client-swap hardening (secondary hypothesis, no repro);
  the PTY viewer garbled-output bug (nx-f1l69, separate attach-handshake/geometry race).

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `PtyInteractChannel.receiveLoop` (NexusClient.swift) | N/A — Swift client logic, no vitest surface; headless typecheck gate `[3.3]` | `[4.1]`, `[4.2]` |
| `ptyLog` subsystem | N/A — logging config only | `[4.1]` (warning visibility confirmed during log capture) |

## Impact
| Area | Change |
|------|--------|
| `apps/swift/NexusShared/Networking/NexusClient.swift` | receiveLoop text-frame parse + keep-alive; bundle-derived ptyLog subsystem |
| iOS/macOS attach input | Keystrokes reach the agent PTY; read-only flip only on genuine denial |
| nx-kwq1w / archived task 3.3 | Unblocked once verified |

## Risks
| Risk | Mitigation |
|------|-----------|
| Unknown future control frame misread as denial | Denial is now an explicit `type == "error"` match; unknown types default to ignore + debug log |
| Keeping the loop alive changes eviction timing | 4009 close handling is untouched and covered by scenario "Receive loop survives benign control frames" |
| Subsystem change breaks existing mac log tooling | Fallback keeps the current literal when bundle id is unavailable; mac filters keyed on bundle id continue to match |
