//
//  IntegrationGateUITests.swift
//  nexusUITests
//
//  Tier B of the full-stack integration gate
//  (openspec/changes/add-fullstack-integration-test-gate, tasks 2.2–2.4).
//
//  Regression guards for the two costliest faults of the five-layer
//  dashboard incident:
//    - fault #4  : SessionsView never mounts → no fetch → empty dashboard
//                  (fixed in eb4bd73 — tasks 2.2 + 2.3).
//    - fault #5-r: ATS -1022 cleartext block on the real built bundle
//                  (fixed in 6d13453 — task 2.4).
//
//  The app is `LSUIElement` (menu-bar only, no Dock window). The
//  dashboard is now a SINGLETON `Window` (was a `WindowGroup` —
//  user-authorized breaking change, bd:nx-68ulr) so
//  `.defaultLaunchBehavior(.presented)` is deterministic: launching with
//  `-uitest-open-dashboard` reliably presents the window at launch,
//  independent of the lazy MenuBarExtra/popover lifecycle. The endpoint
//  override is injected via the UserDefaults argument domain
//  (`-nexus.dashboard.endpoint <url>`), which SettingsStore reads as-is.
//

import XCTest

@MainActor
final class IntegrationGateUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
        // System TCC / "would like access" / "Trust This" dialogs
        // intermittently steal focus and block sidebar clicks. Auto-allow
        // so they don't fail the render guards.
        addUIInterruptionMonitor(withDescription: "system-dialog") { alert in
            for label in ["Allow", "OK", "Always Allow", "Trust"] {
                let b = alert.buttons[label]
                if b.exists { b.click(); return true }
            }
            return false
        }
    }

    // MARK: - Helpers

    private func launchWithDashboard(endpoint: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        // Every flag a well-formed `-key value` pair: macOS NSArgumentDomain
        // pairs each `-key` with the FOLLOWING token, so a bare flag
        // directly before another `-key` swallows it and drops the
        // endpoint override.
        if let endpoint {
            app.launchArguments += ["-nexus.dashboard.endpoint", endpoint]
        }
        app.launchArguments += ["-uitest-open-dashboard", "YES"]
        // Force a clean process every test. The dashboard is a SINGLETON
        // `Window`; `.defaultLaunchBehavior(.presented)` only fires on a
        // FRESH launch, so a persisted prior-test instance (XCUITest does
        // not always terminate LSUIElement apps between tests) would leave
        // the window un-presented and the next test would see "no window".
        app.terminate()
        app.launch()
        return app
    }

    /// The singleton dashboard window (title "Nexus" — AppNavigation
    /// `.navigationTitle`). Presented at launch under the seam above.
    private func dashboardWindow(in app: XCUIApplication) -> XCUIElement {
        app.windows["Nexus"].firstMatch
    }

    /// A sidebar row by section. SwiftUI `List(selection:)` rows on macOS
    /// surface the `.accessibilityIdentifier` on a Button (collapsed
    /// sidebar) or a generic element (outline). Prefer the typed button
    /// query, fall back to any-descendant so the guard isn't brittle to
    /// the row's concrete element type.
    private func sidebarRow(
        _ section: String, in app: XCUIApplication
    ) -> XCUIElement {
        let id = "sidebar-\(section)"
        let asButton = app.buttons[id]
        if asButton.exists { return asButton }
        return app.descendants(matching: .any)
            .matching(identifier: id).firstMatch
    }

    // MARK: - 2.2  Render every DashboardSection (fault #4 guard)

    func testEveryDashboardSectionRenders() throws {
        let app = launchWithDashboard()
        let window = dashboardWindow(in: app)
        XCTAssertTrue(
            window.waitForExistence(timeout: 20),
            "dashboard window never appeared — singleton Window / "
                + ".defaultLaunchBehavior(.presented) regressed"
        )
        app.activate()
        // Tap the window to surface any pending UI-interruption dialog so
        // the monitor (setUp) can dismiss it before we query the sidebar.
        window.tap()

        // Mirror of DashboardSection.allCases (AppNavigation.swift). Kept
        // explicit so adding a section without a render guard fails here.
        let sections = [
            "sessions", "specs", "projects", "credentials", "failures",
            "notifications", "health", "integrations", "settings", "pty",
        ]

        for section in sections {
            let row = sidebarRow(section, in: app)
            XCTAssertTrue(
                row.waitForExistence(timeout: 6),
                "sidebar row missing for section '\(section)'"
            )
            row.click()

            let detail = app.descendants(matching: .any)
                .matching(identifier: "detail-\(section)").firstMatch
            XCTAssertTrue(
                detail.waitForExistence(timeout: 6),
                "detail pane for '\(section)' never mounted after selecting it"
            )
        }

        // Explicit fault #4 assertion: selecting Sessions mounts
        // SessionsView (identifier present ⇒ its .task ran ⇒ a fetch was
        // triggered). This is the precise regression that emptied the
        // dashboard for days.
        sidebarRow("sessions", in: app).click()
        let sessionsView = app.descendants(matching: .any)
            .matching(identifier: "sessions-view").firstMatch
        XCTAssertTrue(
            sessionsView.waitForExistence(timeout: 6),
            "SessionsView never mounted on Sessions selection — fault #4 regressed"
        )
    }

    // MARK: - 2.3  Commands / menu-bar surface reachable

    func testMenuBarSurfaceAndCommandsReachable() throws {
        let app = launchWithDashboard()

        // Process alive (LSUIElement → runningBackground=3/foreground=4).
        let alive = NSPredicate { _, _ in
            let s = app.state.rawValue
            return s == 3 || s == 4
        }
        XCTAssertEqual(
            XCTWaiter.wait(
                for: [XCTNSPredicateExpectation(predicate: alive, object: nil)],
                timeout: 6
            ),
            .completed,
            "app did not stay alive after launch (state=\(app.state.rawValue))"
        )

        // The open-dashboard command path is reachable: the singleton
        // window exists.
        let window = dashboardWindow(in: app)
        XCTAssertTrue(
            window.waitForExistence(timeout: 20),
            "open-dashboard command produced no window"
        )
        app.activate()
        window.tap()

        // Key sidebar commands reachable from the built app.
        for section in ["sessions", "health", "settings", "pty"] {
            let row = sidebarRow(section, in: app)
            XCTAssertTrue(
                row.waitForExistence(timeout: 6),
                "command/section '\(section)' not reachable from built app"
            )
        }
    }

    // MARK: - 2.4  Client transport round-trip (fault #5-runtime / ATS)

    func testClientTransportRoundTripAgainstNonLoopbackStub() throws {
        let stub = try StubAgentProcess.start()
        defer { stub.stop() }

        // Enforced spec scenario: non-loopback or the ATS reproduction is
        // invalid (macOS exempts loopback/`*.local` → false-green -1022).
        XCTAssertFalse(
            StubAgentProcess.isLoopbackish(stub.host),
            "stub bound loopback-ish host \(stub.host) — would false-green ATS"
        )

        let app = launchWithDashboard(endpoint: stub.baseURL)
        let window = dashboardWindow(in: app)
        XCTAssertTrue(
            window.waitForExistence(timeout: 20),
            "dashboard window never appeared"
        )
        app.activate()
        window.tap()

        let sessionsRow = sidebarRow("sessions", in: app)
        XCTAssertTrue(sessionsRow.waitForExistence(timeout: 6))
        sessionsRow.click()

        // The deterministic fixture row id is "stub-sess-1". Its
        // appearance proves: the cleartext fetch to the non-loopback stub
        // completed WITHOUT ATS -1022, the payload decoded, and the
        // dashboard rendered it. The client path sends
        // `?withFingerprint=true`, for which the stub serves fresh
        // timestamps so the 300s activeSessions freshness filter keeps
        // the row. If ATS were still broken this row never appears (the
        // exact 6d13453 fault).
        let fixtureRow = app.descendants(matching: .any)
            .matching(identifier: "session-row-stub-sess-1").firstMatch
        XCTAssertTrue(
            fixtureRow.waitForExistence(timeout: 25),
            "stub fixture session never rendered — client transport "
                + "(ATS -1022 / decode / mount) regressed against the "
                + "non-loopback stub at \(stub.baseURL)"
        )
    }
}

// MARK: - Stub-agent subprocess wrapper

/// Resolves a NON-loopback stub-agent base URL for the client-transport
/// round-trip. Two modes:
///
///  1. Harness-provided (PREFERRED, required under the sandboxed XCUITest
///     runner): the test harness — the pre-push gate / `run-uitests.sh`
///     wrapper — starts `apps/agent/src/testing/stub-agent.ts` OUTSIDE
///     the sandbox and exports `NX_STUB_BASE_URL`. `xcodebuild test`
///     propagates the launching env to the test bundle. This is
///     load-bearing: `nexus-mac-UITests-Runner.app` is sandboxed with
///     only `network.client` (no `network.server`), so a stub spawned
///     BY the test cannot bind a listening socket (EADDRINUSE on every
///     bind, loopback or not). The non-loopback requirement (loopback
///     would false-green ATS) is satisfied by the harness's bind.
///  2. Self-spawn fallback for non-sandboxed contexts (running the test
///     directly from a non-sandboxed host): spawns the Bun CLI
///     entrypoint and parses its `STUB_BASE_URL=` line.
private struct StubAgentProcess {
    let process: Process?
    let baseURL: String
    let host: String

    static func isLoopbackish(_ host: String) -> Bool {
        let h = host.lowercased()
        return h == "127.0.0.1" || h == "localhost" || h == "::1"
            || h.hasPrefix("127.") || h.hasSuffix(".local")
    }

    /// Resolve the repo root from this file's location (CWD-independent).
    private static func repoRoot() throws -> URL {
        // .../apps/swift/nexus/nexusUITests/IntegrationGateUITests.swift
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { url.deleteLastPathComponent() } // → repo root
        return url
    }

    static func start() throws -> StubAgentProcess {
        // Mode 1: harness-provided URL (sandbox-safe, the gate path).
        if let injected = ProcessInfo.processInfo
            .environment["NX_STUB_BASE_URL"]?
            .trimmingCharacters(in: .whitespacesAndNewlines),
           !injected.isEmpty,
           let comps = URLComponents(string: injected),
           let h = comps.host {
            return StubAgentProcess(process: nil, baseURL: injected, host: h)
        }

        // Mode 2: self-spawn fallback (non-sandboxed contexts only).
        let root = try repoRoot()
        let stubPath = root
            .appendingPathComponent("apps/agent/src/testing/stub-agent.ts")
            .path
        guard FileManager.default.fileExists(atPath: stubPath) else {
            throw XCTSkip("stub-agent.ts not found at \(stubPath)")
        }

        // The XCUITest runner has a stripped PATH (no /opt/homebrew/bin),
        // so `/usr/bin/env bun` fails to resolve. Invoke bun by absolute
        // path directly and give the child a PATH so its own toolchain
        // resolves.
        guard let bun = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"]
            .first(where: { FileManager.default.isExecutableFile(atPath: $0) })
        else {
            throw XCTSkip("bun not found at /opt/homebrew/bin or /usr/local/bin")
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: bun)
        proc.arguments = [stubPath]
        proc.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        proc.environment = env
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError = errPipe
        try proc.run()

        let deadline = Date().addingTimeInterval(15)
        var buffer = Data()
        var baseURL: String?
        let handle = outPipe.fileHandleForReading
        while Date() < deadline {
            let chunk = handle.availableData
            if chunk.isEmpty {
                if !proc.isRunning { break } // crashed early
                Thread.sleep(forTimeInterval: 0.1)
                continue
            }
            buffer.append(chunk)
            if let text = String(data: buffer, encoding: .utf8),
               let line = text.split(separator: "\n")
                   .first(where: { $0.hasPrefix("STUB_BASE_URL=") }) {
                baseURL = String(line.dropFirst("STUB_BASE_URL=".count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                break
            }
        }

        guard let url = baseURL,
              let parsed = URLComponents(string: url),
              let h = parsed.host else {
            let errData = errPipe.fileHandleForReading.availableData
            let errText = String(data: errData, encoding: .utf8) ?? ""
            proc.terminate()
            throw XCTSkip(
                "stub-agent did not announce STUB_BASE_URL within 15s. "
                    + "stdout=[\(String(data: buffer, encoding: .utf8) ?? "")] "
                    + "stderr=[\(errText)] running=\(proc.isRunning)"
            )
        }

        return StubAgentProcess(process: proc, baseURL: url, host: h)
    }

    func stop() {
        // No-op in harness mode (process == nil) — the harness owns the
        // stub's lifecycle and tears it down after xcodebuild returns.
        process?.terminate()
    }
}
