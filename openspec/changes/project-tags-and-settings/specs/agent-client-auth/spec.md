## MODIFIED Requirements

### Requirement: agent-client sends x-nexus-secret on all requests

All HTTP requests from `AgentClient` to agent endpoints MUST include the `x-nexus-secret` header sourced from `process.env.NEXUS_ATTACH_SECRET`. The header MUST be present on both `fetchWithRetry` calls and the direct `fetch` in `startSession`.

#### Scenario: fetchWithRetry includes auth header
- GIVEN: `NEXUS_ATTACH_SECRET=abc` in env
- WHEN: any `AgentClient` method triggers `fetchWithRetry`
- THEN: the outgoing request includes `x-nexus-secret: abc`
- AND: the agent responds 200 instead of 401

#### Scenario: startSession error path handles plain-text 401
- GIVEN: the agent returns `401 Unauthorized` (text body) because the secret is wrong
- WHEN: `startSession` reads the error response body
- THEN: no `SyntaxError` is thrown (uses `res.text()` not `res.json()` in the error path)

### Requirement: resolveAttachAgent returns agent config name

`resolveAttachAgent` MUST return `{ agentName: string; isFallback: boolean }` where `agentName` matches the agent config `name` field (e.g., "omarchy"), not the database UUID stored in `agentId`.

#### Scenario: Start Session uses agent name not UUID
- GIVEN: `project.locations[0].agentId = "abc-123-uuid"` and `.agentName = "omarchy"`
- WHEN: `resolveAttachAgent` is called for that project
- THEN: the return value is `{ agentName: "omarchy", isFallback: false }`
- AND: `startSession("omarchy", ...)` succeeds without "Agent not found" error
