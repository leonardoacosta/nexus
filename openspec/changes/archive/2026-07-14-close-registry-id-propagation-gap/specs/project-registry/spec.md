## ADDED Requirements

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
