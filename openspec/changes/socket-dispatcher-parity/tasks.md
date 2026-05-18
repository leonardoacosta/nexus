# Tasks: socket-dispatcher-parity

- [x] 1.1 Audit gap: list every wrapping/enrichment in `routes/hooks.ts` not present in `socket-server/dispatcher.ts`
- [ ] 1.2 Wire credentialFingerprint binding through socket path
- [ ] 1.3 Wire throttle layer through socket path (tool_use_* coalesce)
- [ ] 1.4 Wire schema-drift detector + git-project resolver (depends on P2.1, P2.2 merged)
- [ ] 1.5 Implement parity test in `apps/agent/src/socket-vs-http.test.ts` — same payload both paths, assert identical outcomes
- [ ] 1.6 Run parity test across all 27+ hook event types

<!--
Audit results (task 1.1) — gaps between routes/hooks.ts (HTTP) and
services/socket-server/dispatcher.ts (socket). HTTP is the parity target.

  | Wrapping                            | HTTP   | Socket |
  |-------------------------------------|--------|--------|
  | Credential fingerprint binding      | NO (*) | YES    |
  | Schema-drift detector               | YES    | NO     |
  | session_events persistence          | YES    | NO     |
  | Hook event throttle                 | YES    | NO     |
  | Git project resolver (session_start)| YES    | NO     |
  | Cost computation (session_summary)  | YES    | NO     |
  | lifecycleBus HookEventReceived emit | YES    | NO (#) |
  | evaluateAndDispatch notification    | YES    | NO     |
  | handleAgentSpawn parent/role        | YES    | NO     |
  | handleStopFailure status=errored    | YES    | NO     |

  (*) HTTP currently does NOT bind credential fingerprint from the
      payload — that lives only on the socket path. True "byte-identical"
      parity therefore requires either (a) HTTP to gain credential
      binding from payload, or (b) the socket dispatcher to keep its
      credential enrichment as a wrapper around a shared core helper.

  (#) Socket emits SessionStarted/Stopped/Heartbeat + NotificationFired,
      which are different event names than HTTP's HookEventReceived. A
      parity contract has to settle which envelope is canonical.

Conclusion: 9 wrapping gaps + an architectural decision to make about
credential binding direction. Refactor scope is the full
`handleHooks()` body lifted into a shared `services/process-hook-event.ts`
helper that both paths invoke, plus a 27-event parity test that must
actually execute (not just typecheck) — runtime evidence is required.

Deferred from wave-3 batch to its own design pass — tracked in
bd issue nx-oh0j6.
-->
