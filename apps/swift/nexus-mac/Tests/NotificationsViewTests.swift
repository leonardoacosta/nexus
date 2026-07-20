// NotificationsViewTests — persistStatus error surfacing on a failed PATCH.
//
// Spec: openspec/changes/sync-notification-settings-round-trip (task 3.4,
// bd:nx-xzywt)
//
// NotificationsViewModel.persist() PATCHes /notifications/settings and inspects
// the result: `flash(result == nil ? "Save failed" : "Saved")`. The prior code
// unconditionally flashed "Saved", masking every 400/transport failure. This
// asserts the error branch: a PATCH that can't reach the agent leaves
// persistStatus == "Save failed".
//
// The view model wires its own private NexusClient() (no injection seam), which
// resolves its endpoint from SettingsStore.shared.dashboardEndpoint. We point
// that at an unreachable loopback port so the PATCH fails deterministically —
// independent of whether a real agent is listening on :7400 on the test host.
// Port 1 (tcpmux) refuses connections instantly, so the failure returns fast
// (same reachability trick as CredentialsViewTests / TTSObserverTests).

import XCTest
@testable import nexus
@testable import NexusShared

@MainActor
final class NotificationsViewTests: XCTestCase {

    /// Saved+restored around each test so mutating the shared endpoint never
    /// leaks into a neighbouring test's environment.
    private var savedEndpoint: String?

    override func setUp() {
        super.setUp()
        savedEndpoint = SettingsStore.shared.dashboardEndpoint
    }

    override func tearDown() {
        SettingsStore.shared.dashboardEndpoint = savedEndpoint
        super.tearDown()
    }

    // MARK: - [3.4] failed PATCH surfaces "Save failed"

    func testPersistShowsSaveFailedWhenPatchFails() async {
        // Force every settings PATCH to an unreachable endpoint → connection
        // refused → patchNotificationSettings returns nil → "Save failed".
        SettingsStore.shared.dashboardEndpoint = "http://127.0.0.1:1/"

        let model = NotificationsViewModel()
        XCTAssertNil(model.persistStatus, "no status before a save is attempted")

        model.persist()

        // persist() runs the PATCH on a detached Task, then flashes the status
        // on the main actor. Poll until it flips (flash holds it ~1.5s before
        // clearing to nil). The refused connection resolves near-instantly.
        let deadline = Date().addingTimeInterval(5.0)
        while model.persistStatus == nil, Date() < deadline {
            try? await Task.sleep(nanoseconds: 20_000_000) // 20ms
        }

        XCTAssertEqual(model.persistStatus, "Save failed",
                       "a PATCH that never reaches the agent must surface the error state")
    }

    // MARK: - [3.4] transport branch inputs (underpins the ?: in flash)

    /// The `result == nil ? "Save failed" : "Saved"` branch is only correct if
    /// patchNotificationSettings actually returns nil on an unreachable agent
    /// (drives the error branch) and non-nil on a reachable one (drives the
    /// success branch). Pin both transport outcomes so the view-model branch
    /// can't silently invert.
    func testPatchReturnsNilOnUnreachableAndDataOnReachable() async {
        let unreachable = NexusShared.NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://127.0.0.1:1/")!)
        )
        let failResult = await unreachable.patchNotificationSettings(["signal_only": true])
        XCTAssertNil(failResult, "unreachable agent → nil → view model flashes Save failed")

        let reachable = NexusShared.NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://agent.test/")!),
            protocolClasses: [OkURLProtocol.self]
        )
        let okResult = await reachable.patchNotificationSettings(["signal_only": true])
        XCTAssertNotNil(okResult, "reachable agent → non-nil body → view model flashes Saved")
    }
}

/// Minimal in-process stub answering 200 `{}` — sandbox-safe, injected via the
/// NexusClient `protocolClasses` seam to represent a REACHABLE agent.
private final class OkURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let resp = HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
