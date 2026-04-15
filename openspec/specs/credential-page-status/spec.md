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

When credentials load successfully, the page header MUST display the name of the responding agent (e.g., "via omarchy") next to the account count.

#### Scenario: agent name shown on successful load
- **Given** `fetchCredentials()` returns `agentReachable: true`, `agentSource: "omarchy"`, and 18 credentials
- **When** the credential page renders
- **Then** the header displays "18 accounts" followed by "via omarchy"

---

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
