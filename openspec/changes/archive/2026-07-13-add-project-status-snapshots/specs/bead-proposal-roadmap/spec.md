# bead-proposal-roadmap Delta

## ADDED Requirements

### Requirement: Persisted unlinked counts match the live derivation

The snapshot pipeline's `beads_ready_unlinked` and `beads_blocked_unlinked` values MUST be
produced by the same unlinked-bead and ready/blocked derivation rules the live
`beads-unlinked` surface uses (proposal-marker linkage from `bead-rollup`, fleet-matching
ready/blocked semantics). The JSONL-based recount MUST NOT fork its own definition; parity MUST
be covered by a test that runs both derivations against one fixture.

#### Scenario: Both derivations agree on a fixture

- **Given** a fixture project with linked beads, an ad-hoc unlinked ready bead, and an unlinked bead blocked by an open dependency
- **When** the live beads-unlinked derivation and the snapshot recount both run against it
- **Then** both report identical ready-unlinked and blocked-unlinked totals

#### Scenario: Bead linked to an archived proposal counts as unlinked

- **Given** a bead referenced only by a proposal that has been archived
- **When** the snapshot recount runs
- **Then** the bead counts toward the unlinked totals, matching the live surface's treatment
