# Change: Spec Project Discovery API

## Why
The `ListProjects` RPC exists but isn't documented as a capability. External consumers like Nova
need to discover which projects are available on which agents to offer smart session routing
(e.g., "run /apply on oo" → resolve to the agent hosting oo's working directory).

## What Changes
- Create capability spec documenting the ListProjects API contract
- No code changes needed — the RPC is already implemented and functional

## Impact
- Affected specs: `project-discovery` (new capability spec)
- Affected code: none (already implemented)
- Documentation-only change
