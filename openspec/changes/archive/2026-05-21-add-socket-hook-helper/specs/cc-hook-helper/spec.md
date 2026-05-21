## ADDED Requirements

### Requirement: socket-write helper binary SHALL exist on PATH

A small static binary (preferred) OR shell wrapper SHALL be installed to `~/.local/bin/nexus-emit`. It accepts hook payload JSON via stdin (or `--payload`), opens `~/.nexus/agent.sock` (overridable via `NEXUS_SOCK`), writes a single NDJSON frame, closes, exits 0 on success.

#### Scenario: helper writes a session_start event
- **GIVEN** the helper is installed and the agent's socket is listening
- **WHEN** `echo '{"hook_event_name":"session_start","session_id":"x"}' | nexus-emit`
- **THEN** within 50ms the agent's socket dispatcher receives the frame and writes a `session_events` row

### Requirement: helper SHALL fail fast and never block CC

If the socket is unavailable, the helper SHALL exit non-zero within 100ms. CC hook scripts SHALL invoke it with `|| true` so a failed helper does not kill the CC process.

#### Scenario: missing socket exits fast
- **GIVEN** the agent is not running (socket does not exist)
- **WHEN** `echo '{}' | nexus-emit`
- **THEN** the helper exits non-zero within 100ms; no blocking, no crash
