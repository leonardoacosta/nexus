//
//  GhosttyLauncherTests.swift
//  nexusTests
//
//  Asserts the exact argv that `GhosttyLauncher` would invoke against
//  `/usr/bin/open`. Per design.md §A3 the contract is locked: any drift here
//  breaks the ATTACH flow.
//

import XCTest
@testable import nexus

final class GhosttyLauncherTests: XCTestCase {

    func testArgvForKnownWindowName() {
        let argv = GhosttyLauncher.arguments(
            forWindow: "nx-1715900000000",
            user: "nyaptor",
            host: "homelab"
        )

        XCTAssertEqual(argv.count, 5, "expected exactly 5 argv entries")
        XCTAssertEqual(argv[0], "-na")
        XCTAssertEqual(argv[1], "Ghostty.app")
        XCTAssertEqual(argv[2], "--args")
        XCTAssertEqual(argv[3], "-e")
        XCTAssertEqual(
            argv[4],
            "ssh -t nyaptor@homelab tmux attach \\; select-window -t nx-1715900000000",
            "the -e argument must include the literal escaped semicolon (\\;) so tmux receives a command separator"
        )
    }

    func testExecutablePath() {
        // `/usr/bin/open` is the canonical macOS launcher — pinned so a future
        // refactor doesn't silently switch to /usr/local/bin/open or similar.
        XCTAssertEqual(GhosttyLauncher.executable, "/usr/bin/open")
        XCTAssertEqual(GhosttyLauncher.bundleName, "Ghostty.app")
    }

    func testArgvWithCustomUserAndHost() {
        let argv = GhosttyLauncher.arguments(
            forWindow: "demo-42",
            user: "alice",
            host: "remote"
        )
        XCTAssertEqual(argv[4],
            "ssh -t alice@remote tmux attach \\; select-window -t demo-42")
    }
}
