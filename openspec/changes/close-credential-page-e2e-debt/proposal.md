---
status: draft
---

# Proposal: Close credential-page E2E test debt (nx-ufde/t6sw/yad4/b0ew)

## Change ID
`close-credential-page-e2e-debt`

## Summary
Close 4 E2E test-coverage gaps deferred to backlog from 4 already-shipped, already-archived
specs (`improve-credential-page-status`, `cleanup-credential-table`,
`add-credential-lifecycle-tracking`) — the underlying behavior already exists and is already
spec'd; only the automated Playwright regression coverage was deferred.

## Context
- Related: `improve-credential-page-status` (archived, `nx-g4wy` — warning banner + source
  attribution), `cleanup-credential-table` (archived, `nx-jo3b` — MCP pills), `add-credential-lifecycle-tracking` (archived, `nx-oz50` — lifecycle event persistence)
- touches: `packages/e2e/tests/credentials/` (new/extended spec files)

## Motivation
Each of the 4 specs above closed with "all code tasks complete, N E2E tasks deferred to
backlog" — the shipped behavior was verified manually or via unit test at the time, but never
got an automated Playwright regression. Four beads have sat open since (nx-ufde since
2026-04-15, the oldest). None require new production code; this proposal is pure E2E
test-authoring against already-correct behavior.

**Naming note**: `nx-b0ew`'s title references `credential_events`, the table's name at the time
that bead was minted. `add-cc-credential-manager` later renamed it to `cc_profile_events`
(`packages/db/src/schema/ccProfileEvents.ts`) — this proposal's task targets the current table
name; the bead's stale terminology does not change the underlying verification target.

## Requirements

### Requirement: Distinct error banner for unreachable agents
When `agentReachable` is `false`, the credential page MUST render a warning banner instead of the empty-data message. The banner MUST include the list of agents that failed to respond and a suggestion to check agent status.

### Requirement: Agent source attribution in page header
When credentials load successfully, the page header MUST display the name of the responding agent (e.g., "via omarchy") next to the account count.

### Requirement: MCP provider display format
The MCP providers column MUST display full provider names as small colored pills instead of single-letter abbreviations.

### Requirement: The system SHALL emit structured lifecycle events for credential operations
The system SHALL emit a structured log event for each credential lifecycle transition (lease, release, cooldown entry, cooldown exit, stale release, predictive pre-rotation), AND the corresponding `cc_profile_events` row MUST be persisted to the database for each transition.

## Scope
- **IN**: 4 new/extended Playwright E2E spec files under `packages/e2e/tests/credentials/`
  exercising the 4 already-specified behaviors above
- **OUT**: any change to the production code paths these tests exercise (all 4 behaviors are
  already shipped and correct); the other 17 unrelated pre-existing failures in adjacent test
  files (out of scope, not this proposal's job)

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| Warning banner (agent unreachable) | N/A — already unit-tested at fetchCredentials level | [4.1] E2E: warning banner renders when agent is stopped |
| Agent source attribution | N/A — already covered by existing header unit test | [4.2] E2E: header shows responding agent name when agent is running |
| MCP provider pills | N/A — already unit-tested at render level | [4.3] E2E: MCP full-name pills render correctly |
| `cc_profile_events` persistence | N/A | [4.4] E2E: cc_profile_events row populated after lease/release |

## Impact
| Area | Change |
|------|--------|
| `packages/e2e/tests/credentials/` | +4 spec files (or +4 test cases in existing files) |

## Risks
| Risk | Mitigation |
|------|-----------|
| Flaky E2E against a live agent/DB | Follow `t3-testing-patterns` real-DB-not-mocks convention already used by the credential E2E suite |
