# Design: projects-tab-accordion-deeplink

## Git Metadata Pipeline

`apps/agent/src/services/git-project.ts` currently extracts
`{ provider, ownerRepo }` via `git remote get-url origin`. The new
`getGitMetadata(cwd)` runs **one** subprocess per cwd to keep latency
bounded:

```bash
git -C $cwd status --porcelain=v2 --branch --untracked-files=no \
  -z \
  && git -C $cwd log -1 --format=%aN%n%aI
```

The two commands are wired with `&&` inside a single `Bun.spawn` shell
because their outputs are concatenated with a stable separator (the
status output's NUL terminator marks the boundary). Parsing is
deterministic on `--porcelain=v2` output:

- `# branch.head <name>` → branch (or `(detached)`)
- `# branch.ab +X -Y` → ahead/behind counters
- Any line starting with `1 ` or `2 ` or `?` → dirty
- Trailing two lines after the status block → last-commit author + ISO timestamp

Cache: `Map<cwd, { value: GitMetadata, expiresAt: number }>`, 30s TTL.
Cache lookup is the first thing `getGitMetadata` does; misses spawn
subprocess with a 2s timeout (uses `AbortController`). On timeout or
non-zero exit, the function resolves to `null` and caches the negative
result for 30s too (avoids hammering a broken repo).

`GET /projects` resolution: after the existing rollup query, the
handler does `Promise.all(projects.map(p => getGitMetadata(p.cwd)))`
and zips the results into each row. Total wall-clock cost is bounded
by the slowest project (typically <300ms on a clean repo).

## Swift Models

`apps/swift/NexusShared/Models/GitMetadata.swift` (new):

```swift
public struct GitMetadata: Codable, Hashable, Sendable {
    public let branch: String?       // nil for detached HEAD
    public let ahead: Int
    public let behind: Int
    public let dirty: Bool
    public let lastCommit: Commit?

    public struct Commit: Codable, Hashable, Sendable {
        public let author: String
        public let ts: Date          // ISO-8601 decode
    }
}
```

`ProjectSummary.swift` gets an optional `gitMetadata: GitMetadata?`. The
optional outer + optional fields-inside lets the wire format degrade
cleanly:
- Old agent (no field) → `nil`
- Non-git project → `nil`
- Detached HEAD → non-nil object with `branch: nil`

## Swift UI Topology

`ProjectsView.swift` rewrites are localized. The current `ProjectRow`
collapses into `ProjectAccordionRow.swift` (new file, kept separate
because it's ~150 lines):

```swift
struct ProjectAccordionRow: View {
    let project: ProjectSummary
    @Binding var isExpanded: Bool
    @EnvironmentObject var coordinator: DashboardNavigationCoordinator
    @State private var sessions: [SessionSummary] = []

    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            // Expanded content: git metadata pane + nested session list
            expandedContent
        } label: {
            // Collapsed header: name + counts + branch chip
            collapsedHeader
        }
        .task(id: project.id) {
            await loadSessions()
        }
    }
}
```

`@AppStorage` for expand state uses a namespaced key:
`"projects-accordion-expanded.\(project.id)"` so a future schema change
can prefix-grep for cleanup. Pruning happens in `ProjectsView.task()`:

```swift
let liveIds = Set(model.projects.map(\.id))
let stored = UserDefaults.standard.dictionaryRepresentation()
for key in stored.keys where key.hasPrefix("projects-accordion-expanded.") {
    let id = String(key.dropFirst("projects-accordion-expanded.".count))
    if !liveIds.contains(id) { UserDefaults.standard.removeObject(forKey: key) }
}
```

## Deep-Link Coordinator

`apps/swift/nexus-mac/Sources/Dashboard/DashboardNavigationCoordinator.swift` (new):

```swift
@MainActor
public final class DashboardNavigationCoordinator: ObservableObject {
    @Published public var pendingDeepLink: DeepLink?
    private var cancellationToken: UUID?

    public func openSession(_ sessionId: String) {
        cancellationToken = UUID()
        pendingDeepLink = .openSession(id: sessionId, token: cancellationToken!)
    }

    public enum DeepLink: Equatable {
        case openSession(id: String, token: UUID)
    }
}
```

`AppNavigation` injects the coordinator as `@EnvironmentObject` and
watches `pendingDeepLink`. On `.openSession`, it sets the active tab
to `.sessions`. `SessionsView.task()` drains the pending link by
calling its own `openSession(id:)` method — same path the existing
tap-to-open uses — then nils out the coordinator's `pendingDeepLink`
to prevent re-firing.

Cancellation: each new deep-link generates a fresh token. The drain
path stores its token, and if a NEW token arrives mid-drain (rapid
double-click), the in-flight PTY mount is told to bail via the
existing PtyViewer cancel API (already shipped in commit eaa1a98).

## Tests

- `git-project.test.ts`: cover branch/ahead/behind/dirty/last-commit
  extraction against fixture repos. Use `git init` + scripted commits
  in `os.tmpdir()` rather than mocks. Each scenario from the spec
  delta has a corresponding test.
- `projects.test.ts`: extend with the 7 spec scenarios. Stub
  `getGitMetadata` to return controlled values so the rollup logic
  is testable without real repos.
- `ProjectsViewTests.swift`: accordion expand/collapse + sticky
  storage + orphan pruning. Mirror `SessionRowTests.swift`.
- `DashboardNavigationCoordinatorTests.swift`: token-based
  cancellation, rapid double-click semantics, unknown-session info
  banner.
- E2E: launch dashboard with seeded projects, click an accordion
  session row, verify tab switches + PTY mounts. Deferred until
  the pre-existing SessionsView mount XCUITest regression is fixed
  (filed as P2 bd-bug during apply-2026-05-21-001).
