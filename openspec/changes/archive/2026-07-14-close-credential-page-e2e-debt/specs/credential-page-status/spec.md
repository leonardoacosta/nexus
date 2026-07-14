## MODIFIED Requirements

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

#### Scenario: E2E-verified warning banner against a stopped agent (nx-ufde)
- **Given** the nexus-agent process is stopped
- **When** the credential page is loaded via Playwright against the live (agent-down) environment
- **Then** the warning banner renders with the "Could not reach agent" text
- **And** the credentials table is NOT rendered

### Requirement: Agent source attribution in page header

When credentials load successfully, the page header MUST display the name of the responding agent (e.g., "via omarchy") next to the **account count** (formerly "account count" referred to file count; now refers to distinct fingerprints).

#### Scenario: header reflects account cardinality
- **Given** `fetchCredentials()` returns 4 snapshot files grouped into 2 accounts
- **When** the page header renders
- **Then** it reads "2 accounts · via omarchy"

#### Scenario: E2E-verified source attribution against a running agent (nx-t6sw)
- **Given** the nexus-agent process is running and reachable
- **When** the credential page is loaded via Playwright
- **Then** the page header displays "via <agent-name>" matching the responding agent's configured name

### Requirement: MCP provider display format

The MCP providers column MUST display full provider names (e.g., "figma", "slack", "posthog") as small colored pills instead of single-letter abbreviations. Each pill MUST retain the provider-specific color scheme and MUST show the full lowercase name.

#### Scenario: multiple MCP providers displayed as full-name pills
- **Given** a credential has `mcpProviders: "figma,posthog,slack"`
- **When** the credential table renders that row
- **Then** three colored pills appear: "figma" (purple), "posthog" (blue), "slack" (green)

#### Scenario: E2E-verified MCP pill rendering (nx-yad4)
- **Given** a live credential row with `mcpProviders: "figma,posthog,slack"` is present
- **When** the credential page is loaded via Playwright
- **Then** three full-name colored pills render for that row, matching the unit-level scenario above
