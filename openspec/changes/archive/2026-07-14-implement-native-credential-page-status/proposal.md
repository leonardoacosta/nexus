---
status: draft
---

# Proposal: Implement native credential-page status behaviors (nx-ndsuv/ufde, nx-sb6gj/t6sw, nx-6ci0x/yad4)

## Change ID
`implement-native-credential-page-status`

## Summary
Correct the `credential-page-status` capability spec — which was authored against a Next.js
"server action" web page that does not exist in nx — to describe the real native macOS SwiftUI
`CredentialsView`, and implement the 3 behaviors it currently documents as satisfied but aren't:
an agent-unreachable warning banner, "via <agent-name>" header attribution, and MCP full-name
provider pills.

## Context
- Extends: `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift`,
  `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`,
  `apps/swift/NexusShared/Models/CcProfile.swift`
- Related: `close-credential-page-e2e-debt` (archived 2026-07-14) — added "E2E-verified"
  scenarios to this capability's requirements assuming a Playwright-testable web page; a
  follow-up XCTest-authoring pass discovered the underlying behaviors were never implemented
  natively at all (this is a bigger gap than a wrong test harness)
- touches: `apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift`, `apps/swift/NexusShared/Networking/NexusAggregateClient.swift`, `apps/swift/NexusShared/Models/CcProfile.swift`, `apps/swift/nexus-mac/Tests/CredentialsViewTests.swift`

## Motivation
`credential-page-status`'s spec text describes a `fetchCredentials()` "server action" returning
`agentReachable`/`failedAgents`/`agentSource` fields, and a page that renders a warning banner,
header attribution, and MCP pills from them. nx has no such web page or server action — the real
implementation is `CredentialsView.swift` (SwiftUI, macOS menubar dashboard). Investigation
confirmed (grep across `apps/swift/`): zero occurrences of `agentReachable`, `failedAgents`, or
`mcpProviders` anywhere in the Swift codebase. `CredentialsViewModel.load()` conflates "no agent
reachable" with "agent reachable, zero rows" into one generic empty state (`lastError` string),
with no per-agent banner. The page header shows only a row count, no source attribution. The
credential table renders no MCP-provider pills at all. The spec's scenarios describe intent that
was never built for this platform — this proposal closes that gap for real, in native terms.

Good news on scope: `fanOut()` (`NexusAggregateClient.swift:155-181`) already returns a
`reachable: [String]` signal that `fetchCredentials()` discards (`fetchSessions()` already
captures the identical signal as `reachableAgentNames` — same one-line pattern applies). Server-
side, `mcpProviders` already exists as a comma-joined full-name string
(`apps/agent/src/credentials/credentials.helpers.ts` `extractCredentialMetadata`) and already
rides through `GET /credentials`'s response — it's simply missing from `CcProfile`'s Codable
fields. No agent-side work is needed for MCP pills, only a client-side model field.

## Requirements

### Requirement: Agent reachability signal in fetchCredentials
`NexusAggregateClient.fetchCredentials()` MUST capture the `reachable: [String]` array `fanOut()`
already returns (mirroring `fetchSessions()`'s existing `self.lastReachable = reachable`
pattern) and expose it alongside `profiles`, so callers can distinguish "no agent reachable" from
"agent reachable, zero credentials".

#### Scenario: All agents unreachable
- **Given** every configured agent is offline (connection refused or timeout)
- **When** `fetchCredentials()` is called
- **Then** the resulting reachable-agents signal is empty and `profiles` is empty

#### Scenario: One agent responds successfully
- **Given** agent "omarchy" is running and returns 3 credentials, agent "macbook" is offline
- **When** `fetchCredentials()` is called
- **Then** the reachable-agents signal contains `"omarchy"` but not `"macbook"`, and `profiles` has 3 entries

### Requirement: Distinct warning banner for unreachable agents
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
When credentials load successfully, `CredentialsView`'s header MUST display "via
<agent-name>" next to the row/account count, naming the (or one of the) reachable agent(s) that
supplied the data.

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

## Scope
- **IN**: `NexusAggregateClient.fetchCredentials()` reachability capture, `CredentialsViewModel`
  distinguishing no-agent-reachable from empty-data, the warning banner view, header source
  attribution, `CcProfile.mcpProviders` field + pill rendering
- **OUT**: any change to the agent-side `/credentials` response shape (mcpProviders already
  ships correctly); a shared reusable Pill/Badge/Chip component extraction (out of scope per
  Reader Gate — mirror the existing inline recipe, don't refactor it into a new shared component
  unless a 3rd call site emerges); rate-limit column changes (separate, already-hidden
  requirement, untouched)

## Testing
| Affected seam | Unit task | E2E task |
|----------------|-----------|----------|
| `fetchCredentials()` reachability capture | [4.1] unit test: reachable-agent signal populated | N/A |
| Warning banner vs empty-data distinction | [4.2] XCTest: banner shown only when zero agents reachable | N/A — native app, no Playwright harness |
| Header source attribution | [4.3] XCTest: header includes "via <agent>" | N/A |
| MCP pill rendering | [4.4] XCTest: pills render per provider, none when absent | N/A |

## Impact
| Area | Change |
|------|--------|
| `NexusAggregateClient.swift` | +1 line capturing `reachable` in `fetchCredentials()`, +exposed property |
| `CredentialsViewModel` (in `CredentialsView.swift`) | distinguish no-reachable-agent from empty-data in `load()` |
| `CredentialsView.swift` | +warning banner view, +header attribution text, +MCP pill row |
| `CcProfile.swift` | +`mcpProviders: String?` field + CodingKey |
| `CredentialsViewTests.swift` | +4 test cases |

## Risks
| Risk | Mitigation |
|------|-----------|
| Ambiguity in "which agent" gets attributed when multiple are reachable | Use the same source-of-truth `fetchCredentials()` already establishes for `profiles` (first/primary reachable agent), consistent with `fetchSessions()`'s existing convention |
| No existing shared pill component — risk of drifting styling | Explicitly scoped to reuse the existing inline recipe (lines 121-143 of CredentialsView.swift), not invent new styling |
