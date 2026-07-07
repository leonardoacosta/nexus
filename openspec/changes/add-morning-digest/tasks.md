# Tasks — add-morning-digest

## API Batch

- [ ] 1.1 Locate + reuse the agent's existing notify dispatch path (searched: nexus-agent :7400 receives mx notify per docs/recon + mx internal/cred/notify.go; confirm the handler module and its telegram/banner senders before writing anything new)
  - touches: apps/agent/src/
- [ ] 1.2 Digest composer `apps/agent/src/lib/digest.ts`: queue-head line, <=5 exception lines, deck pointer capped at session size 10, degrade paths (exceptions-down -> head-only; all-clear -> "clear" digest); composed string never contains fleet totals/rates
  - depends on: 1.1
  - touches: apps/agent/src/lib/digest.ts
- [ ] 1.3 Scheduler: DIGEST_HOUR env (default 07:30 local), per-day sent-marker file for idempotency across restarts
  - depends on: 1.2
  - touches: apps/agent/src/
- [ ] 1.4 Unit tests: composer variants (full/degraded/clear), no-aggregate invariant asserted on the composed string, sent-marker double-fire + restart cases
  - depends on: 1.3
  - touches: apps/agent/src/lib/digest.test.ts

## E2E Batch

- [ ] 2.1 Runtime evidence: trigger one real digest through the live transport; paste the received message text
  - depends on: 1.4
