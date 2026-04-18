# credential-page-status Specification

## Purpose
Credential page display behavior — agent reachability signals, error states, metadata freshness, and column presentation.
## Requirements
### Requirement: Agent reachability signal in fetchCredentials

The `fetchCredentials()` server action MUST return an `agentReachable: boolean` field and a `failedAgents: string[]` array alongside the existing credential data. `agentReachable` is `true` when at least one agent responded with HTTP 2xx; `false` when all agents failed or timed out. `failedAgents` lists `"<name> (<host>:<port>)"` for each agent that did not respond.

#### Scenario: all agents unreachable
- **Given** all configured agents are offline (connection refused or timeout)
- **When** `fetchCredentials()` is called
- **Then** the result includes `agentReachable: false`, `failedAgents` lists every configured agent, and `groups` is empty

#### Scenario: one agent responds successfully
- **Given** agent "omarchy" at 100.64.0.1:7400 is running and returns 3 credentials
- **And** agent "macbook" at 100.64.0.2:7400 is offline
- **When** `fetchCredentials()` is called
- **Then** the result includes `agentReachable: true`, `agentSource: "omarchy"`, `failedAgents: ["macbook (100.64.0.2:7400)"]`, and `groups` has 3 entries

#### Scenario: agent responds with empty credentials
- **Given** agent "omarchy" is running but the credentials table is empty
- **When** `fetchCredentials()` is called
- **Then** the result includes `agentReachable: true`, `agentSource: "omarchy"`, `failedAgents: []`, and `groups` is empty

---

### Requirement: Distinct error banner for unreachable agents

When `agentReachable` is `false`, the credential page MUST render a warning banner instead of the empty-data message. The banner MUST include the list of agents that failed to respond and a suggestion to check agent status.

#### Scenario: error banner shown when agent is down
- **Given** `fetchCredentials()` returns `agentReachable: false` and `failedAgents: ["omarchy (100.64.0.1:7400)"]`
- **When** the credential page renders
- **Then** a warning banner is displayed containing "Could not reach agent" and "omarchy (100.64.0.1:7400)"
- **And** the credentials table is NOT rendered

#### Scenario: empty state shown when agent responds with no data
- **Given** `fetchCredentials()` returns `agentReachable: true` and `groups: []`
- **When** the credential page renders
- **Then** the page shows "No credentials found" (the existing empty-data message)
- **And** no warning banner is displayed

---

### Requirement: Agent source attribution in page header
When credentials load successfully, the page header MUST display the name of the responding agent (e.g., "via omarchy") next to the **account count** (formerly "account count" referred to file count; now refers to distinct fingerprints).

#### Scenario: header reflects account cardinality
- **Given** `fetchCredentials()` returns 4 snapshot files grouped into 2 accounts
- **When** the page header renders
- **Then** it reads "2 accounts · via omarchy"

### Requirement: MCP provider display format

The MCP providers column MUST display full provider names (e.g., "figma", "slack", "posthog") as small colored pills instead of single-letter abbreviations. Each pill MUST retain the provider-specific color scheme and MUST show the full lowercase name.

#### Scenario: multiple MCP providers displayed as full-name pills
- **Given** a credential has `mcpProviders: "figma,posthog,slack"`
- **When** the credential table renders that row
- **Then** three colored pills appear: "figma" (purple), "posthog" (blue), "slack" (green)

---

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

