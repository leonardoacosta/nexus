## MODIFIED Requirements

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
