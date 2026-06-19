// NavigationState — shared navigation observable for deep-link routing.
//
// Spec: openspec/changes/ios-session-navigation (UI 2.1)
//
// Consumed by RootScene. APNS taps and `nexus://` deep links both flow
// through `handle(deepLink:)`, which appends the session id to `sessionPath`
// — the value-typed path that drives the Sessions-tab NavigationStack push
// into AttachScene (live PTY). There is no longer a modal sheet: the session
// view is PUSHED, so navigation is a plain `[String]` path of session ids.

import Foundation
import Combine

@MainActor
public final class NavigationState: ObservableObject {
    /// Value-typed navigation path for the Sessions-tab `NavigationStack`. Each
    /// element is a session id; appending one pushes `AttachScene(sessionId:)`
    /// via `.navigationDestination(for: String.self)`. Replaces the old
    /// `attachingSessionId` / `selectedSessionId` sheet bindings + `SessionIdBox`.
    @Published public var sessionPath: [String] = []

    /// Selected TabView tab. Cross-tab deep links (a Notifications-tab Attach
    /// button, an APNS tap) MUST select the Sessions tab before appending to
    /// `sessionPath`, because `.navigationDestination` lives only on the
    /// Sessions stack.
    @Published public var selectedTab: RootTab = .sessions

    public init() {}

    /// `nexus://session/<id>` and `nexus://attach/<id>` both push the live
    /// session view: select the Sessions tab, then append `<id>` to the path.
    public func handle(deepLink url: URL) {
        guard url.scheme == "nexus" else { return }
        let parts = url.path.split(separator: "/").map(String.init)
        switch url.host {
        case "session", "attach":
            guard let id = parts.first else { return }
            selectedTab = .sessions
            sessionPath.append(id)
        default:
            break
        }
    }
}

/// TabView tab identity. Drives the `selection:` binding so cross-tab deep
/// links can switch to the Sessions tab before the push resolves.
public enum RootTab: Hashable {
    case sources
    case comms
    case calendar
    case finance
    case health
    case meds
    case sessions
    case notifications
}
