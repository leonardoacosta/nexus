# Proposal

## Change ID
fix-project-registry-api

## Summary
Fix six P1/P2 correctness bugs in the project discovery pipeline: schema mismatch between handler and core types, silent tilde-path failures, swallowed readdirSync errors, sequential multi-agent fetches, cross-agent project duplication in the UI, and zero observability in route handlers.

## Context
The `GET /projects/discovered` handler in `apps/agent/src/routes/projects-discovered.ts` was written before the canonical `DiscoveredProjectsResponse` type was locked in `packages/core`. As a result, the handler returns `{projects, projectsDir, total}` while `@nexus/core` expects `{projects, truncated}`. Downstream consumer `agent-client.ts` reads `data.projects` correctly but `data.truncated` is always undefined. Tilde paths stored in `agents.projectsDir` are passed verbatim to `fs.readdirSync`, which silently produces ENOENT. Failures there are caught and returned as an empty list, indistinguishable from a genuinely empty directory. The multi-agent fetch in `fetchDiscoveredProjects` already uses `Promise.allSettled`, so the sequential bug (nx-oeun) is already partially addressed, but the same project appearing on N agents still produces N UI cards with no deduplication. Route handlers emit no log lines, making production diagnosis impossible.

## Motivation
- **nx-0frb**: Schema mismatch causes TypeScript consumers to read wrong field names; `truncated` is always `undefined` in practice.
- **nx-8v2a**: Tilde paths silently produce ENOENT; users with `~/dev` as `projectsDir` see an empty list with no error.
- **nx-bbd0**: `readdirSync` catch block returns the same shape as success; callers cannot tell the difference.
- **nx-abk1**: Same project on N agents renders N UI cards, inflating the project list.
- **nx-zhzr**: Zero log lines in route handlers; failures are invisible in production.
- **nx-hza9**: `os.hostname()` does not match the agent row ID on machines with alternate hostnames (e.g., FQDN vs short name).
- **nx-en71 / nx-oeun**: Cascading 5 s + 5 s TTL caches and (previously) sequential fetches inflate staleness to 10 s; event-driven invalidation is not in scope here but parallel fetch is.

## Requirements

### Req-1: Correct DiscoveredProjectsResponse shape
The handler MUST return `{projects, truncated}` matching the `DiscoveredProjectsResponse` type from `@nexus/core`. The local `DiscoveredProjectsResponse` interface in `projects-discovered.ts` MUST be removed in favour of the canonical import.

#### Scenario: handler aligns with core type
- **GIVEN** `GET /projects/discovered` is called on an agent with 3 discovered projects
- **WHEN** the response JSON is parsed as `DiscoveredProjectsResponse`
- **THEN** the body contains `{ projects: [...], truncated: false }` — no `projectsDir` or `total` field

#### Scenario: truncated flag set when cap is reached
- **GIVEN** the directory contains 101 qualifying subdirectories and the cap is 100
- **WHEN** `GET /projects/discovered` is called
- **THEN** `truncated` is `true` and `projects.length === 100`

### Req-2: Path normalization
The agent MUST expand tilde (`~`) in `projectsDir` to the home directory before calling `fs.readdirSync`. The resolved path MUST be absolute. If the resolved path is not absolute after expansion, the handler MUST return an error response rather than silently scanning an unexpected location.

#### Scenario: tilde path is expanded
- **GIVEN** `agents.projectsDir` is `"~/dev"` and the home directory is `/home/user`
- **WHEN** `GET /projects/discovered` is called
- **THEN** `fs.readdirSync` is called with `/home/user/dev`, not `~/dev`

#### Scenario: relative path after expansion is rejected
- **GIVEN** `agents.projectsDir` resolves to a non-absolute string
- **WHEN** `GET /projects/discovered` is called
- **THEN** the response is `{ error: "projectsDir must resolve to an absolute path" }` with status 400

### Req-3: Error-surfacing discovery
When `fs.readdirSync` throws, the handler MUST return a response with an `error` field describing the failure instead of returning an empty `projects` array. An empty directory MUST still return `{ projects: [], truncated: false }` without an `error` field so callers can distinguish the two cases.

#### Scenario: readdirSync ENOENT is surfaced
- **GIVEN** `projectsDir` points to a non-existent path
- **WHEN** `GET /projects/discovered` is called
- **THEN** the response body contains `{ error: "ENOENT: ..." }` and status is 200 (non-fatal, agent continues)

#### Scenario: empty directory returns empty list without error
- **GIVEN** `projectsDir` exists but contains no qualifying subdirectories
- **WHEN** `GET /projects/discovered` is called
- **THEN** the response body is `{ projects: [], truncated: false }` with no `error` field

### Req-4: Parallel multi-agent fetch
The `AgentClient.fetchAllProjects` and `fetchDiscoveredProjects` methods MUST issue requests to all configured agents concurrently using `Promise.allSettled`. No sequential `.then` chaining or `for-await` loops over agent requests are permitted.

#### Scenario: two agents are queried in parallel
- **GIVEN** two agents are configured
- **WHEN** `fetchDiscoveredProjects()` is called
- **THEN** both HTTP requests are initiated before either response is awaited (observable via `Promise.allSettled` semantics)

#### Scenario: one agent offline does not block the other
- **GIVEN** agent-a is offline (connection refused) and agent-b is online
- **WHEN** `fetchDiscoveredProjects()` is called
- **THEN** projects from agent-b are returned and agent-a contributes zero entries

### Req-5: Project deduplication
When the same project name+path appears across multiple agents, `fetchDiscoveredProjects` MUST merge those entries into a single `WithAgent<DiscoveredProject>` record. The merged record MUST include a `machineCount` field (integer) indicating how many agents returned the project. The UI MUST display one card per deduplicated project.

#### Scenario: same project on two agents produces one card
- **GIVEN** agent-a and agent-b both report `{ name: "nx", path: "/home/user/dev/nx" }`
- **WHEN** `fetchDiscoveredProjects()` is called
- **THEN** the result contains exactly one entry for `"nx"` with `machineCount === 2`

#### Scenario: distinct projects on different agents remain separate
- **GIVEN** agent-a reports `"nx"` and agent-b reports `"oo"` (different names)
- **WHEN** `fetchDiscoveredProjects()` is called
- **THEN** the result contains two entries: one for `"nx"` and one for `"oo"`, each with `machineCount === 1`

### Req-6: Observability
Every request to `GET /projects/discovered` and `GET /projects` MUST emit at least one structured pino log line. The log line MUST include: route name, duration (ms), project count, and — for discovered projects — whether the result came from cache. Errors (readdirSync failure, agent not found) MUST be logged at `error` level with the error message.

#### Scenario: successful discovery is logged
- **GIVEN** `GET /projects/discovered` returns 5 projects from a fresh scan
- **WHEN** the handler completes
- **THEN** a pino `info` log line is emitted containing `route`, `durationMs`, `count: 5`, `fromCache: false`

#### Scenario: cache hit is logged
- **GIVEN** the in-memory cache is still valid
- **WHEN** `GET /projects/discovered` is called again within the TTL
- **THEN** the log line contains `fromCache: true`

#### Scenario: readdirSync error is logged at error level
- **GIVEN** `projectsDir` does not exist
- **WHEN** the handler catches the ENOENT
- **THEN** a pino `error` line is emitted with the error message

## Scope

### In Scope
- Fix `DiscoveredProjectsResponse` shape in `projects-discovered.ts` (Req-1)
- Tilde expansion + absolute path guard (Req-2)
- `readdirSync` error surfacing (Req-3)
- Parallel fetch via `Promise.allSettled` in `agent-client.ts` (Req-4)
- Cross-agent deduplication + `machineCount` field (Req-5)
- Pino logger in `projects-discovered.ts` and `projects.ts` route handlers (Req-6)

### Out of Scope
- FK constraint on `sessions.project` (schema migration — separate risk, tracked as nx-tev9 backlog)
- Full pagination on project list (GCF — nx-469c)
- Full cache redesign / event-driven invalidation (nx-en71 — architectural change)
- Agent hostname normalization (nx-hza9 — requires agents.toml convention change)

## Impact
- **Affected specs**: `project-dir-scan`, `project-registry` (new delta spec)
- **Affected files**:
  - `apps/agent/src/routes/projects-discovered.ts`
  - `apps/agent/src/routes/projects.ts`
  - `apps/nextjs/src/lib/agent-client.ts`
  - `packages/core/src/types/project.ts` (add `machineCount` to `DiscoveredProject`)
- **Breaking**: `DiscoveredProjectsResponse` shape change removes `projectsDir` and `total` fields from the wire format. Any consumer relying on those fields must be updated.

## Risks
- **Wire format break**: Any existing TUI or UI code reading `response.projectsDir` or `response.total` will silently get `undefined`. Mitigation: grep for usages and update in the same PR.
- **machineCount field**: Adding a field to `DiscoveredProject` in `@nexus/core` is additive but requires a version bump if downstream packages import the type. Mitigation: the field is optional (`machineCount?: number`) so old consumers compile without change.
- **Dedup key choice**: Deduplicating by `name+path` may fail if the same physical project has different paths on different agents (e.g., different home directories). Accepted for now; GCF nx-lye8 tracks a more robust cross-agent dedup strategy.
