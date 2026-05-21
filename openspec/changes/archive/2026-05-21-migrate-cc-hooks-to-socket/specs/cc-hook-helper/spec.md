## ADDED Requirements

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
