# Design · add-swift-menubar

## Why this proposal needs a design doc

A single-shot UI build against an existing API surface would normally be a single batch with no
design doc. This one earns the extra step for two reasons:

1. **Cross-language process boundary** — Swift app shells out to `open -na Ghostty.app …` which
   then shells out to `ssh` which then runs `tmux attach`. Three subprocesses with quoting
   pitfalls. We need to pin the exact invocation contract before implementation.
2. **Reactive state model** — the panel re-renders on SSE events, hotkey presses, and HTTP
   responses. The data flow needs to be locked or we'll end up with race conditions between
   `NexusClient` actor mutations and SwiftUI view updates.

## Reference

The canonical UX surface is `docs/wireframes/nexus-menubar/index.html`. That document is locked
and ahead of this design doc — if anything here conflicts with the wireframe, the wireframe
wins.

## Architectural decisions

### A1. `NexusClient` is an `actor`, not an `ObservableObject`

SwiftUI's natural reactivity model is `ObservableObject` with `@Published` properties. But
`@Published` properties must be mutated on the main thread, and we want to mutate from a
URLSession streaming task that decodes SSE frames as they arrive on a background queue.

**Decision**: `NexusClient` is a Swift `actor` that holds canonical state. It exposes
`async` accessors and `AsyncStream` event publishers. SwiftUI views wrap an
`@Observable` (Swift 5.9 observation framework) shim that mirrors the actor's state, updated
via `Task { await client.subscribe { state in await MainActor.run { self.state = state } } }`.

**Alternative considered**: pure `@MainActor @Observable`. Rejected because SSE decoding on the
main actor would tie up the run-loop on every event.

### A2. Tmux window name resolution

Sessions on homelab are created as tmux *windows* (not sessions) in the default tmux session,
named `<project>-<timestamp>` per `apps/agent/src/routes/sessions.ts:239`. Two approaches:

| Approach | Pro | Con |
| --- | --- | --- |
| **Server returns `tmuxWindow` in `GET /sessions/<id>`** | Single source of truth | Requires agent change |
| **Client reconstructs from `project` + `startedAt`** | Zero agent change | Tight coupling to agent's naming convention |

**Decision**: Start with client-side reconstruction (zero agent change). Add a `tmuxWindow`
field to the session row in a follow-up spec once the menu bar is shipped. Document the
coupling in `TmuxWindowName.swift` so the follow-up is obvious.

### A3. Ghostty launch command

The literal `Process()` invocation is:

```swift
let proc = Process()
proc.executableURL = URL(fileURLWithPath: "/usr/bin/open")
proc.arguments = [
    "-na", "Ghostty.app",
    "--args", "-e",
    "ssh -t nyaptor@homelab tmux attach \\; select-window -t \(windowName)"
]
try proc.run()
```

**Quoting**: the `-e` flag takes a *single* string that Ghostty hands to `/bin/sh -c`. Inside
that, tmux's `\;` separates commands. We need to escape backslash-semicolon for Swift, which
means literal `\\;` in the source string (Swift collapses `\\` to `\` before the string is
passed). Test: `2.1` asserts the exact argv array.

### A4. Notification history: client-side ring buffer

The notification history surface is *only* shown in the menu bar's NOTIFY popover — it doesn't
need to be agent-side. Implementation:

- In-memory `Deque<NotificationEvent>` capped at 50 items.
- Hydrated on launch from `UserDefaults.standard.suite("com.nexus.menubar")`,
  key `nx.menubar.notifications.history`, JSON-encoded.
- Persisted on every mutation (insertion or clear).
- Subscribes to `NotificationFired` SSE events for inserts.

**Alternative considered**: server-side `GET /notifications/history` endpoint. Rejected — adds
an agent endpoint with no other consumers, and the bash listener already doesn't need it.

### A5. Hotkey registration

`RegisterEventHotKey` from `Carbon.framework` is the canonical pre-SwiftUI hotkey API. SwiftUI
doesn't expose a native equivalent yet. Two options:

| Option | Pro | Con |
| --- | --- | --- |
| Direct Carbon API wrapper | Zero dependencies | Boilerplate (~80 LOC) |
| Swift Package: `soffes/HotKey` | Battle-tested, 3 lines of code | One extra SPM dependency |

**Decision**: ship the direct wrapper (`GlobalHotkeyManager.swift`) — boilerplate is contained,
testable, and avoids an SPM dependency for a single feature. Reference implementation: macOS
Catalyst sample code section in `RegisterEventHotKey` documentation.

### A6. Autostart via LaunchAgent (not SMAppService)

macOS 13+ ships `ServiceManagement.SMAppService` which is the modern blessed path for
launch-at-login. But:

- `SMAppService` requires a code-signed app bundle for the registration to stick. We're
  shipping unsigned (developer-mode) for now.
- The bash listener already uses `~/Library/LaunchAgents/com.nexus.*.plist` pattern. Sticking
  with LaunchAgent keeps install/uninstall consistent across the Nexus fleet.

**Decision**: stay on LaunchAgent for v1. Migrate to `SMAppService` when we get a Developer ID
certificate and ship through the App Store (or notarize for distribution).

### A7. Visual effect view is a hand-rolled `NSViewRepresentable`

SwiftUI's `.background(Material.regular)` doesn't expose the `.hudWindow` material at the right
opacity. Wrap `NSVisualEffectView` in a `NSViewRepresentable`. Pattern:

```swift
struct HudBackdrop: NSViewRepresentable {
  func makeNSView(context: Context) -> NSVisualEffectView {
    let v = NSVisualEffectView()
    v.material = .hudWindow
    v.blendingMode = .behindWindow
    v.state = .active
    return v
  }
  func updateNSView(_: NSVisualEffectView, context: Context) {}
}
```

Place at the bottom of the `ZStack` under all panel content.

## State diagram

```
                ┌──────────────────────────────────────────┐
                │  NexusClient (actor)                     │
                │  - peers: [Peer]                         │
                │  - sessions: [Session]                   │
                │  - metrics: HealthHistory                │
                │  - notifications: Deque<NotifEvent>      │
                │  - aggregate: AggregateState (derived)   │
                └──────────────┬───────────────────────────┘
                               │ AsyncStream<NexusUpdate>
                               ▼
                ┌──────────────────────────────────────────┐
                │  NexusViewModel (@Observable, @MainActor)│
                │  Mirrors actor state for SwiftUI         │
                └──────────────┬───────────────────────────┘
                               │ @Environment
                ┌──────────────┴──────────────┐
                ▼                             ▼
        ┌───────────────┐            ┌───────────────────┐
        │  StatusIcon   │            │   NexusPanel      │
        │  (menu bar)   │            │   (popover)       │
        └───────────────┘            └─────────┬─────────┘
                                               │ child views
                                               ▼
                             IdentityRow / AlertStrip / MetricsRow
                             SessionList / ActionRow
```

## Risks

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| Ghostty.app path varies (`/Applications` vs `~/Applications`) | Low | `open -na` uses LaunchServices lookup, not path lookup |
| `RegisterEventHotKey` conflicts with another app | Medium | Default to `⌃⌥N` / `⌃⌥H` (uncommon); Preferences allows rebind |
| SSE reconnect storms on flaky Tailscale | Medium | Exponential backoff (1s → 30s) + jitter |
| User has no Ghostty installed | Low | Surface inline error with App Store CTA (scenario in spec) |
| Tmux window name diverges from agent's convention | Low | Test 2.2 asserts the exact format matches agent's source |
