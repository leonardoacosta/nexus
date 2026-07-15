## ADDED Requirements

### Requirement: nx-agent polls local statusline context snapshots instead of relying on a fire-and-forget push

The agent SHALL populate the session-context store by polling its own machine's local
`~/.claude/scripts/state/statusline-ctx.<sessionId>.json` snapshot files directly, on a fixed
interval, rather than depending on `nexus-statusline`'s own short-lived process to complete a
network push before Claude Code cancels it.

On each poll tick, the agent SHALL read every `statusline-ctx.*.json` file present, extract the
session id from the filename, and apply each file's `used_percentage`/`context_window_size` to
the in-memory session-context store when the file's own `saved_at` timestamp is within the
existing freshness window — identical to the freshness convention `GET /sessions/:id/context`
already enforces. A malformed or unreadable file SHALL be skipped without error, never
interrupting the poll cycle for other files.

The agent SHALL NOT rely on any network call originating from `nexus-statusline` to populate
this store — the store SHALL be reachable and correct using only this machine's local
filesystem state.

#### Scenario: a real statusline render's local snapshot is picked up automatically
- Given: a real Claude Code session renders its statusline, writing a fresh
  `statusline-ctx.<id>.json` snapshot with real `used_percentage`/`context_window_size` values
- When: the next poll tick runs
- Then: `GET /sessions/<id>/context` returns that data, without any manual PATCH or manual
  `nexus-statusline` invocation having occurred

#### Scenario: a stale snapshot is not applied
- Given: a `statusline-ctx.<id>.json` file whose `saved_at` is older than the existing
  freshness window
- When: the poll tick runs
- Then: that file's data is NOT applied to the store — an already-fresh entry for that session
  (if any) is left unchanged, and no entry is created if none existed

#### Scenario: a malformed snapshot file does not break the poll cycle
- Given: one `statusline-ctx.*.json` file contains invalid JSON or is missing required fields,
  while other snapshot files in the same directory are well-formed
- When: the poll tick runs
- Then: the malformed file is skipped silently, and every other well-formed file is still applied
  correctly

#### Scenario: the poller can be stopped cleanly
- Given: the poller has been started via its lifecycle handle
- When: `stop()` is called on that handle
- Then: no further polling occurs — no dangling timer/interval remains active
