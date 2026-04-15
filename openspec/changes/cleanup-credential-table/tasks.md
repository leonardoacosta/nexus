# Implementation Tasks

<!-- beads:epic:nx-jo3b -->

## DB Batch

(no schema changes required)

## API Batch

- [x] [2.1] [P-1] Add `refreshMetadata()` method to CredentialPool that reads credential files, computes fingerprints, and updates expiresAt/subscriptionType/rateLimitTier/mcpProviders for matching DB rows [owner:api-engineer] [beads:nx-fw2u]
- [ ] [2.2] [P-2] Call `refreshMetadata()` on agent startup after pool initialization in index.ts [owner:api-engineer] [beads:nx-8w6t]

## UI Batch

- [ ] [3.1] [P-1] Replace MCP single-letter badges with full-name colored pills in CredentialsTable.tsx [owner:ui-engineer] [beads:nx-7ja2]
- [ ] [3.2] [P-1] Remove rate limits column (header, sort logic, and cell) from CredentialsTable.tsx [owner:ui-engineer] [beads:nx-bbqg]

## E2E Batch

- [ ] [4.1] [deferred] Verify credential table renders full MCP provider names as pills [owner:e2e-engineer] [beads:nx-yad4]
