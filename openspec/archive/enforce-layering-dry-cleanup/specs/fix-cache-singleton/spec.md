# Spec: Fix Cache Singleton

## MODIFIED Requirements

### Requirement: Hoist TtlCache to module scope

The `TtlCache` instance MUST be created at module level in `apps/nextjs/src/lib/get-client.ts` and injected into `AgentClient` via constructor parameter. The cache SHALL persist across multiple `getClient()` calls within the same process lifecycle.

#### Scenario: cache survives across getClient calls in dev server

**Given** the Next.js dev server is running (long-lived process)
**When** `getClient()` is called twice within the cache TTL window
**Then** the second call's `AgentClient` shares the same `TtlCache` instance as the first

#### Scenario: AgentClient accepts external cache

**Given** `AgentClient` is constructed with an optional `cache` parameter
**When** a `TtlCache` instance is passed
**Then** the client uses the provided cache instead of creating a new one

#### Scenario: serverless cold start gets fresh cache

**Given** a serverless function cold-starts
**When** the module is loaded for the first time
**Then** a new module-level `TtlCache` is created (no stale data from prior invocation)
