# Tasks: drop-recognized-events-allowlist

- [ ] 1.1 Confirm P2.1 (add-schema-drift-detector) is merged
- [ ] 1.2 Remove `RECOGNIZED_EVENTS` set from `routes/hooks.ts`
- [ ] 1.3 Remove the rejection branch in `handleHooks` switch statement
- [ ] 1.4 Verify `session_events.metadata` already stores full payload (was it filtered before?)
- [ ] 1.5 Update unit tests — drop "unknown event rejected" cases, add "unknown event persists + fires drift"
- [ ] 1.6 Run integration test: send synthetic event with unknown type, verify row + drift event
