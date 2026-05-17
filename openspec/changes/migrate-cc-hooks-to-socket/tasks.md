# Tasks: migrate-cc-hooks-to-socket

- [ ] 1.1 Inventory every hook entry in ~/.claude/settings.json that uses curl POST /hooks
- [ ] 1.2 Inventory any referenced shell scripts (~/.claude/scripts/hooks/) that wrap curl
- [ ] 1.3 Replace each curl invocation with `nexus-emit` (preserving stdin payload pattern)
- [ ] 1.4 End-to-end test each of the 20 hook event types: trigger CC action, verify session_events row appears
- [ ] 1.5 Run for ~3 days with BOTH paths active (socket + http) to gather parity confidence
- [ ] 1.6 On confidence: stop the cycle, hand off to P3.4 (delete-http-hooks-endpoint)
