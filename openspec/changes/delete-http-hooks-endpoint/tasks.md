# Tasks: delete-http-hooks-endpoint

- [ ] 1.1 Confirm P3.3 fully landed and >=7 days production runtime on socket-only
- [ ] 1.2 Grep logs for any /hooks POST in the last 7 days — expect zero
- [ ] 1.3 `git rm apps/agent/src/routes/hooks.ts`
- [ ] 1.4 Remove route registration from `apps/agent/src/server.ts`
- [ ] 1.5 Update integration tests — drop any that POST to /hooks
- [ ] 1.6 Run full test suite; verify 404 on curl POST /hooks
