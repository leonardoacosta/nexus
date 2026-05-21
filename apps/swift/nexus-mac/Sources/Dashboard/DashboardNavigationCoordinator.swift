// DashboardNavigationCoordinator — cross-tab deep-link routing.
//
// Spec: openspec/changes/projects-tab-accordion-deeplink (task 2.1)
//
// A single ObservableObject injected into the AppNavigation environment
// that owns the in-flight deep link. Producers (ProjectAccordionRow,
// future spec tabs) call `openSession(_:)`; consumers (AppNavigation
// + SessionsView) observe `pendingDeepLink` and drain it.
//
// Cancellation semantics: each `openSession` mints a fresh `UUID`. The
// consumer captures the token at drain time; if a NEW token replaces
// `pendingDeepLink` mid-mount the consumer can detect the mismatch and
// bail. Rapid double-click → second link wins; first link's PtyViewer
// mount is cancelled via the viewer's existing cancel API.
//
// `pendingDeepLink` is published; consumers MUST nil it after drain to
// prevent re-firing on view reappear.

import Foundation
import Combine

@MainActor
public final class DashboardNavigationCoordinator: ObservableObject {

    public enum DeepLink: Equatable {
        /// Open the named session in the Sessions tab right pane. The
        /// `token` is opaque — consumers compare by identity to detect
        /// a newer link arriving mid-mount.
        case openSession(id: String, token: UUID)

        public var token: UUID {
            switch self {
            case .openSession(_, let t): return t
            }
        }
    }

    @Published public private(set) var pendingDeepLink: DeepLink?

    public init() {}

    /// Producer API. Mints a new token, atomically replaces any prior
    /// pending link. Returns the token so the caller can correlate
    /// (currently unused — callers prefer fire-and-forget).
    @discardableResult
    public func openSession(_ sessionId: String) -> UUID {
        let token = UUID()
        pendingDeepLink = .openSession(id: sessionId, token: token)
        return token
    }

    /// Consumer API — call AFTER successfully draining a link so a
    /// re-render of the consumer view doesn't refire the same link.
    public func clear() {
        pendingDeepLink = nil
    }
}
