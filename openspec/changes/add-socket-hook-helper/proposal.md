# Proposal: Tiny socket-write helper for CC hook scripts

## Change ID
`add-socket-hook-helper`

## Phase
P3 ingress-collapse (parent: spine-migration · nx-ma6h8 · feature: nx-0lgey)

## Summary
Build a small static binary (or shell shim using `nc -U`) that CC hook scripts invoke to write NDJSON frames to `~/.nexus/agent.sock`. Replaces `curl POST /hooks` in CC hook scripts.

## Context
- Adds: small binary OR shell wrapper. Candidate names: `nexus-emit`, `nexus-hook`.
- Format: takes JSON payload from stdin (or args), writes single NDJSON frame to socket
- Used by: CC hook scripts referenced from `~/.claude/settings.json`
- Blocks: `migrate-cc-hooks-to-socket` (P3.3 · nx-24yyq)

## Motivation
CC hook scripts today do `curl -X POST http://localhost:7400/hooks -d @-`. To migrate to socket-only ingestion, the hooks need a socket-write helper. Pure-bash `nc -U` works but is fiddly with quoting + needs nc installed. A small static binary is more robust.

## Requirements

### Requirement: helper SHALL accept JSON on stdin and write one NDJSON frame

The helper SHALL:
- Read JSON payload from stdin OR `--payload` flag
- Open `~/.nexus/agent.sock` (path overridable via `NEXUS_SOCK` env)
- Write `JSON.stringify(payload) + '\n'` (single NDJSON frame)
- Close socket
- Exit 0 on success, non-zero on socket error (but NEVER block CC for >100ms)

### Requirement: helper SHALL be fail-safe (CC must never block on it)

If socket is unavailable, the helper SHALL exit non-zero within 100ms. CC hook scripts SHALL invoke it with `|| true` so a failed helper doesn't kill CC.

#### Scenario: helper writes a session_start event
- **WHEN** `echo '{"hook_event_name":"session_start",...}' | nexus-emit`
- **THEN** within 50ms the agent's socket dispatcher receives the frame and writes a session_events row
