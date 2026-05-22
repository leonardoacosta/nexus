// AgentsConfigStoreTests — round-trip + atomic-write + validation
// + parse-failure coverage for ~/.config/nexus/agents.toml.
//
// Spec: openspec/changes/settings-tab-redesign (task 1.4, bd:nx-gd41u)

import XCTest
@testable import NexusShared

final class AgentsConfigStoreTests: XCTestCase {
    private var tmpDir: URL!
    private var tmpFile: URL!

    override func setUp() {
        super.setUp()
        tmpDir = FileManager.default.temporaryDirectory
            .appendingPathComponent("nexus-agents-config-tests-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(
            at: tmpDir,
            withIntermediateDirectories: true
        )
        tmpFile = tmpDir.appendingPathComponent("agents.toml")
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: tmpDir)
        super.tearDown()
    }

    // MARK: - read round-trip

    func testReadRoundTripPreservesEntries() throws {
        let entries = [
            AgentEntry(name: "homelab", host: "100.73.182.4", port: 7400, user: "nyaptor"),
            AgentEntry(name: "macbook", host: "127.0.0.1", port: 7400, user: nil)
        ]
        try AgentsConfigStore.write(entries, path: tmpFile)
        let parsed = try AgentsConfigStore.read(path: tmpFile)
        XCTAssertEqual(parsed.count, 2)
        XCTAssertEqual(parsed[0].name, "homelab")
        XCTAssertEqual(parsed[0].host, "100.73.182.4")
        XCTAssertEqual(parsed[0].port, 7400)
        XCTAssertEqual(parsed[0].user, "nyaptor")
        XCTAssertEqual(parsed[1].name, "macbook")
        XCTAssertNil(parsed[1].user)
    }

    func testReadMissingFileReturnsEmpty() throws {
        let parsed = try AgentsConfigStore.read(path: tmpFile)
        XCTAssertEqual(parsed.count, 0)
    }

    // MARK: - atomic write

    func testAtomicWriteDoesNotCorruptOnMidWriteCrash() throws {
        // Pre-seed a valid file.
        let original = [AgentEntry(name: "before", host: "10.0.0.1", port: 7400)]
        try AgentsConfigStore.write(original, path: tmpFile)

        // Simulate a crash mid-write: drop a stale .tmp on disk WITHOUT
        // a subsequent rename. The .tmp must not affect a subsequent read
        // (read targets the canonical path, not .tmp).
        let staleTmp = tmpFile.appendingPathExtension("tmp")
        try "garbage".data(using: .utf8)!.write(to: staleTmp)

        let parsed = try AgentsConfigStore.read(path: tmpFile)
        XCTAssertEqual(parsed.count, 1)
        XCTAssertEqual(parsed[0].name, "before")
    }

    // MARK: - validate

    func testValidateRejectsEmptyName() {
        let bad = AgentEntry(name: "", host: "10.0.0.1", port: 7400)
        let errors = AgentsConfigStore.validate(bad)
        XCTAssertTrue(errors.contains(where: { $0.field == .name }))
    }

    func testValidateRejectsEmptyHost() {
        let bad = AgentEntry(name: "x", host: "  ", port: 7400)
        let errors = AgentsConfigStore.validate(bad)
        XCTAssertTrue(errors.contains(where: { $0.field == .host }))
    }

    func testValidateRejectsBadPort() {
        let bad = AgentEntry(name: "x", host: "10.0.0.1", port: 0)
        let errors = AgentsConfigStore.validate(bad)
        XCTAssertTrue(errors.contains(where: { $0.field == .port }))
    }

    func testValidateAcceptsCleanRow() {
        let good = AgentEntry(name: "x", host: "10.0.0.1", port: 7400)
        XCTAssertTrue(AgentsConfigStore.validate(good).isEmpty)
    }

    // MARK: - parse failure surfaces typed error

    func testParseFailureSurfacesTypedError() throws {
        // Malformed: a [[agents]] header but no scalars at all yields
        // zero entries — AgentsConfigStore promotes this to .parseFailure.
        let malformed = "[[agents]]\nnot-a-key-equals-value\nanother garbage line\n"
        try malformed.data(using: .utf8)!.write(to: tmpFile)
        XCTAssertThrowsError(try AgentsConfigStore.read(path: tmpFile)) { error in
            guard case AgentsConfigError.parseFailure = error else {
                XCTFail("expected .parseFailure, got \(error)")
                return
            }
        }
    }

    func testRawReadRoundTrip() throws {
        let raw = "# manual edit\n[[agents]]\nname=\"x\"\nhost=\"y\"\nport=7400\n"
        try AgentsConfigStore.writeRaw(raw, path: tmpFile)
        XCTAssertEqual(AgentsConfigStore.readRaw(path: tmpFile), raw)
    }
}
