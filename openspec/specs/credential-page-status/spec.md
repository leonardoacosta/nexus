# credential-page-status Specification

## Purpose
Credential page display behavior — agent reachability signals, error states, metadata freshness, and column presentation.
## Requirements
### Requirement: Agent reachability signal in fetchCredentials

`NexusAggregateClient.fetchCredentials()` MUST capture the `reachable: [String]` array
`fanOut()` already returns (mirroring `fetchSessions()`'s existing
`self.lastReachable = reachable` pattern) and expose it alongside `profiles`, so callers can
distinguish "no agent reachable" from "agent reachable, zero credentials". This requirement
previously described a Next.js "server action" (`fetchCredentials()` returning
`agentReachable`/`failedAgents`/`agentSource` fields) — nx has no such web page; the real
implementation is the native macOS SwiftUI `CredentialsView` and its `NexusAggregateClient`.

#### Scenario: All agents unreachable
- **Given** every configured agent is offline (connection refused or timeout)
- **When** `fetchCredentials()` is called
- **Then** the resulting reachable-agents signal is empty and `profiles` is empty

#### Scenario: One agent responds successfully
- **Given** agent "omarchy" is running and returns 3 credentials, agent "macbook" is offline
- **When** `fetchCredentials()` is called
- **Then** the reachable-agents signal contains `"omarchy"` but not `"macbook"`, and `profiles` has 3 entries

### Requirement: Distinct error banner for unreachable agents

`CredentialsView` MUST render a distinct warning banner (not the generic empty-data
`ContentUnavailableView`) when zero agents are reachable, listing which agents failed to
respond. The banner MUST NOT render when at least one agent is reachable but returned zero
credentials — that case keeps the existing empty-data message.

#### Scenario: Warning banner shown when no agent is reachable
- **Given** `CredentialsViewModel.load()` resolves with zero reachable agents
- **When** `CredentialsView` renders
- **Then** a warning banner is displayed distinct from the empty-data `ContentUnavailableView`, naming the unreachable agent(s)
- **And** the credentials table is not rendered

#### Scenario: Empty-data message shown when an agent is reachable but returns no credentials
- **Given** `CredentialsViewModel.load()` resolves with at least one reachable agent and zero profiles
- **When** `CredentialsView` renders
- **Then** the existing empty-data `ContentUnavailableView` is shown, not the warning banner

### Requirement: Agent source attribution in page header

When credentials load successfully, `CredentialsView`'s header MUST display "via <agent-name>"
next to the row/account count, naming the (or one of the) reachable agent(s) that supplied the
data.

#### Scenario: Header shows source attribution
- **Given** credentials loaded successfully from agent "omarchy"
- **When** the header renders
- **Then** it includes "via omarchy" alongside the existing count text

### Requirement: MCP provider display format

`CcProfile` MUST decode the server's `mcpProviders` field (comma-joined full provider names,
e.g. `"figma,posthog,slack"`), and `CredentialsView`'s row rendering MUST display each provider
as a small colored pill showing the full lowercase name, reusing the existing inline
pill-rendering recipe already used for the ACTIVE/duplicates badges in the same file.

#### Scenario: Multiple MCP providers render as full-name pills
- **Given** a credential has `mcpProviders: "figma,posthog,slack"`
- **When** the credential row renders
- **Then** three colored pills appear reading "figma", "posthog", "slack"

#### Scenario: No MCP providers renders no pills
- **Given** a credential has `mcpProviders: nil` or an empty string
- **When** the credential row renders
- **Then** no MCP pill row appears for that credential

### Requirement: Rate limits column hidden

The credential table MUST NOT render the `rateLimitCount` column or its sort header until the interception pipeline populates it with real data.

#### Scenario: rate limits column absent from table
- **Given** the credential table renders with any set of credentials
- **When** the user views the table headers
- **Then** there is no "Rate Limits" column header and no rate limit values in any row

---

### Requirement: Credential metadata refresh on agent startup

On startup, the agent MUST re-read all `acct-*.json` files from `~/.config/nexus/credentials/`, compute the fingerprint for each, and update `expiresAt`, `subscriptionType`, `rateLimitTier`, and `mcpProviders` in the database for every credential row whose fingerprint matches.

#### Scenario: stale expiresAt refreshed on startup
- **Given** credential file `acct-abc.json` has a refreshed access token expiring in 2 hours
- **And** the DB row with the same fingerprint has `expiresAt` set to 11 days ago
- **When** the agent starts and calls `refreshMetadata()`
- **Then** the DB row's `expiresAt` is updated to the new 2-hour expiry timestamp

### Requirement: Accounts are the top-level row
The credentials page MUST render one row per account, where an account is defined by a unique OAuth refresh-token fingerprint. Each account row MUST be expandable to show the underlying snapshot files (duplicate group members). The page header account count MUST reflect account cardinality, not file cardinality.

#### Scenario: two accounts with three snapshot files total
- **Given** the pool contains fingerprint `FP1` (files `acct-a.json`, `acct-a-backup.json`) and fingerprint `FP2` (file `acct-b.json`)
- **When** the credentials page renders
- **Then** exactly 2 rows are visible at the top level and the header shows "2 accounts"
- **And** expanding the `FP1` row reveals both snapshot files, newest-mtime first

#### Scenario: single-file account renders without expansion affordance
- **Given** fingerprint `FP2` has exactly one snapshot file
- **When** the account row renders
- **Then** no expand control is shown; the row is flat

---

### Requirement: Usage limits rendered per account
Each account row MUST display 5-hour usage percent and reset timestamp. When usage data has not yet been polled for that account, a "not polled yet" fallback MUST be shown instead of blank or zero.

#### Scenario: usage polled for primary credential
- **Given** `GET /credentials/{id}/usage?window=5h` returns `{ percent: 62, resetsAt: "2026-04-17T15:00:00Z" }` for primary of `FP1`
- **When** the account row renders
- **Then** the usage cell shows "62%" and a relative reset time ("in 42 min")

#### Scenario: usage unpolled for new account
- **Given** fingerprint `FP3` was added 10 seconds ago and no usage poll has completed
- **When** the account row renders
- **Then** the usage cell shows "not polled yet" with a spinner affordance

---

### Requirement: Active-account indicator
Exactly one account (or zero, when `~/.claude/.credentials.json` is absent) MUST be marked as active for Claude Code, based on the `activeFingerprint` field returned by the agent. The indicator MUST be a distinct visual badge visible without expanding the row.

#### Scenario: account matching activeFingerprint is badged
- **Given** the agent response includes `activeFingerprint: "FP1"`
- **When** the page renders
- **Then** the `FP1` account row displays an "Active" badge and no other row does

#### Scenario: no active credential resolved
- **Given** `~/.claude/.credentials.json` does not exist and the agent returns `activeFingerprint: null`
- **When** the page renders
- **Then** no account row shows an active badge and a header hint reads "no active credential detected"

#### Scenario: active fingerprint not present in the pool
- **Given** `activeFingerprint: "FPX"` but no pool row has fingerprint `FPX`
- **When** the page renders
- **Then** no account row is badged and a warning chip reads "active credential not managed by Nexus"

---

