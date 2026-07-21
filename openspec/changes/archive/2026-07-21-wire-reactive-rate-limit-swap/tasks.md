---
stack: t3
---

# Implementation Tasks

## DB Batch

(no tasks — `credential_swaps` (packages/db/src/schema/credentialSwaps.ts) already exists; no schema change)

## API Batch

- [x] [2.1] [P-1] Extract shared swap flow `apps/agent/src/services/credential-swap-flow.ts`: `performCredentialSwap({ pool, db, reason: "reactive" | "proactive", sessionId? })` wraps `pool.manualSwap()` → swap-tracker `recordSwap()` → `credential_swaps` insert (from/to fingerprint + account name, trigger session, reason) → `emitAudit` → `NotificationFired` "swapped <from> → <to>" on tts+desktop. Refactor `proactive-swap.ts`'s swap branch onto it (behavior-preserving apart from the new swap row + notification). [owner:api-engineer] [type:api]
- [x] [2.2] [P-1] Reactive detection in `apps/agent/src/services/socket-server/dispatcher.ts` notification path: case-insensitive phrase match ("hit your limit", "usage limit reached") plus `rate_limit_event` utilization ≥ 1.0. Eligible candidate exists → suppress normal delivery and invoke `performCredentialSwap` with the triggering session; pool empty or no candidate → pass through unchanged (exhaustion ladder owns it). [owner:api-engineer] [type:api]
- [x] [2.3] [P-1] Auto-continue: after a reactive swap, resolve the triggering session's tmux target and send "continue" via the send-keys helper extracted (exported) from `apps/agent/src/routes/commands-send-text.ts`; missing target → WARN, swap stands. [owner:api-engineer] [type:api]
- [x] [2.4] [P-2] Debounce (180s, in-memory in `credential-swap-flow.ts`): a session rate-limiting inside the window receives auto-continue only, no usage query, no re-swap; window expiry restores the full flow. [owner:api-engineer] [type:api]
- [x] [2.5] [P-2] Retire the orphaned `markRateLimitedAndSwap()` (and its tests) from `apps/agent/src/cc-credential-manager.ts` — the reactive flow owns swapping; the manager's profile mirror + proactive OAuth refresh stay untouched. Bump `rateLimitCount` on each reactive trigger via the existing rate-limit-tracker path. [owner:api-engineer] [type:api]
- [x] [2.6] [P-2] Proactive squeeze-dry trigger in `apps/agent/src/services/proactive-swap.ts`: swap when the active credential's effective remaining `min(5h, 7d)` drops to ≤ 0.02 (98% utilization) — `REMAINING_THRESHOLD` 0.10 → 0.02, evaluation extended from 5h-only to both windows; candidate ranking by effective remaining desc, ineligible at ≤ 0.02; `ANTI_FLAP_MS` 30 min → 10 min; update `proactive-swap.test.ts` scenarios accordingly. [owner:api-engineer] [type:api]

## UI Batch

(no tasks — `GET /credentials` already exposes `last_swap`/`debounce_active` and the Mac credentials view renders swap recency; new swap notifications surface through the existing NotificationFired → dashboard path)

## E2E Batch

- [x] [4.1] Unit tests: dispatcher detection matrix (phrase hit, utilization ≥ 1.0, passthrough on empty pool, passthrough when no eligible candidate → exhaustion ladder), `credential-swap-flow` (swap row written, swap-tracker stamped, notification emitted, debounce honored), auto-continue missing-target WARN. [owner:tdd-integration] [type:testing]
- [x] [4.2] Integration test `apps/agent/src/services/reactive-swap.integration.test.ts` (bun test): socket client emits a "hit your limit" notification for a tracked session against a stubbed 2-account pool → asserts `pool.manualSwap` invoked, `credential_swaps` row inserted, tmux send-keys called with "continue" (safeSpawn mocked), and a second session inside 180s is debounced (continue only, no second swap). [owner:tdd-integration] [type:testing]
