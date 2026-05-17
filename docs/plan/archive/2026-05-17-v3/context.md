# v3 Plan Context

## Previous Phase: v2

**Archived**: `docs/plan/archive/2026-04-17-v2/`
**Completion**: `docs/plan/archive/2026-04-17-v2/COMPLETION.md`

v2 closed with an honest acknowledgment: its roadmap was strategic scope, not an execution log. The 43 planned spec names had zero intersection with the 46 archived specs — the systems v2 named were built via other paths or already existed. Actual work during v2 was responsive (audit findings, bug reports, user requests) rather than top-down roadmap execution.

## State at v3 Start

### Audit posture (as measured by audit-scan)
- **Composite score: 100/A**
- Axes: quality 99, structure 100, architecture 100
- Total findings: 4 (all info-level: B3, C11, F5, F8, G10)
- Suppressions: 227 total (92 by-config + 135 auto-skip-test-files)

### Codebase
- TypeScript files: 347
- Test files: 107
- Cargo workspace (per CLAUDE.md): `nexus-core`, `nexus-agent`, `nexus-tui`
- Architecture: hybrid Rust crates + Bun/Next.js overlay (Rust impl superseded by Bun during v2)

### Bead queue
- **Total issues lifetime: 1055** (981 closed, 74 open)
- **Open beads are almost entirely stale** — reference specs not in `openspec/changes/`
- Only 1 legitimately open audit-debt bead: `nx-wce7` (credential_swaps table, future-work marker)

### In-flight work
- `migrate-nx-terraform` — 12/18 done, 6 `[user]`-blocked tasks require Leo at the keyboard (TF Cloud workspace creation, secrets, `pnpm tf init/apply`)

## Carry-Forward Context

### Orphan-spec beads requiring sweep (before any v3 planning)

Before v3's scope can be trusted, the ~74 orphan-spec beads need verification-sweep (same pattern as terminal-attach / credential-mgmt / notification sweeps during v2 close). The source specs don't exist in `openspec/changes/`, meaning beads reference work that was either:
- Delivered via different spec names (most likely — per v2 drift pattern)
- Never actually proposed (orphaned from planning artifacts)
- Stale from a process change

Top sources (from v2 COMPLETION.md):
- `enforce-layering-dry-cleanup` — 13 tasks
- `add-type-codegen-bridge` — 9 tasks
- `improve-credential-page-status` — 2 tasks
- `harden-sql-credential-pool` — 2 tasks
- `add-credential-lifecycle-tracking` — 2 tasks
- `cleanup-credential-table` — 1 task
- Standalone (no spec tag): ~40 tasks

**Recommended v3 first action**: sweep these before any new planning. Follow the verify-then-close pattern that worked in v2 close.

### Deferred real work

Genuinely tracked future work (not stale):
- `nx-wce7` — Add credential_swaps table for per-session credential rotation history (from attribution.ts TODO)

### In-flight blocked by manual action

- `migrate-nx-terraform` remainder — 6 tasks, all `[user]`-owned. Requires Leo to create TF Cloud workspace and run terraform commands. This is NOT agent work.

## Lessons from v2 to apply in v3

1. **Don't write roadmaps as execution contracts** unless you commit to using the listed names as spec names. v2's gap between plan and execution was structural; v3 should either drop that expectation explicitly or enforce it operationally.

2. **Responsive spec creation works well for this project**. Solo-dev tool projects driven by audit findings + user needs don't benefit from top-down roadmapping. Consider dropping the detailed `roadmap.md` artifact in favor of a lighter "strategic intent" doc.

3. **Periodic bead sweeps prevent `/next` lying**. The priority-signal drift from stale beads required mid-session cleanup twice during v2. Schedule sweeps as ritual, not exception.

4. **Rule-refinement work compounds**. Audit tooling fixes in v2 (`fix-audit-scan-rules` pass 1 + pass 2) retired 6+ permanent suppression entries. Spend spec effort on tooling honesty, not just code fixes.

5. **Respect cognitive-budget signals**. End-of-day architectural refactors are doable but risky; v2 got lucky on `split-b4-large-files`. v3 should treat "walk away" as a legitimate next-action.

## Open Strategic Questions for v3

These shaped v2 and aren't resolved yet:

1. **Is nexus getting external users?** If yes: v3 must prioritize onboarding docs, config UX, error messages for humans-not-Leo, security hardening for non-Tailscale use cases. If no: v3 can stay internal-tool-shaped.

2. **What's the plan-artifact experiment for v3?** Keep v2's full `plan:*` pipeline? Adopt a lighter retrospective-first pattern? Drop formal planning altogether? This is the honest lesson from v2's completion.

3. **What's the architectural horizon?** v2's Rust→Bun migration was the largest single change but happened without a named spec. v3 should decide: is there another architectural migration coming, and if so, should it be planned vs. done-and-retrofitted?

4. **Feature cadence vs. infrastructure cadence?** v2's late weeks went entirely to infrastructure (audit, refactoring). Is that sustainable, or does v3 need feature work to stay interesting?

## Recommended First Steps for v3

Before invoking `/plan:scope` or `/plan:roadmap`:

1. **Orphan-spec bead sweep** — ~20-30 min, closes 40-60 stale beads, restores `/next` signal quality. Highest-leverage cheap win.
2. **Answer the 4 strategic questions above** — either in a scope-interrogation session (`/plan:scope`) or as a lightweight note. The answers shape everything downstream.
3. **Decide on plan-artifact shape** — before re-running the `/plan:*` pipeline verbatim, decide if v2's plan structure served the project. If no, adopt a different one for v3.

## Not Yet Locked

v3 starts empty. No artifacts are locked. Next step is either:
- `/plan:scope docs/plan/v3/context.md` — lock scope through interrogation
- Ad-hoc work on the orphan-bead sweep first, then `/plan:scope` with a cleaner baseline

Both are defensible. Recommend the sweep first.
