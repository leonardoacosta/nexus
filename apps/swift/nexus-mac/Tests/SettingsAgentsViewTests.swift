// SettingsAgentsViewTests — list rendering, add/edit/delete round-trip,
// invalid-endpoint rejection, AgentsConfigChanged post on save, raw-TOML
// fallback engagement on parse error.
//
// Spec: openspec/changes/settings-tab-redesign (task 2.13, bd:nx-anqxo)

import XCTest
@testable import nexus
@testable import NexusShared

@MainActor
final class SettingsAgentsViewTests: XCTestCase {
    private var tmpDir: URL!
    private var tmpFile: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nexus-settings-agents-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(
            at: tmpDir, withIntermediateDirectories: true
        )
        tmpFile = tmpDir.appendingPathComponent("agents.toml")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    func testListRendersExistingEntries() throws {
        let seed = [
            AgentEntry(name: "homelab", host: "10.0.0.1", port: 7400, user: "leo"),
            AgentEntry(name: "macbook", host: "10.0.0.2", port: 7400, user: nil)
        ]
        try AgentsConfigStore.write(seed, path: tmpFile)
        let model = SettingsAgentsViewModel(path: tmpFile)
        XCTAssertEqual(model.entries.count, 2)
        XCTAssertEqual(model.entries[0].name, "homelab")
        XCTAssertFalse(model.inRawMode)
    }

    func testAddEditDeleteRoundTrip() throws {
        let model = SettingsAgentsViewModel(path: tmpFile)
        model.addRow()
        XCTAssertEqual(model.entries.count, 1)
        model.entries[0].name = "remote"
        model.entries[0].host = "10.9.9.9"
        model.entries[0].port = 7400
        XCTAssertTrue(model.allValid)
        model.save()

        // Disk reflects the new row.
        let reloaded = try AgentsConfigStore.read(path: tmpFile)
        XCTAssertEqual(reloaded.count, 1)
        XCTAssertEqual(reloaded[0].name, "remote")
        XCTAssertEqual(reloaded[0].host, "10.9.9.9")

        // Delete the row + save → disk goes empty.
        let id = model.entries[0].id
        model.deleteRow(id: id)
        XCTAssertTrue(model.entries.isEmpty)
        model.save()
        let after = try AgentsConfigStore.read(path: tmpFile)
        XCTAssertTrue(after.isEmpty)
    }

    func testInvalidEndpointRefused() {
        let model = SettingsAgentsViewModel(path: tmpFile)
        model.addRow()
        model.entries[0].name = "x"
        model.entries[0].host = ""              // invalid
        model.entries[0].port = 7400
        XCTAssertFalse(model.allValid, "row with empty host must fail validation")
        let errors = model.validate(model.entries[0])
        XCTAssertTrue(
            errors.contains(where: { $0.field == .host }),
            "empty host must surface a .host validation error"
        )
        // Save is gated on `allValid` — any single field error blocks the
        // write. The .endpoint synthetic-URL check is a belt-and-suspenders
        // signal; per-platform URL parsing differs (macOS 26+ accepts
        // `http://:7400`), so we don't require BOTH .host AND .endpoint
        // here, only that validation refuses the row.
    }

    func testInvalidHostStringRefused() {
        let model = SettingsAgentsViewModel(path: tmpFile)
        model.addRow()
        model.entries[0].name = "x"
        // "not-a-url" is non-empty but synthesised endpoint
        // (http://not-a-url:7400) is malformed → URL parses but with
        // host == "not-a-url"; the synthesised URL is still well-formed.
        // For the agents.toml schema we accept any non-empty host string
        // because Tailscale names are not URLs; the per-row "endpoint"
        // column is informational. So a real refusal case for the spec
        // scenario uses a port out of range.
        model.entries[0].host = "10.0.0.1"
        model.entries[0].port = -1
        XCTAssertFalse(model.allValid)
    }

    func testAgentsConfigChangedNotificationPostedOnSave() throws {
        let model = SettingsAgentsViewModel(path: tmpFile)
        model.addRow()
        model.entries[0].name = "p"
        model.entries[0].host = "10.0.0.1"
        model.entries[0].port = 7400

        let received = expectation(description: "AgentsConfigChanged fired")
        let token = NotificationCenter.default.addObserver(
            forName: .agentsConfigChanged,
            object: nil,
            queue: nil
        ) { _ in
            received.fulfill()
        }
        defer { NotificationCenter.default.removeObserver(token) }

        model.save()
        wait(for: [received], timeout: 1.0)
    }

    func testRawFallbackActivatesOnParseError() throws {
        // Malformed: [[agents]] header with no key=value scalars.
        let malformed = "[[agents]]\nthis is not a key value\nblah\n"
        try malformed.data(using: .utf8)!.write(to: tmpFile)
        let model = SettingsAgentsViewModel(path: tmpFile)
        XCTAssertTrue(model.inRawMode)
        XCTAssertFalse(model.rawText.isEmpty)
        XCTAssertTrue(model.statusIsError)
    }
}
