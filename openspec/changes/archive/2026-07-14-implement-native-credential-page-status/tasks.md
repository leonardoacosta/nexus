<!-- beads:epic:nx-auq37 -->
<!-- beads:feature:nx-tv3oc -->

# Implementation Tasks

## API Batch

- [x] [2.1] `NexusAggregateClient.fetchCredentials()`: capture the `reachable: [String]` array from `fanOut()` (currently discarded via `let (perAgent, _) = await fanOut(...)`) and expose it, mirroring `fetchSessions()`'s existing `self.lastReachable = reachable` pattern [owner:swift-engineer] [type:api] [beads:nx-9xecw]
- [x] [2.2] Add `mcpProviders: String?` field + CodingKey to `CcProfile` (apps/swift/NexusShared/Models/CcProfile.swift) — server already sends this comma-joined full-name string via `GET /credentials`, no agent-side change needed [owner:swift-engineer] [type:api] [beads:nx-maemn]

## UI Batch

- [x] [3.1] `CredentialsViewModel.load()`: distinguish "zero agents reachable" from "agent reachable, zero rows" using the new reachability signal, instead of the current single generic `lastError` string [owner:swift-engineer] [type:ui] [beads:nx-w28ae]
- [x] [3.2] Add a distinct warning banner to `CredentialsView` (modeled on `SessionsView.swift`'s `unknownSessionBannerView` banner-under-header pattern, warning-tinted per `ElevenLabsStatusChip`'s `.keyInvalid` case) shown only when zero agents are reachable; credentials table not rendered in that state [owner:swift-engineer] [type:ui] [beads:nx-6q4dt]
- [x] [3.3] Add "via <agent-name>" source attribution text to `CredentialsView`'s header, next to the existing row/account count [owner:swift-engineer] [type:ui] [beads:nx-dc63l]
- [x] [3.4] Render MCP provider pills per credential row in `CredentialsView`, reusing the existing inline pill recipe (lines ~121-143: `Text` + horizontal/vertical padding + `.background(color.opacity(0.18))` + `.cornerRadius(3)`) — one pill per provider, full lowercase name, no row when `mcpProviders` is nil/empty [owner:swift-engineer] [type:ui] [beads:nx-7kll2]

## E2E Batch

- [x] [4.1] XCTest: `fetchCredentials()`'s reachable-agent signal is populated correctly (all-unreachable, one-reachable-one-not cases) [owner:swift-engineer] [type:testing] [beads:nx-6wf79]
- [x] [4.2] XCTest: warning banner renders only when zero agents reachable; empty-data message (not the banner) renders when an agent is reachable but returns zero credentials [owner:swift-engineer] [type:testing] [beads:nx-9eeoq]
- [x] [4.3] XCTest: header includes "via <agent-name>" after a successful load [owner:swift-engineer] [type:testing] [beads:nx-rpad8]
- [x] [4.4] XCTest: MCP pills render one per provider for a multi-provider credential; zero pills render when `mcpProviders` is nil/empty [owner:swift-engineer] [type:testing] [beads:nx-xh3sh]
