# Tasks: drop-recognized-events-allowlist

- [x] 1.1 Confirm P2.1 (add-schema-drift-detector) is merged (commit 320552e — services/schema-drift.ts + inspectAndEmitDrift wired into routes/hooks.ts)
- [x] 1.2 Remove `RECOGNIZED_EVENTS` set from `routes/hooks.ts`
- [x] 1.3 Remove the rejection branch in `handleHooks` switch statement (allowlist short-circuit gone; unknown events now persist + drift)
- [x] 1.4 Verify `session_events.metadata` already stores full payload (handler always JSON.stringify(payload) into metadata regardless of event_type — confirmed at routes/hooks.ts step 2)
- [x] 1.5 Update unit tests — drop "unknown event rejected" cases, add "unknown event persists + fires drift" (hooks.test.ts § 12 flipped from "no row" to "row inserted"; § 13 unknown-event test flipped from "no emit" to "emit broadcast")
- [x] 1.6 Run integration test: send synthetic event with unknown type, verify row + drift event (new test "unknown event fires HookSchemaDrift on the lifecycle bus" appended to § 12)
