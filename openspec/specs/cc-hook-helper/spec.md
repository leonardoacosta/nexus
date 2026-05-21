# cc-hook-helper Specification

## Purpose
TBD - created by archiving change add-socket-hook-helper. Update Purpose after archive.
## Requirements
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

### Requirement: all CC hook entries in settings.json SHALL use the socket helper

Every `hooks.[event].hooks[].command` in `~/.claude/settings.json` that previously invoked `curl POST /hooks` SHALL be updated to invoke `nexus-emit` (or equivalent). Helper shell scripts that wrap curl SHALL be updated similarly.

#### Scenario: settings.json has no curl POST /hooks invocations
- **GIVEN** the migration is complete
- **WHEN** `grep 'POST.*hooks' ~/.claude/settings.json`
- **THEN** zero matches

### Requirement: each hook event type SHALL be end-to-end verified

After migration, every CC hook event type SHALL be tested by triggering its CC action and verifying a corresponding `session_events` row appears within 100ms.

#### Scenario: SessionStart end-to-end through socket
- **GIVEN** updated settings.json
- **WHEN** CC starts a new session (firing SessionStart hook)
- **THEN** within 100ms a `session_events` row appears in postgres with `hook_event_name='session_start'` and the payload from CC

