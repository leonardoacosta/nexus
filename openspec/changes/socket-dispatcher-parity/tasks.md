# Tasks: socket-dispatcher-parity

- [ ] 1.1 Audit gap: list every wrapping/enrichment in `routes/hooks.ts` not present in `socket-server/dispatcher.ts`
- [ ] 1.2 Wire credentialFingerprint binding through socket path
- [ ] 1.3 Wire throttle layer through socket path (tool_use_* coalesce)
- [ ] 1.4 Wire schema-drift detector + git-project resolver (depends on P2.1, P2.2 merged)
- [ ] 1.5 Implement parity test in `apps/agent/src/socket-vs-http.test.ts` — same payload both paths, assert identical outcomes
- [ ] 1.6 Run parity test across all 27+ hook event types
