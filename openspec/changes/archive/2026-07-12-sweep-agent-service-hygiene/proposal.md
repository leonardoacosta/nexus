# Agent service hygiene sweep: async beads reads, a shared mx-gateway helper, env-doc residue

## Why

Three independent P2/P3 tech-debt findings from the Wave-3 `/improve:code` audit
(2026-07-11, commit `b7096486`), bundled as a hygiene sweep because each is small, touches a
disjoint file set, and none depends on the others:

1. **Blocking sync reads in the daemon event loop (perf, P2)**: `readViaJsonl`
   (`apps/agent/src/lib/beads-reader.ts`) does a blocking `readFileSync` of `.beads/issues.jsonl`
   inside the long-lived single-threaded Bun daemon's event loop, called sequentially per repo by
   `computeFleetExceptions` (the `compute()` of the `/exceptions` stale-while-revalidate cache).
   Every sync read blocks socket hook ingest, WebSocket frames, and every other in-flight route.
   Fresh stat: the default depth-1 walk reads ~19.5 MB per refresh cycle, dominated by one 13.6 MB
   store. This mirrors already-shipped plan 019 (credential-pool `reader.ts` → `fs/promises`).
2. **8 copy-pasted mx-gateway passthrough skeletons (tech-debt, P3)**: the same env-default base
   URL / `AbortController` timeout / query-param allowlist / dual failure-posture skeleton is
   duplicated across 8 route files in `apps/agent/src/routes/` with zero shared code, and the
   copies are already drifting (`/triage` and `/thread` use a 12s timeout vs the other six's 10s;
   param-forwarding and URL-construction details diverge). Every future gateway route clones the
   skeleton again; every fix must be applied 8 times or silently miss some copies.
3. **Env-doc residue (docs, P3)**: `ELEVENLABS_VOICE_ID` is read in source (spec-mandated backward
   compat) but undocumented in `.env.example`; `VM_URL` is correctly documented in its canonical
   home (`deploy/secrets.env.example`) but missing from the cross-reference block that lets the
   nightly H1 audit recognize it as documented-elsewhere; a docstring in `wave-plans.ts` falsely
   claims the systemd unit sets `NEXUS_REPO_ROOT` (it does not).

## What Changes

- **`beads-reader.ts` / `fleet-exceptions.ts`**: convert `discoverDolt` and `readViaJsonl` to
  `fs/promises`; add a per-store `await Bun.sleep(0)` yield in `computeFleetExceptions`'s repo
  loop so the residual sync `JSON.parse` chunks cannot coalesce into one long event-loop block.
  Behavior-preserving — the `readBeadsStore` never-throws contract is unchanged. The depth-1 fleet
  walk gap (misses 18 nested stores including nx itself) is explicitly surfaced but NOT widened —
  that is a separate, operator-gated product decision (changes feed content + read volume for
  every dashboard consumer) tracked outside this proposal.
- **`mx-gateway.ts`**: extract one shared helper module (`gatewayGetFailSoft` for the 6 read
  routes, `gatewayPostRelay` for the 2 write routes) and fold all 8 routes onto it. Three
  deliberate, recorded unifications ride along: timeout unified at 10s (was 12s on 2 routes),
  param-forwarding unified on `value !== null` (was truthy-check on 2 routes), and upstream-URL
  construction unified inside the `try` (was outside on 2 routes, meaning a malformed
  `MX_GATEWAY_URL` used to throw past the handler on those 2). Route-specific logic (the
  `decision.ts` id-parsing prelude, the `capture.ts` body read, every response shape and status
  code) is unchanged.
- **Env docs**: re-add `ELEVENLABS_VOICE_ID` to `.env.example` with a deprecation note (code
  fallback stays — spec-mandated, not removed); add `VM_URL` to the Secrets-File Variables
  cross-reference block; fix the false systemd-unit claim in `wave-plans.ts`'s docstring
  (comment-only).

## Context

- touches: `apps/agent/src/lib/beads-reader.ts`, `apps/agent/src/lib/fleet-exceptions.ts`,
  `apps/agent/src/lib/fleet-exceptions.test.ts`, `apps/agent/src/lib/mx-gateway.ts` (new),
  `apps/agent/src/lib/mx-gateway.test.ts` (new), `apps/agent/src/routes/queue.ts`,
  `apps/agent/src/routes/decisions.ts`, `apps/agent/src/routes/requests.ts`,
  `apps/agent/src/routes/sources.ts`, `apps/agent/src/routes/triage.ts`,
  `apps/agent/src/routes/thread.ts`, `apps/agent/src/routes/capture.ts`,
  `apps/agent/src/routes/decision.ts`, `.env.example`, `apps/agent/src/routes/wave-plans.ts`

No soft dependencies between the three sub-areas (disjoint files) or with any other in-flight
proposal — `ios-session-navigation` is Swift/iOS-only, and neither statusline proposal in this
batch touches `apps/agent/src/lib/**` or `apps/agent/src/routes/**`.

**Explicitly deferred, not this proposal**: widening the fleet-exceptions walk past depth 1 (a
product decision changing feed content for every `GET /exceptions` consumer — tracked as a
separate operator-gated decision per the source plan); any statusline work (the sibling
`harden-statusline-spawn-and-cache` proposal); re-greening `lint-sql-safety` or the `db:push`
guard (the sibling `harden-quality-gates` proposal).

**Source material**: transcribes `plans/028-beads-reader-async-and-walk.md`,
`plans/029-mx-gateway-passthrough-helper.md`, and `plans/030-env-doc-residue.md` into
OpenSpec/beads-tracked form. Every step, verification command, and STOP condition in those files
remains authoritative; `tasks.md` here summarizes them at checkbox granularity.

## Testing

- **beads-reader**: no new test cases — the conversion is behavior-preserving by contract. The 6
  updated `readViaJsonl`/`discoverDolt` tests and the 6 `computeFleetExceptions` fixture tests in
  `fleet-exceptions.test.ts` (18 total) exercise the new async signatures and the event-loop yield
  end-to-end; expect `18 pass / 0 fail` unchanged from baseline.
- **mx-gateway**: new `apps/agent/src/lib/mx-gateway.test.ts` (8+ cases: param forwarding present/
  absent/empty-string, non-200 fail-soft, fetch-throw fail-soft, POST relay 2xx/non-2xx verbatim,
  POST fetch-throw → 504). The 5 existing route suites (23 tests) are the refactor's regression
  harness and MUST pass byte-identical to baseline — if any requires editing to go green, the
  refactor changed behavior and that is a STOP condition, not a fix to apply.
- **Env docs**: no new tests (comment/doc-only diff). Runtime evidence is the H1 audit-scan count
  dropping from 15 to the documented steady state of 13, with neither `ELEVENLABS_VOICE_ID` nor
  `VM_URL` in the remaining list; the two existing guard suites
  (`wave-plans.test.ts` + `tts-credential-resolve.test.ts`, 17 tests) must stay green.
