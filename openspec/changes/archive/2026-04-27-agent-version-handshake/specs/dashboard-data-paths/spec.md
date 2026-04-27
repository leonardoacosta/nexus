# dashboard-data-paths Specification

## ADDED Requirements

### Requirement: Dashboard probes agent /version before treating it as unreachable

The dashboard SHALL maintain a shared helper at `apps/nextjs/src/lib/agent-reachability.ts` that probes `GET /version` on the resolved agent base URL and classifies the result into a discriminated union with at least these variants: `{ ok: true, build, capabilities }`, `{ ok: false, reason: "no-agent" }`, `{ ok: false, reason: "timeout" }`, `{ ok: false, reason: "stale-binary", missing: string[] }`, `{ ok: false, reason: "http-error", status: number }`. Server actions that previously collapsed reachability into a single `boolean` SHALL accept this discriminated union and pass it through to client components.

#### Scenario: Healthy fresh binary returns ok with build identity

- **GIVEN** an agent serving `GET /version` with payload `{ buildSha: "abc1234", builtAt: "2026-05-01T10:00:00Z", capabilities: ["GET /notifications/settings", ...] }`
- **WHEN** the dashboard helper probes the agent
- **THEN** the helper SHALL return `{ ok: true, build: { sha: "abc1234", at: "2026-05-01T10:00:00Z" }, capabilities: [...] }`

#### Scenario: Stale binary missing required capability is classified

- **GIVEN** the dashboard expects capability `"GET /notifications/settings"`
- **AND** the agent's `/version` returns a `capabilities` array that does NOT include that string
- **WHEN** the dashboard helper probes the agent
- **THEN** the helper SHALL return `{ ok: false, reason: "stale-binary", missing: ["GET /notifications/settings"] }`
- **AND** the agent's reported `buildSha` SHALL be included in the diagnostic for display

#### Scenario: Timeout vs no-agent are distinguishable

- **GIVEN** the agent registry contains zero enabled agents
- **WHEN** the dashboard helper is invoked
- **THEN** the helper SHALL return `{ ok: false, reason: "no-agent" }` without attempting any HTTP call
- **AND** when the registry has an agent but the request exceeds the 5-second timeout, the helper SHALL instead return `{ ok: false, reason: "timeout" }`

### Requirement: Notifications page banner copy reflects classified reachability

`apps/nextjs/src/app/notifications/NotificationsClient.tsx` SHALL replace the unconditional "Agent unreachable — controls disabled" string with copy that maps to the reachability reason returned by the helper. The banner SHALL include the agent's `buildSha` (when known) so a single screenshot tells the user which build is misbehaving.

#### Scenario: Stale binary banner names the missing capability

- **GIVEN** the page has loaded with reachability `{ ok: false, reason: "stale-binary", missing: ["GET /notifications/settings"], build: { sha: "abc1234" } }`
- **WHEN** the page renders
- **THEN** the banner SHALL display copy that names the missing capability and the build SHA
- **AND** the controls SHALL remain disabled
- **AND** the banner SHALL NOT use the literal string "Agent unreachable" (which would be misleading — the agent IS reachable)

#### Scenario: True unreachability still uses unreachable copy

- **GIVEN** reachability is `{ ok: false, reason: "timeout" }`
- **WHEN** the page renders
- **THEN** the banner copy SHALL describe a network/timeout failure
- **AND** SHALL include the agent's host:port so the user knows which agent is unresponsive

#### Scenario: No agent registered surfaces actionable copy

- **GIVEN** reachability is `{ ok: false, reason: "no-agent" }`
- **WHEN** the page renders
- **THEN** the banner SHALL direct the user to register an agent (link to the agents settings page or instructions)
- **AND** SHALL NOT use copy that implies a network failure

### Requirement: Credentials page consumes the same reachability classifier

`apps/nextjs/src/app/credentials/page.tsx` SHALL use the same `agent-reachability.ts` helper as the notifications page. When `/version` reports the binary is missing a credential-related capability, the credentials page banner SHALL distinguish that case from the existing "No credentials found" empty-pool case.

#### Scenario: Empty pool keeps existing empty-state copy

- **GIVEN** the agent reports `ok: true` from `/version`
- **AND** `GET /credentials` returns `{ credentials: [], activeFingerprint: null }`
- **WHEN** the credentials page renders
- **THEN** the page SHALL continue to show the "No credentials found" copy (unchanged)
- **AND** the page SHALL NOT show any version-mismatch banner

#### Scenario: Missing credential capability shows distinct banner

- **GIVEN** the agent's `/version` reports it does NOT include capability `"GET /credentials"`
- **WHEN** the credentials page renders
- **THEN** the page SHALL show a stale-binary banner (not the empty-pool copy)
- **AND** the banner SHALL include the build SHA
