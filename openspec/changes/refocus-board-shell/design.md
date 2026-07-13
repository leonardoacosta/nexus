# Design — refocus-board-shell

Visual + IA source of truth: `docs/diagrams/nx-refocus-board.html` (sections 01–07, phosphor
instrument language). This file records the decisions that constrain implementation.

## Decisions

### Rail is the only selector

No header project dropdown (Leo, 2026-07-13). The left rail lists `All` + registered projects
with open-work counts; selection drives the whole board. Presence is a single homelab dot in
the titlebar — the dashboard only expects to reach the homelab agent.

### Proposals are the triage unit; capabilities are tags

`GET /roadmap` returns capabilities → proposals, but the board flattens to proposal rows with
the capability as a muted suffix tag. Rationale: bd's feature-primary priority model — features
(proposals) are where triage happens; a capability grouping level would fold the work Leo
actually ranks. The `RoadmapCapability` wire shape is unchanged; flattening is client-side.

### `all` is a query-param branch, not a new route

`GET /roadmap?project=all` and `GET /beads/unlinked?project=all` reuse the existing handlers'
shape with an additive optional `project` tag on each entry. Existing single-project consumers
(iOS, current RoadmapView until deletion) decode unchanged. Fan-out runs concurrently
(`Promise.allSettled`); a failing project is excluded (logged), never a 500 — same degradation
contract the single-project handlers already document. `hidden: true` projects are excluded
from `all`.

### Descriptions ride the existing rollup, no N+1

`bd list --json` already returns `description`; `bead-rollup` and `beads-unlinked` simply stop
dropping it. `BeadRef.description?` / `UnlinkedBead.description?` are optional so stale agents
and old payloads decode fine. The board's expand-for-description never issues a second fetch.

### Re-home, don't rewrite

Settings tabs wrap the existing `CredentialsView`, `IntegrationsView`, `SourceIndexView`,
`ProjectVoicesView`, `SettingsView` bodies. The attach sheet re-homes `PtyViewer` (816 lines —
keeps writer-claim, Stream/Full, resize). The drawer re-homes `NotificationsView`'s list,
replay, and meeting-mode controls. Deleted outright (superseded by the board): `RoadmapView`,
`SpecsView` + `SpecDetailView` (detail rail absorbs spec-content rendering), `ProjectsView` +
`ProjectAccordionRow`, `FailuresView`, `HealthView` (titlebar dot + `ProcessTableView` popover
survive), Decide deck views (`DecideDeckView`, `DecideCardView`, `DecideScene`, `VerdictBox`)
— approve/reject moves to proposal rows/detail rail calling the same `/specs` endpoints.

### Deletion hygiene

`DashboardNavigationCoordinator` deep-links, `nx.dashboard.defaultView` restore values, and
`project.yml` file lists all reference deleted sections. The UI batch must grep-sweep deleted
type names to zero references and migrate persisted section defaults (`board` fallback) before
the typecheck gate counts.

### Build/verify contract (Swift on this fleet)

Headless gate: `ssh mac` + `swiftc -typecheck` / `xcodegen generate` + scheme build per the
Linux→Mac contract (swift-engineer agent owns it). GUI-bound behaviors (drawer slide-over,
sheet presentation, settings window, codesign) are a `[user]` on-device checklist task —
runtime evidence for those cannot be produced headlessly and is not claimed otherwise.

## Alternatives rejected

- **Board as a 13th section first, delete later** — ships redundant tabs, violates the
  clean-replacement default; Leo chose full restructure.
- **New `/board` aggregate endpoint** — the board is a client composition of three existing
  surfaces (roadmap, unlinked, specs); a bespoke endpoint would fork derivations the agent
  already owns (same reasoning as the snapshot-parity requirement in
  add-project-status-snapshots).
- **Capability-level grouping rows (reference screenshot's epic rows)** — folds the triage
  unit; rejected in the design doc, capability rendered as tag.
