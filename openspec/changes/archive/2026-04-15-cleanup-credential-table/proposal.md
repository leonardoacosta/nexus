# Proposal: Clean Up Credential Table Columns

## Change ID
`cleanup-credential-table`

## Summary
Remove misleading columns (rate limits), refresh stale token expiry data on agent startup, and replace cryptic single-letter MCP badges with full-name pills.

## Context
- Extends: `apps/nextjs/src/components/CredentialsTable.tsx`, `apps/agent/src/credentials/pool.ts`
- Related: `improve-credential-page-status` (just archived — added agent reachability)

## Why
The credential table currently shows three misleading/confusing columns:
1. **Token Expiry** shows dates from April 1-4 (11+ days stale) because `expiresAt` is only extracted once at import time from the OAuth access token TTL. Claude Code credential files get updated frequently (token refresh), but the DB never re-reads them.
2. **Rate Limits** is all zeros because `CredentialPool.reportRateLimit()` exists but nothing in production calls it — the API interception pipeline isn't wired yet.
3. **MCPs** shows cryptic single-letter badges ("P", "F", "S") that require hovering to decode.

## Requirements

### Requirement: Refresh credential metadata on agent startup
The agent MUST re-read all credential files from `~/.config/nexus/credentials/` on startup and update `expiresAt`, `subscriptionType`, `rateLimitTier`, and `mcpProviders` in the database for each existing credential (matched by fingerprint).

### Requirement: Remove rate limits column
The credential table MUST NOT display the `rateLimitCount` column until the interception pipeline populates it with real data.

### Requirement: Full-name MCP provider pills
The MCP providers column MUST display full provider names (e.g., "figma", "slack", "posthog") as small colored pills instead of single-letter abbreviations.

## Scope
- **IN**: Credential metadata refresh on startup, remove rate limits column, MCP full-name pills
- **OUT**: Token consumption/usage display, periodic metadata refresh (cron), credential file watcher metadata updates, new columns

## What Changes
| Area | Change |
|------|--------|
| `apps/agent/src/credentials/pool.ts` | Add `refreshMetadata()` method that re-reads credential files and updates DB |
| `apps/agent/src/index.ts` or startup path | Call `refreshMetadata()` after pool initialization |
| `apps/nextjs/src/components/CredentialsTable.tsx` | Remove rate limits column, replace MCP single-letter badges with full-name pills |

## Risks
| Risk | Mitigation |
|------|-----------|
| Refresh on startup adds latency to agent boot | Credential dir has 18 files — reads are <50ms total. Non-blocking if needed. |
| Removing rate limits column breaks future expectations | Column was never useful; re-add when interception pipeline ships |
