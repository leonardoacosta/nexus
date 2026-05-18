// NavigationState — shared navigation observable for deep-link routing.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (tasks 1.3, 1.5)
//
// Consumed by RootScene + SessionListScene. APNS taps and `nexus://`
// deep links both flow through `handle(deepLink:)` to push the
// session-detail/attach screen.

import Foundation
import Combine

@MainActor
public final class NavigationState: ObservableObject {
    @Published public var selectedSessionId: String?
    @Published public var attachingSessionId: String?

    public init() {}

    /// `nexus://session/<id>` -> open detail.
    /// `nexus://attach/<id>`  -> open attach scene.
    public func handle(deepLink url: URL) {
        guard url.scheme == "nexus" else { return }
        let parts = url.path.split(separator: "/").map(String.init)
        switch url.host {
        case "session":
            selectedSessionId = parts.first
        case "attach":
            attachingSessionId = parts.first
        default:
            break
        }
    }
}
