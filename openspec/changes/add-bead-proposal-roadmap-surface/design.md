# Design: bead <-> proposal <-> roadmap surface

## Ground truth (verified 2026-07-07)

| Fact | Evidence |
| --- | --- |
| `bd` supports `--spec-id` on create + update | `bd create --help` / `bd update --help` -> `--spec-id string "Link to specification document"` |
| `bd show <id> --json` surfaces `spec_id` when set | throwaway bead `nx-e475s` created `--spec-id verify-spec-slug-xyz` -> `spec_id: 'verify-spec-slug-xyz'` |
| `bd list`/`ready --json` do NOT emit `spec_id` | field list: `[...,'priority','status','title','updated_at']`, no `spec_id` |
| `bd list --id a,b,c --json` batch-fetches by ID | `bd list --help` -> `--id string "Filter by specific issue IDs (comma-separated)"` |
| `spec-sync` already writes `--spec-id=<slug>` on feature + task beads | `~/.claude/scripts/bin/spec-sync:249,310` |
| `tasks.md` already carries the reverse index | `<!-- beads:epic:nx-ywqig -->`, `<!-- beads:feature:nx-6w2s0 -->`, `[beads:nx-21zcj]` per task line |
| nx already surfaces proposals | `apps/agent/src/routes/specs.ts` (list/detail/approve/reject/content/status) |
| Crude bead count exists | `fetchBeadsSummary` in `specs.ts:77` — `bd ready --json` length, `closed` hard-coded 0 |

**Consequence for the design:** the proposal->bead link is already materialised in `tasks.md`
markers. We never need per-bead `bd show` (N+1) nor the missing bulk `spec_id` filter — parse the
markers, then a single `bd list --id <csv> --json` gives live state for the whole proposal.

## Reverse-lookup mechanism (decision)

**Chosen: parse `tasks.md` markers -> one batched `bd list --id`.** Rejected alternatives:

- *Per-bead `bd show --json` for `spec_id`* — N+1, and `spec_id` is redundant here because the
  marker IS the link.
- *Query the beads Dolt store directly* — couples nx to bd internals; violates the "bd CLI is the
  only reader/writer" discipline stolen from beadboard's null-safe read path (recon A1).

Marker grammar (already emitted by `spec-sync`, parsed read-only here):

```
<!-- beads:epic:<id> -->        # capability epic (whole-file, top)
<!-- beads:feature:<id> -->     # this proposal's feature bead (whole-file, top)
- [x] 1.1 ... [beads:<id>]      # per task line
```

`bead-rollup.ts` extracts `{epicId, featureId, taskIds[]}` with three regexes, dedups, then:

```ts
const ids = [epicId, featureId, ...taskIds].filter(Boolean);
const beads = ids.length ? await execJson("bd", ["list", "--id", ids.join(","), "--json"], {cwd}) : [];
```

`execJson`/`execText` already exist (`apps/agent/src/utils/exec.ts`, used by `specs.ts`). Failures
degrade to `null` (never throw) exactly like `fetchBeadsSummary` — a missing/renamed bead simply
drops out of the rollup rather than 500-ing the specs route.

## Aggregation

```ts
interface BeadRef { id: string; status: string; type: string; priority: number; title: string }
interface BeadRollup {
  epic:    BeadRef | null;          // resolved [CAPABILITY] epic
  feature: BeadRef | null;          // this proposal's feature bead
  tasks:   { total: number; closed: number; ready: number; blocked: number };
  beads:   BeadRef[];               // full linked set for the detail view
}
```

- `closed` = status `closed`. `ready` = open + `dependency_count == 0` (or bd `ready` membership).
  `blocked` = status `blocked` OR has an unclosed `blocks` dependency (derive like beadboard's
  `deriveBlockedIds`, recon S1 — pure fn, unit-tested). `total` = task beads only (epic/feature
  excluded from the bar so a proposal with 14 tasks reads `x/14`, matching `bd epic status`).
- Ready-count uses `bd ready --json` membership intersected with the proposal's task IDs so the
  "ready" definition stays identical to the rest of the fleet (single source of truth for "ready").

## Unlinked (orphan) beads

```
open = bd list --status open,in_progress --json           # all live work in the project
linked = union of {epicId,featureId,taskIds} across every live proposal's tasks.md
unlinked = open where id not in linked
```

Computed in `beads-unlinked.ts`, reusing the same marker parse (shared helper
`collectLinkedBeadIds(projectPath)` in `bead-rollup.ts`). Archived proposals are NOT scanned for
`linked` — a bead whose only proposal was archived legitimately resurfaces as unlinked open work
(it is, in fact, unplanned again). Returns `UnlinkedBead[]` (`{id,title,status,priority,type}`).

## Roadmap aggregation

```
capabilityEpics = bd list --type epic --json   |> filter title starts-with "[CAPABILITY] "
for each epic:
  featureBeads = children of epic with type feature       # bd dep / parent field
  for each featureBead:
    slug = featureBead.spec_id                             # bd show <feature> --json (only place we need spec_id)
    rollup = BeadRollup for that proposal (reuse bead-rollup.ts)
  capabilityProgress = sum(closed tasks) / sum(total tasks) across features
```

This is the ONE place `spec_id` (via `bd show <featureBead> --json`) is read — it is the
feature-bead -> proposal-slug edge that lives nowhere else. Bounded: one `bd show` per feature bead
(feature beads per capability are few — 6 feature beads total in nx today). `RoadmapCapability`:

```ts
interface RoadmapCapability {
  name: string;                       // "agent-lifecycle" (from [CAPABILITY] <name>)
  epicId: string;
  epicStatus: string;
  proposals: Array<{ slug: string; rollup: BeadRollup; specStatus: string }>;
  progress: { totalTasks: number; closedTasks: number };
}
```

## Endpoints (agent)

| Method | Path | Handler | Returns |
| --- | --- | --- | --- |
| GET | `/specs/:project/:name` (extend) | `specs.ts handleGetSpec` | `{...spec, frontmatter, beadRollup}` |
| GET | `/specs/all` (extend) | `specs.ts handleGetSpecsAll` | per-spec `beadRollup` replaces the count-only `beads` field |
| GET | `/beads/unlinked?project=` (new) | `beads-unlinked.ts` | `{ unlinked: UnlinkedBead[] }` |
| GET | `/roadmap?project=` (new) | `roadmap.ts` | `{ capabilities: RoadmapCapability[] }` |

Routes registered in `apps/agent/src/server-request-handler.ts` alongside the existing `/specs*`
dispatch. All handlers are read-only; no auth change (same `:7400` Tailscale surface).

## Wire contract & Swift models

`packages/core/src/types/spec.ts` gains `BeadRollup`/`BeadRef`/`UnlinkedBead`;
`packages/core/src/types/roadmap.ts` (new) holds `RoadmapCapability`. Both exported from
`packages/core/src/index.ts`. Swift Codable mirrors:

- `NexusShared/Models/BeadRollup.swift` — `BeadRollup`, `BeadRef`, `UnlinkedBead` (non-optional
  counts, following the `SpecSummary` `?? false` wire discipline in `specs.ts:167`).
- `NexusShared/Models/Roadmap.swift` — `RoadmapCapability`.
- `NexusShared/Models/SpecSummary.swift` — add optional `beadRollup`.
- `NexusShared/Networking/NexusClient.swift` — `fetchUnlinkedBeads(project:)`,
  `fetchRoadmap(project:)`; `fetchSpec` decodes the new field.

## Swift UI

- `SpecsView.swift` — each proposal row: a thin progress bar (`closed/total`), a ready-count chip,
  tappable epic/feature bead ids. A new "Unlinked open beads" `Section` below the proposal list.
- `SpecDetailView.swift` — a "Beads" section listing `rollup.beads` with a status glyph
  (reuse the status-glyph convention already used for sessions/specs).
- `RoadmapView.swift` (new) — `List` of capabilities, each a `DisclosureGroup` of its proposals
  with per-proposal + per-capability progress bars.
- `AppNavigation.swift` — register the Roadmap tab beside Specs.

## Statusline

`apps/nexus-statusline/src/index.ts` — add two lines behind the existing stale-while-revalidate
file cache (the `getRoadmapPulse()` shape): a specs line (top in-progress proposal `x/total .
N ready`) and a roadmap line (least-complete capability). Cache TTL ~5min, detached refresh, empty
on first render — identical mechanism to the existing pulse cache; no new cache infrastructure.

## Non-goals

- No persistence of rollups (no DB table). Live compute + in-memory/file cache only.
- No bd writes from nx. `spec-sync` remains the only writer of `--spec-id`.
- No editing of proposals/beads from the roadmap surface (read-only this feature).
- No iOS/watch parity this feature (mac dashboard + statusline only; NexusShared models are shared
  so iOS can adopt in a follow-up without a wire change).
