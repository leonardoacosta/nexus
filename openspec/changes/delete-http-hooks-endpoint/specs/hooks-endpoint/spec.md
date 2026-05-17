## REMOVED Requirements

### Requirement: HTTP POST /hooks endpoint

**Reason for removal**: With socket-only ingestion live (P3.1, P3.2, P3.3) and CC hooks migrated to the socket helper, the HTTP endpoint is dead code. Removing it eliminates a maintained surface, simplifies the dispatcher entry path, and removes the "two doors" mental model from the codebase.

**Migration**: callers must use the AF_UNIX socket via `nexus-emit` helper. No cross-machine HTTP hook ingress is supported in the spine architecture (homelab is the exclusive dev box).

#### Scenario: curl POST /hooks returns 404
- **GIVEN** the endpoint is removed
- **WHEN** `curl -X POST http://localhost:7400/hooks -d '{}'`
- **THEN** response is 404 Not Found

#### Scenario: zero traffic on HTTP /hooks for 7 days prior to deletion
- **GIVEN** the pre-deletion check
- **WHEN** scanning the last 7 days of agent logs
- **THEN** zero POST /hooks invocations are found
