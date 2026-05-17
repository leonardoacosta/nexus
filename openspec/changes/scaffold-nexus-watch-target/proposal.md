# Proposal: Scaffold nexus-watch target (notifications + permission grants)

## Change ID
`scaffold-nexus-watch-target`

## Phase
P4 apple-ecosystem (parent: spine-migration · nx-ma6h8 · feature: nx-qcrgw)

## Summary
watchOS app for in-flight permission grants. Notification actions route back to CC via the agent's text-command endpoint.

## Context
- Adds: `apps/swift/nexus-watch/` source dir
- Adds: agent endpoint `POST /commands/send-text` (sends text to a session's tmux pane via tmux send-keys)
- Depends-on: NexusShared (P4.2)
- Related: nx-pqx3i (post-sprint): voice-to-text dictation for free-form responses

## Motivation
Long-running CC sessions periodically ask permission. With a watch, Leo answers from the wrist via notification action — eliminates the context-switch back to laptop.

## Requirements

### Requirement: nexus-watch SHALL display session summary

Compact view: active session count + most recent alert, updated via NexusClient.

### Requirement: notification actions SHALL route back to CC as text commands

Permission-request notifications include action buttons (Approve / Deny / Custom). Tapping POSTs to /commands/send-text. Agent forwards via tmux send-keys.

#### Scenario: approve a destructive command from watch
- **WHEN** Leo taps "Approve" on his watch
- **THEN** within 2s the CC session receives "approve\n" via tmux send-keys
