# Proposal: Refine Credential Page Grouping

## Change ID
`refine-credential-page-grouping`

## Summary
Restructure the credentials page so individual accounts (deduped by OAuth refresh-token fingerprint) are the top-level rows, surface per-account usage limits, and highlight the account currently active for Claude Code by watching `~/.claude/.credentials.json`.

## Context
- Extends: `apps/nextjs/src/app/credentials/page.tsx`, `apps/nextjs/src/app/actions/credentials.ts`, `apps/nextjs/src/components/credentials-table/`
- Extends: `apps/agent/src/credentials/credential-watcher.ts`, `apps/agent/src/routes/credentials/`
- Related: archived `improve-credential-page-status` (agent reachability + source attribution) and `credential-identity` (fingerprint + duplicateGroupId schema)

## Motivation
Today the credentials page is a flat list of files. Duplicates are collapsed into a `(+N)` badge on a row, but the mental model the user actually needs is an **account** (a refresh-token identity) with N underlying snapshot files. The page also omits two signals already present in the data: the percentage of the 5-hour usage window consumed, and which account Claude Code is actively reading from disk. Without these, the page cannot answer the top question users ask: *"Which account is being billed right now, and how close is it to its limit?"*

## Requirements

### Requirement: Accounts render as the top-level row
The credentials page MUST render one row per **account** (fingerprint-grouped) and expand to show underlying snapshot files on demand, replacing the current flat file list.

### Requirement: Usage limits visible on every account row
Each account row MUST display 5-hour usage percent and reset time using the data already produced by the usage poller, with a graceful fallback when usage has not yet been polled for that account.

### Requirement: Active-account indicator driven by `~/.claude/.credentials.json`
The agent MUST watch `~/.claude/.credentials.json` (symlink target or direct file) and expose the refresh-token fingerprint of the currently-active credential so the page can mark exactly one account as "active for Claude Code".

### Requirement: Server action returns account-first shape
`fetchCredentials()` MUST return an account-first structure: `accounts: Account[]` where each `Account` carries `fingerprint`, `isActiveForCc`, `usagePercent`, `resetsAt`, `plan`, `tier`, and `snapshots: CredentialFile[]`. Existing fields (`agentReachable`, `failedAgents`, `agentSource`) are preserved.

## Scope
- **IN**: credentials page restructure (account-first rows), usage percent + reset column, active-account indicator, agent-side watcher for `~/.claude/.credentials.json`, new `GET /credentials/active` endpoint, server action reshape
- **OUT**: credential pool rotation logic changes, Anthropic usage API polling strategy, credential encryption, new authentication flows, account deletion UI

## Impact
| Area | Change |
|------|--------|
| `apps/agent/src/credentials/credential-watcher.ts` | Add second fs watcher on `~/.claude/.credentials.json` (symlink target resolution + debounce) |
| `apps/agent/src/routes/credentials/` | Add `GET /credentials/active` returning `{ fingerprint, resolvedPath, observedAt }` |
| `apps/nextjs/src/app/actions/credentials.ts` | Reshape return type to `accounts: Account[]` with snapshots nested |
| `apps/nextjs/src/app/credentials/page.tsx` | Render account rows as primary; header account count reflects account cardinality |
| `apps/nextjs/src/components/credentials-table/` | New `AccountRow` (expandable), new `UsageCell`, new `ActiveBadge`; existing flat row becomes snapshot detail |

## Risks
| Risk | Mitigation |
|------|-----------|
| Symlink vs regular file semantics diverge across macOS/Linux | Use `fs.realpath` on every event; tolerate both symlink and regular-file deployments |
| Usage data missing for many accounts inflates "unknown" cells | Show a clear "not polled yet" state; trigger on-demand poll only for the visible viewport |
| "Active" reading can race with Claude Code mid-rotation | Debounce 200 ms, show "switching…" when transitions observed within the last 5 seconds |
| Existing table sort logic breaks when row shape changes | Keep existing sort hooks on the account row; defer snapshot-level sorting to the expanded sub-table |
