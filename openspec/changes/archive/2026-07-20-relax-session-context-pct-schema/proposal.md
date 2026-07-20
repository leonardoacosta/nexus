---
order: 0719b
---

# Proposal: Relax session-context usedPercentage upper bound (companion to cc's clamp fix)

## Change ID
`relax-session-context-pct-schema`

## Summary
`packages/core/src/types/session-context.ts`'s `sessionContextPatchInput` zod schema rejects any
`usedPercentage` above 100 with a `400`. The producer of this value (cc's `telemetry.sh`) has
today been sending a clamped, information-destroying `usedPercentage` specifically to satisfy
this bound — a companion cc-side fix (`fix-session-context-pct-clamp`, `~/dev/cc`'s own openspec)
removes that clamp, but the unclamped value has nowhere to go until this schema accepts it. This
proposal removes the `.max(100)` ceiling so real over-window usage isn't silently rejected.

## Context
- Extends: `packages/core/src/types/session-context.ts` (`sessionContextPatchInput`)
- Related: `~/dev/cc` proposal `fix-session-context-pct-clamp` (companion cross-repo change —
  the producer-side fix this schema change unblocks; not expressible via this repo's
  `- depends on:`, which only resolves same-repo slugs)
- depends on: (none — no in-flight nexus proposal touches this schema)
- touches: `packages/core/src/types/session-context.ts`, `apps/agent/src/routes/session-context.test.ts`

> **Two parser-visible contracts.** `/triage` reads `- depends on:`; `wave-plan-build` reads
> `- touches:`.

## Cross-Repo Dependency (not a same-repo openspec dependency)
This schema relaxation is inert on its own — nothing sends `usedPercentage > 100` until the
companion cc-side fix (`fix-session-context-pct-clamp`) removes the clamp in `telemetry.sh`.
Landing this proposal first is safe (it only widens accepted input; existing `<=100` PATCHes are
unaffected) and is the recommended order, since the cc-side fix's own risk note documents that
landing before this one causes the bridge to fail open (a `400`, regressing to the pre-existing
blank-SES behavior) rather than the "200.0k" bug — i.e. this order is strictly safer either way.

## Motivation
Root-caused via `/explore` (2026-07-19, full investigation trail in
`~/.claude/projects/-home-nyaptor-dev-personal-installfest/memory/reference_cc_tmux_model_letter_pipeline_and_roadmap_pulse_sharing.md`):
cc-tmux's SES token reading gets stuck at a fixed "200.0k" once real session usage crosses the
producer's 200K window heuristic, because the producer clamps `usedPercentage` to 100 (to satisfy
this exact schema) before the consumer reconstructs `tokens = pct/100 * window` — a lossy
round-trip that collapses every reading above the window to the same value. The schema's `.max`
bound was a defensive choice (percentages "shouldn't" exceed 100) that doesn't hold here: the
window is a heuristic approximation of context size, not an authoritative ceiling on real usage.

## Requirements
See `specs/session-context-api/spec.md` for the one MODIFIED requirement (POST/PATCH
`/sessions/:id/context` input validation — the existing archived spec's title still reads "POST"
even though the live route is `PATCH`; that drift predates this change and is left as-is here to
preserve the requirement-title match against the parent spec — flagged, not fixed, since it's
out of this proposal's scope).

## Scope
- **IN**: removing `sessionContextPatchInput`'s `usedPercentage` upper bound; keeping the
  lower bound (`>= 0`) and type validation (finite number) unchanged; a test asserting a value
  above 100 is now accepted and round-trips through GET exactly.
- **OUT**: auditing every consumer of `usedPercentage` for a hidden `<=100` assumption (e.g. a
  UI progress-bar rendering) — flagged by the companion cc-side proposal's Risks section as a
  follow-up if it surfaces; fixing the stale "POST" vs actual "PATCH" wording in the parent
  capability spec's requirement title; changing the window heuristic itself (cc-side concern).

## Done Means
- `PATCH /sessions/:id/context` with `{"usedPercentage": 175.0, "contextWindowSize": 200000}`
  returns `204`, not `400`.
- A subsequent `GET /sessions/:id/context` for that session returns `usedPercentage: 175.0`
  exactly (not truncated, not rejected).
- Negative and non-numeric `usedPercentage` values still return `400` — only the upper bound is
  relaxed.

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `sessionContextPatchInput` zod validation | `[1.1]` | N/A — schema-level unit coverage is sufficient, no separate user-facing flow |
| `PATCH`/`GET /sessions/:id/context` round-trip above 100 | `[1.1]` | `[1.2]` (live curl verification) |

## Impact
| Area | Change |
|------|--------|
| `packages/core/src/types/session-context.ts` | `usedPercentage: z.number().min(0).max(100)` → `z.number().min(0)` |
| `apps/agent/src/routes/session-context.test.ts` | New test case for a value above 100 |

## Risks
| Risk | Mitigation |
|------|-----------|
| A downstream consumer assumes `usedPercentage <= 100` (e.g. a progress-bar UI) and renders oddly for values above it | No confirmed consumer today besides cc-tmux, which already reconstructs tokens rather than rendering the raw percentage directly; flagged as a follow-up audit if a new consumer surfaces |
| Landed before the companion cc-side fix | Inert — existing `<=100` traffic is unaffected; documented in § Cross-Repo Dependency as the safe landing order |
