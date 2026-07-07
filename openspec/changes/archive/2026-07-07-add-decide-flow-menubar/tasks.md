<!-- beads:epic:nx-dgpy9 -->
<!-- beads:feature:nx-ym8xj -->

# Tasks — add-decide-flow-menubar

## API Batch

- [x] 1.1 Agent route `GET /queue`: passthrough forwarding `limit`, fail-soft `{ items: [] }` 200 on gateway failure, 10s timeout — mirror routes/requests.ts conventions (searched: requests.ts/sources.ts are the only passthrough exemplars; reuse their shape, no new helper) [beads:nx-tzhtk]
  - touches: apps/agent/src/routes/queue.ts, apps/agent/src/server-request-handler.ts
- [x] 1.2 Agent route `POST /requests/{id}/decision`: body passthrough, verbatim 409/5xx propagation, timeout maps to 504 (NOT fail-soft — see design.md asymmetry rationale) [beads:nx-3eyej]
  - depends on: 1.1
  - touches: apps/agent/src/routes/decision.ts, apps/agent/src/server-request-handler.ts
- [x] 1.3 Route tests (vitest, mirror requests.test.ts): param forwarding, fail-soft on GET, verbatim 409 body on POST, 504 on timeout [beads:nx-7tzat]
  - depends on: 1.2
  - touches: apps/agent/src/routes/queue.test.ts, apps/agent/src/routes/decision.test.ts

## UI Batch

- [x] 2.1 NexusShared: `Verdict` optional nested Codable on `TriageItem` (action, disposition, reason, confidence, promptVersion, verdictId); verdict-present + verdict-absent samples in TriageItem+Sample [beads:nx-7fxl2]
  - touches: apps/swift/NexusShared/Models/TriageItem.swift, apps/swift/NexusShared/Models/TriageItem+Sample.swift
- [x] 2.2 NexusShared: `DecisionClient` endpoint on the existing NexusClient actor pattern — postDecision(requestID:action:overrideAction:note:), 409 typed as alreadyDecided [beads:nx-6ggj7]
  - depends on: 2.1
  - touches: apps/swift/NexusShared/Networking/
- [x] 2.3 NexusShared: `DecideSession` @Observable — batch fetch (limit 10, /queue/head single-item fallback per design), currentIndex, skipCounts with hold-rank semantics, forcedDecision at 3rd skip, paused, phase; pure unit-testable state transitions [beads:nx-65sgy]
  - depends on: 2.2
  - touches: apps/swift/NexusShared/Observers/DecideSession.swift
- [x] 2.4 nexus-mac: `DecideCardView` + `VerdictBox` — header (ball/source/requester/age), why-now line, title, verdict block, action bar with .keyboardShortcut A/O/P/S/G; defensive verdict-less rendering (skip-only) [beads:nx-iy96n]
  - depends on: 2.3
  - touches: apps/swift/nexus-mac/
- [x] 2.5 nexus-mac: override inline expansion (2x3 grid, 1-6 keys, note field labeled "why? (this tunes the model)", Enter/Esc), peek inline expansion via existing /thread passthrough, go-to-source pause/resume state [beads:nx-3xinm]
  - depends on: 2.4
  - touches: apps/swift/nexus-mac/
- [x] 2.6 nexus-mac: `MenuBarExtra` integration — compact queue-head label, popover hosting DecideDeckView, SessionDoneView full stop; no counts/rates rendered anywhere in the flow (assert in review against the spec's anti-bias requirement) [beads:nx-7or1l]
  - depends on: 2.5
  - touches: apps/swift/nexus-mac/, apps/swift/project.yml
- [x] 2.7 NexusShared unit tests: decode both payload shapes; DecideSession transitions (advance, skip hold-rank, forced at 3, done phase, paused round-trip) [beads:nx-aqpx0]
  - depends on: 2.3
  - touches: apps/swift/NexusSharedTests/

## E2E Batch

- [x] 3.1 Headless gate: xcodegen + swiftc -typecheck via the Linux->Mac ssh contract (swift-engineer conventions); paste typecheck output [beads:nx-p0w69]
  - depends on: 2.6, 2.7
- [ ] 3.2 [user] On-device verification (Mac, GUI-bound codesign + run): complete one real session — one accept, one override-with-note, one peek, one skip, one go-to-source pause/resume; paste the resulting mx_verdict_decisions rows and confirm keyboard shortcuts fire in the popover (fallback: buttons-only per design risk). searched: verification contract is proposal.md ## Testing — no new criteria at run time [beads:nx-0cmg4]
  - depends on: 3.1
