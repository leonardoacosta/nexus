# project-registry Specification

## ADDED Requirements

### Requirement: Agent identity resolves via configured agent ID, not hostname
The agent's identity SHALL resolve to the `agentId` configured in `agents.toml` (via `packages/core/src/config.ts` loader), NOT via `os.hostname()`. When no agent ID is configured, the resolver MAY fall back to `os.hostname()` to preserve backward compatibility on single-machine deploys.

#### Scenario: Configured agent ID is used for project-discovered lookup
- **GIVEN** `agents.toml` has an entry with `id = "my-agent"` for the current agent
- **AND** `os.hostname()` returns `"pod-xyz-789"` (container hostname, unrelated to agent ID)
- **WHEN** `/projects/discovered` queries the agent via its configured identity
- **THEN** the lookup SHALL use `"my-agent"`, not `"pod-xyz-789"`
- **AND** the lookup SHALL succeed

#### Scenario: Fallback to hostname when no agent ID is configured
- **GIVEN** `agents.toml` has no `id` field (or no agent entry matches)
- **WHEN** the identity is resolved
- **THEN** `os.hostname()` MAY be used as a fallback
- **AND** a warning SHALL be logged noting the fallback was taken

### Requirement: Cursor pagination on project endpoints
`GET /projects` and `GET /projects/discovered` SHALL accept optional `cursor` (opaque string token) and `limit` (integer, default 50, max 200) query parameters. Responses SHALL include `nextCursor` when more results exist beyond the returned page. The current `truncated: true` behavior on `/projects/discovered` SHALL be preserved as a fallback for callers that do not supply a cursor.

#### Scenario: Paginated request returns windowed results with nextCursor
- **GIVEN** a registry with 120 projects
- **WHEN** a client calls `GET /projects?limit=50`
- **THEN** the response SHALL contain 50 project entries
- **AND** the response SHALL include `nextCursor` set to an opaque string
- **AND** calling `GET /projects?cursor=<nextCursor>&limit=50` SHALL return the next 50 entries
- **AND** the third page SHALL contain the remaining 20 entries with `nextCursor: null` or absent

#### Scenario: Non-paginated caller gets legacy truncated-flag behavior
- **GIVEN** `/projects/discovered` would return more than 100 project locations
- **WHEN** a client calls `GET /projects/discovered` without `cursor` or `limit` query params
- **THEN** the response SHALL return at most 100 entries with `truncated: true` (existing behavior)
- **AND** no `nextCursor` SHALL be included

#### Scenario: Invalid cursor returns 400
- **GIVEN** a client calls `GET /projects?cursor=not-a-valid-cursor`
- **WHEN** the cursor fails to decode
- **THEN** the response SHALL be 400 Bad Request with a clear error message
- **AND** the response SHALL NOT leak the internal cursor format

#### Scenario: limit exceeding max clamps to max
- **GIVEN** a client calls `GET /projects?limit=1000`
- **WHEN** the server processes the request
- **THEN** the response SHALL contain at most 200 entries (max limit enforced server-side)
- **AND** a warning SHALL be logged noting the clamp was applied
