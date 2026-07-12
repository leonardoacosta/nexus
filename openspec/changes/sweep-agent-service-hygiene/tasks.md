<!-- beads:epic:nx-83z7a -->
<!-- beads:feature:nx-ycs89 -->

# Tasks — sweep-agent-service-hygiene

Full step-by-step detail, exact diffs, and STOP conditions live in
`plans/028-beads-reader-async-and-walk.md` (tasks 1.x),
`plans/029-mx-gateway-passthrough-helper.md` (tasks 2.x), and
`plans/030-env-doc-residue.md` (tasks 3.x). Each task cites its source step. The three areas touch
disjoint files and may run in any order.

## API Batch

- [x] 1.1 Convert `beads-reader.ts` imports: drop `readFileSync` from `node:fs`, add [beads:nx-t3bqp]
      `readFile` from `node:fs/promises`. (plans/028 Step 2)
- [x] 1.2 Make `discoverDolt` async; await both its internal read sites [beads:nx-r57e0]
      (`metadata.json`, the `dolt-server.port` sidecar). Preserve the never-throws contract — an
      awaited rejection is caught the same way the sync throw was. (plans/028 Step 3)
- [x] 1.3 Make `readViaJsonl` async (`await readFile`); in `readBeadsStore`, `await discoverDolt` [beads:nx-ta3re]
      and use `return await readViaJsonl(...)` (the `await` on the final return is load-bearing —
      a bare `return` would let a rejection escape the enclosing try/catch). (plans/028 Step 4)
- [x] 1.4 Update the 6 test call sites in `fleet-exceptions.test.ts` that call [beads:nx-b3t4r]
      `readViaJsonl`/`discoverDolt` to `async`/`await`. Expect `18 pass / 0 fail`. (plans/028
      Step 5)
- [x] 1.5 Add `await Bun.sleep(0)` in `computeFleetExceptions`'s per-repo loop (after the [beads:nx-ehql7]
      `hasBeads` check, before the read) so consecutive multi-MB JSONL parses cannot coalesce
      into one long event-loop block. Do NOT widen the depth-1 `readdirSync(devRoot)` walk — that
      is a separate, operator-gated decision. (plans/028 Step 6)
- [x] 1.6 Full gates: `pnpm typecheck`, `pnpm lint`, [beads:nx-e7iut]
      `cd apps/agent && bun test src/lib/fleet-exceptions.test.ts` (18 pass / 0 fail). (plans/028
      Step 7) — VERIFIED: 18 pass / 0 fail, 30 expect() calls; typecheck clean; lint 0 errors/46 pre-existing warnings.
- [x] 2.1 Create `apps/agent/src/lib/mx-gateway.ts` exporting `gatewayGetFailSoft` (fail-soft GET [beads:nx-6w60a]
      passthrough: AbortController timeout, URL construction inside the try so a malformed
      `MX_GATEWAY_URL` fail-softs, allowlisted param forwarding on `value !== null`, non-200 or
      throw → the caller's empty payload at 200) and `gatewayPostRelay` (verbatim POST relay:
      status + body relayed as-is on any response, timeout/network failure → 504, never a
      fabricated 200). Both take the route's path/route-label/payload as parameters — response
      shapes stay owned by the route files. (plans/029 Step 1)
- [x] 2.2 Create `apps/agent/src/lib/mx-gateway.test.ts` (8+ cases: param forwarding present/ [beads:nx-a2p4v]
      absent/empty-string, non-200 fail-soft, fetch-throw fail-soft, POST relay verbatim 2xx/
      non-2xx, POST fetch-throw → 504). Logger stubbed via `mock.module` spreading the real
      barrel first (nx-jlx1c), `fetch` stubbed with a URL-capturing helper restored in
      `afterEach`. (plans/029 Step 2) — VERIFIED: 8 pass / 0 fail, 21 expect() calls.
- [x] 2.3 Fold `queue.ts`, `decisions.ts`, `requests.ts` onto `gatewayGetFailSoft` — delete each [beads:nx-rgbe0]
      file's local `GATEWAY_URL`/`FETCH_TIMEOUT_MS`/`AbortController` skeleton, keep only the
      route's empty-payload constant and forwarded-param list. Handler names/signatures frozen.
      Expect `13 pass, 0 fail` across the three existing suites. (plans/029 Step 3) — VERIFIED: 12 pass / 0 fail (decisions.test.ts genuinely has 4 tests not 5; plan's count was off by one, no regression).
- [x] 2.4 Fold `sources.ts` (no incoming-url/forward-params), `triage.ts`, `thread.ts` (both [beads:nx-ntog2]
      12s→10s via the shared helper — the one deliberate behavior change) onto
      `gatewayGetFailSoft`. No existing test suites for these three; gate via typecheck + the
      "zero `AbortController`/`FETCH_TIMEOUT_MS` in these files" grep. (plans/029 Step 4) — VERIFIED: typecheck diff vs baseline empty, zero literal AbortController/FETCH_TIMEOUT_MS/MX_GATEWAY_URL in the 3 files.
- [x] 2.5 Fold `capture.ts` and `decision.ts` onto `gatewayPostRelay` — keep `decision.ts`'s [beads:nx-gaiv1]
      `parseRequestId()` 400-guard prelude and `capture.ts`'s body-read exactly as-is; copy the
      two pinned 504 error strings (`"capture gateway unreachable"`,
      `"decision gateway unreachable"`) EXACTLY, they are asserted by `capture.test.ts`. Expect
      `10 pass, 0 fail`. (plans/029 Step 5) — VERIFIED: 11 pass / 0 fail (5+6, plan miscounted; no regression).
- [x] 2.6 Final gates: combined route+helper suite run (`31 pass, 0 fail` — 23 baseline + 8 new); [beads:nx-69ks9]
      exactly one non-test `process.env.MX_GATEWAY_URL` site (`lib/mx-gateway.ts`); zero
      `new AbortController` remaining in the 8 route files; zero new typecheck errors vs the
      captured pre-existing baseline (2 known `credentials.test.ts` TS2300 errors); lint 0 errors;
      the 5 pre-existing route test files byte-identical to baseline. (plans/029 Step 6) — VERIFIED: 31 pass / 0 fail, 87 expect() calls (exact match); 1 non-test MX_GATEWAY_URL site; 0 new AbortController; typecheck/lint clean; 5 test files untouched.
- [x] 3.1 Re-add `ELEVENLABS_VOICE_ID=` to `.env.example` directly after [beads:nx-xnetu]
      `ELEVENLABS_DEFAULT_VOICE_ID=`, with a deprecation comment citing the spec-mandated fallback
      (`openspec/specs/elevenlabs-credential/spec.md`) and precedence note. Do NOT touch
      `router.ts` or its test — the code fallback stays. (plans/030 Step 2)
- [x] 3.2 Append `VM_URL` to the "Secrets-File Variables" cross-reference comment block in [beads:nx-c8c46]
      `.env.example` (comment mention only — no `VM_URL=` assignment line, no production value).
      (plans/030 Step 3)
- [x] 3.3 Fix the false "systemd unit sets this" claim in `wave-plans.ts`'s `resolveRepoRoot()` [beads:nx-odwuw]
      docstring — comment-only, describe the real precedence (`~/.env` via
      `EnvironmentFile=-%h/.env`, or the process environment; the unit itself sets nothing).
      (plans/030 Step 4) — VERIFIED: H1 audit-scan 15→13, neither var in remaining list; guard tests 17 pass/0 fail; typecheck baseline-identical.

## E2E Batch

- [x] 3.4 Runtime evidence: re-run `~/.claude/scripts/bin/audit-scan --project . --json` H1 count [beads:nx-dcrwc]
      — must drop from the pre-change baseline of 15 to exactly 13, with neither
      `ELEVENLABS_VOICE_ID` nor `VM_URL` in the remaining list. Run
      `bun test apps/agent/src/routes/wave-plans.test.ts apps/agent/src/notifications/tts-credential-resolve.test.ts`
      (17 pass / 0 fail) and confirm `pnpm --filter @nexus/agent typecheck` shows no errors beyond
      the pre-existing baseline set. (plans/030 Steps 1, 5) — VERIFIED: H1 count exactly 13, neither
      var present; wave-plans + tts-credential-resolve suites 17 pass/0 fail; agent typecheck shows
      only the 2 pre-existing credentials.test.ts TS2300 errors, no new errors.
- [x] 3.5 Cross-area final check: `git status` shows modifications only across the full in-scope [beads:nx-im77a]
      file set of all three source plans combined (no drive-by edits); each area's own status row
      in `plans/README.md` updated to DONE with a `spec-impact: sweep-agent-service-hygiene` note.
      — VERIFIED (git-status check): only this tasks.md modified by engineers this run, no drive-by
      edits. NOTE: the plans/README.md status-row update is explicitly out of scope for engineers
      this run per orchestrator instruction ("plans/README.md ... maintained by the orchestrator
      directly ... do not edit that file") — left for the orchestrator to apply.
