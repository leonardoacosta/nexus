---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Migrate ~/.claude/settings.json hooks to socket helper

## Change ID
`migrate-cc-hooks-to-socket`

## Phase
P3 ingress-collapse (parent: spine-migration · nx-ma6h8 · feature: nx-24yyq)

## Summary
Replace `curl POST /hooks` invocations in user's CC global hook scripts with the new socket helper. Test each hook event type fires correctly end-to-end.

## Context
- Modifies: `~/.claude/settings.json` (hooks block, ~20 entries)
- Modifies: any hook shell scripts referenced by settings.json
- Depends-on: `socket-dispatcher-parity` (P3.1 · nx-onmun), `add-socket-hook-helper` (P3.2 · nx-0lgey)
- Out of repo: `~/.claude/settings.json` is user-config, not repo-tracked

## Motivation
With P3.1 (parity) and P3.2 (helper) in place, the only remaining work to make AF_UNIX the sole ingress is updating the CC config to invoke the helper instead of curl. End-to-end validation per event type ensures nothing regresses.

## Requirements

### Requirement: every hook entry in settings.json SHALL use the socket helper

Every `hooks.[event].hooks[].command` that today invokes `curl POST /hooks` SHALL be updated to invoke `nexus-emit` (or equivalent) instead. Other commands (e.g., shell scripts that themselves call curl) SHALL be updated similarly.

#### Scenario: SessionStart hook end-to-end
- **GIVEN** updated settings.json
- **WHEN** CC fires the SessionStart hook
- **THEN** within 100ms a session_events row appears in postgres with the matching payload
