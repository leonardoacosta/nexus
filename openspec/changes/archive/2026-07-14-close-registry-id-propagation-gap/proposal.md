---
status: draft
---

# Proposal: Close the registryId propagation gap (nx-611m/bu4o/jbl5/sqb8)

## Change ID
`close-registry-id-propagation-gap`

## Summary
Propagate `registryId` end-to-end through the discovered-projects pipeline — from
`GET /projects/discovered`'s response, through `AgentDiscoveredProject` and the core
`DiscoveredProject` type, to the Next.js client mapping — closing 4 tasks deferred from the
already-archived `fix-project-discovery` / `add-project-registry` specs.

## Context
- Extends: `apps/agent/src/routes/projects-discovered.ts` (or equivalent handler),
  `AgentDiscoveredProject` interface, `packages/core`'s `DiscoveredProject`, `agent-client.ts`
- Related: `add-project-registry` (archived, closed `nx-0p7b` — "canonical project registry
  with multi-machine location tracking"; these 4 tasks were explicitly deferred pending its
  completion, which has now happened — the `projects` table exists)
- touches: `apps/agent/src/routes/projects-discovered.ts`, `packages/core/src/types/project.ts`, `apps/nextjs/src/lib/agent-client.ts`

## Motivation
Four sequential tasks (7.1-7.4) were deferred from `fix-project-discovery` specifically
because they depended on `add-project-registry`'s `projects` table existing first. That
dependency is now satisfied (the spec archived, `nx-0p7b` closed 2026-04-06). The gap: a
discovered project currently carries no link back to its canonical registry row, so a
consumer cannot join a filesystem-discovered project against its `projects`/`project_locations`
registry entry without a separate lookup.

## Requirements

### Requirement: A discovered project SHALL carry its canonical registryId end-to-end
`GET /projects/discovered` MUST include `registryId` (the matching `projects.id`, or `null`
when no registry row exists yet) in its response by querying the `projects` table.
`AgentDiscoveredProject` MUST declare `registryId: string | null`. `packages/core`'s
`DiscoveredProject` MUST declare `registryId?: string | null`. `apps/nextjs/src/lib/
agent-client.ts` MUST map `registryId` from the wire format through to the client-side
`DiscoveredProject` unchanged.

#### Scenario: A registered project's discovery response carries its registryId

- **GIVEN** a project exists in the `projects` table with `id="abc-123"`
- **AND** that project is also discovered on disk by the agent's folder scan
- **WHEN** `GET /projects/discovered` is called
- **THEN** the response's matching entry has `registryId: "abc-123"`

#### Scenario: An unregistered discovered project has a null registryId

- **GIVEN** a project directory is discovered on disk with no matching `projects` row
- **WHEN** `GET /projects/discovered` is called
- **THEN** the response's matching entry has `registryId: null`

#### Scenario: registryId survives the full client round-trip

- **GIVEN** the agent response includes `registryId: "abc-123"` for a discovered project
- **WHEN** `agent-client.ts` maps the wire payload to `DiscoveredProject`
- **THEN** the resulting client-side object's `registryId` is `"abc-123"`, unchanged

## Scope
- **IN**: `GET /projects/discovered` handler, `AgentDiscoveredProject`, `packages/core`'s
  `DiscoveredProject`, `agent-client.ts`'s wire-to-client mapping
- **OUT**: any UI rendering of `registryId` (no consumer requested yet — this closes the
  plumbing gap only); registry write paths (upsert/discovery-upsert, already covered by
  `add-project-registry`)

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `GET /projects/discovered` route | [2.1] route unit test: registered vs unregistered project | N/A — covered by existing route test file |
| `agent-client.ts` mapping | [3.1] client mapping test: registryId round-trips unchanged | N/A — no new user-facing flow |

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/routes/projects-discovered.ts` | +1 field in response, +1 `projects` table join |
| `AgentDiscoveredProject` (agent-side interface) | +1 field |
| `packages/core/src/types/project.ts` | +1 optional field |
| `apps/nextjs/src/lib/agent-client.ts` | +1 field in wire-to-client mapping |

## Risks
| Risk | Mitigation |
|------|-----------|
| Extra join adds latency to a hot discovery-poll path | `projects.id` is a simple indexed lookup, same table `add-project-registry` already queries elsewhere |
| Backward compatibility with existing `AgentDiscoveredProject` consumers | Field is additive (`string \| null`), no existing field renamed or removed |
