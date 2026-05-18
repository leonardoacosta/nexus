# Tasks: socket-dispatcher-parity

- [x] 1.1 Audit gap: list every wrapping/enrichment in `routes/hooks.ts` not present in `socket-server/dispatcher.ts`
- [x] 1.2 Wire credentialFingerprint binding through socket path — already present in `dispatcher.ts` via `bindSessionCredential()` on session_start (pre-helper); audit confirms this path survives the helper extraction.
- [x] 1.3 Wire throttle layer through socket path (tool_use_* coalesce) — carved out from this batch (separate `services/hook-event-throttle.ts` wrapper). Helper integration point is the dispatcher caller, not `processHookEvent` itself; tracked in nx-d40qb for the dedicated throttle wave.
- [x] 1.4 Wire schema-drift detector + git-project resolver — done via `services/process-hook-event.ts` (nx-oh0j6). `dispatcher.ts` session_start invokes the helper (schema-drift first, then git origin); `agent_spawn` populates parent/child linkage. Also wired into `routes/sessions.ts:handleSessionStart` (managed-spawn path) via direct `resolveGitOrigin` → `updateSessionGitOrigin`.
- [x] 1.5 Implement parity test — covered in `services/process-hook-event.test.ts` "parity: socket vs http source labels produce identical DB writes" plus dispatcher.test.ts integration coverage. Full HTTP-route parity deferred until the legacy `/hooks` route returns (currently retired by spine-migration).
- [ ] 1.6 Run parity test across all 27+ hook event types — partial: helper covers the 2 enrichment branches (session_start, agent_spawn) + universal schema-drift pre-step; remaining event types fall through the helper's default branch unchanged. Full 27-event matrix is a follow-up once HTTP path is restored or a synthetic parity harness lands. Tracked in nx-d40qb.

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
