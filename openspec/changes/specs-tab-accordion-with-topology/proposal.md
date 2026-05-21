# Proposal: Specs tab accordion with session + wave-plan topology

## Change ID

specs-tab-accordion-with-topology

## Why

The Nexus.app Specs tab today is a flat alphabetical list of 159 specs
grouped by project (cc, xx, ws, tl, nx, etc.). Two operationally
high-value signals are absent:

1. **No indication that an active CC session is in the project dir**
   — `/sessions` already returns cwd + gitOwnerRepo, but the Specs
   view doesn't join. The user can't see "I have 3 sessions running
   in ws right now" while looking at ws's specs.

2. **No indication that a spec is part of an active wave plan or has
   an agent dispatched against it** — `/apply` and `/apply:all`
   generate `docs/apply/<run-id>/wave-plan.json` with per-spec
   status (queued/in_progress/completed/failed) and wave number. This
   topology never reaches the dashboard, so the user can't see "this
   spec is currently being worked by an agent on homelab" without
   tailing logs.

Additionally, the project sections themselves don't collapse — the
list scrolls forever and projects with many archived specs swamp the
projects you're actively working in.

## What Changes

### Agent (new endpoint)

1. **`GET /wave-plans/active`** — reads `docs/apply/active.txt` (the
   canonical pointer to the in-flight run), loads
   `docs/apply/<run-id>/wave-plan.json`, projects per-spec status into
   a wire shape:

   ```json
   {
     "runId": "apply-2026-05-19-001",
     "planName": "...",
     "status": "in_progress",
     "currentWave": 3,
     "currentPhase": "API",
     "specStatuses": [
       {"name": "fix-credential-source-divergence", "wave": 2,
        "status": "in_progress", "phase": "API",
        "dispatchedAt": "2026-05-21T..."},
       ...
     ]
   }
   ```

   When no active wave plan exists (active.txt absent), returns
   `{runId: null, specStatuses: []}` with 200.

### Swift (NexusShared + nexus-mac)

2. **`NexusClient.fetchWavePlanStatus()`** — calls the new endpoint,
   returns Codable `WavePlanStatus`.

3. **`SpecsView` accordion** — replace the always-expanded
   `Section` blocks with `DisclosureGroup` per project. Default
   collapsed; user-expansion persists per project via UserDefaults.

4. **Project header rich metadata** — show:
   - Project slug + spec count badge (`oo (3/8 active)`).
   - **Active-session dot** (pulsing green) when ≥1 active session's
     `cwd` matches `~/dev/<slug>` OR `gitOwnerRepo` matches the
     project's known repo. Match logic: project-slug → directory
     lookup via existing project registry.
   - **Wave-plan rollup** — if any spec in this project is in the
     active wave plan, show `[W2 · 3 dispatched]` chip on the header.

5. **Per-spec row enrichment** — when the spec is in the active wave
   plan, render a small `[W2]` chip after the progress bar, plus a
   status dot color-coded:
   - gray = queued
   - blue (pulsing) = in_progress
   - green = completed
   - red = failed (post-archive recovery state)

### Tests

6. **Agent contract test** — `wave-plans.test.ts` with tmpdir fixture
   `docs/apply/<id>/wave-plan.json`. Verify status projection, empty
   state, malformed plan tolerance.

7. **Swift accordion test** — verify DisclosureGroup expansion
   toggles correctly + state persists.

## Context

- depends on: (none — homelab-emits-specs-credentials archived 2026-05-20, session-row-enrichment-v1 archived 2026-05-21)
- touches: `apps/agent/src/routes/wave-plans.ts`, `apps/agent/src/server-routes-wave-plans.ts`, `apps/agent/src/server-request-handler.ts`, `apps/agent/src/routes/wave-plans.test.ts`, `apps/swift/NexusShared/Networking/NexusClient.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/NexusShared/Models/WavePlanStatus.swift`, `apps/swift/nexus-mac/Sources/Dashboard/SpecsView.swift`, `apps/swift/NexusSharedTests/WavePlanStatusTests.swift`

## Motivation

Specs and Sessions are sister surfaces — the operator's mental model
links "I'm editing this spec" with "I have an agent dispatched on it"
with "this is part of the current wave I'm shipping". Today those
three things live in three disconnected places (Specs tab, Sessions
tab, terminal where /apply is running). Unifying them in the Specs
tab makes triage glanceable.

The wave-plan endpoint is also a stepping stone for future surfaces
(progress charts, kill-switch UI, dispatch history) — the wire shape
is reusable.

## Locked Decisions

- **One homelab agent for now** — `/wave-plans/active` reads the
  agent's local `docs/apply/active.txt`. If the user later spawns
  agents on more machines, NexusAggregateClient already fan-outs and
  merges; this spec doesn't need cross-agent reconciliation yet.
- **Accordion default collapsed** — fast triage of "which projects
  have stuff". Click to expand.
- **Persistence per project** — collapse state stored in UserDefaults
  keyed by `specsAccordion.<slug>`, default collapsed.
- **Session match by cwd path-suffix** — `cwd.hasPrefix("/home/nyaptor/dev/\(slug)/")`
  OR Mac equivalent. Cross-reference project-registry if cwd is empty.
- **Wave chip format `[W2]`** — single character marker, monospace.
  Colored dot is the status indicator separately.
- **Empty wave plan state** — when no active run, no wave decoration
  appears anywhere; accordion still works.

## Out of Scope

- Mac-side `/apply` wave-plan exposure (when Leo runs /apply on Mac).
  Single-agent (homelab) is sufficient today.
- Spec-row tap-to-jump-to-wave-plan-detail (future spec).
- Wave plan history / archive browsing.
- Dispatch live-tail (would need SSE stream, deferred).
- Editing project metadata or running /apply from the dashboard.
