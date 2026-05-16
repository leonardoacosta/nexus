//
//  LaunchAgentInstallerTests.swift
//  nexusTests
//
//  Mocks filesystem + launchctl is not safe to actually run in unit tests, so
//  we only assert the artifacts the installer would produce:
//  - the plist payload is well-formed XML
//  - the plist points at the running binary
//  - the domain target uses the right `gui/<uid>` shape
//

import XCTest
@testable import nexus

final class LaunchAgentInstallerTests: XCTestCase {

    func testPlistIsWellFormedAndContainsExpectedKeys() throws {
        let data = try AutostartInstaller.makePlistData()
        let plist = try PropertyListSerialization.propertyList(
            from: data, options: [], format: nil
        ) as? [String: Any]
        XCTAssertNotNil(plist)
        XCTAssertEqual(plist?["Label"] as? String, "com.nexus.menubar")
        XCTAssertEqual(plist?["RunAtLoad"] as? Bool, true)
        let args = plist?["ProgramArguments"] as? [String]
        XCTAssertNotNil(args)
        XCTAssertFalse((args ?? []).isEmpty)
        // The executable path must be absolute (LaunchAgents reject relative).
        XCTAssertTrue((args ?? [""])[0].hasPrefix("/"),
                      "expected an absolute executable path; got \(args ?? [])")
    }

    func testDomainTargetIsGuiUidShape() {
        let target = AutostartInstaller.domainTarget()
        XCTAssertTrue(target.hasPrefix("gui/"),
                      "expected gui/<uid>; got \(target)")
        // After the prefix should be the current user's UID.
        let uid = String(getuid())
        XCTAssertEqual(target, "gui/\(uid)")
    }

    func testPlistURLLivesUnderHomeLibraryLaunchAgents() {
        let url = AutostartInstaller.plistURL
        XCTAssertTrue(url.path.contains("/Library/LaunchAgents/com.nexus.menubar.plist"),
                      "got: \(url.path)")
    }
}
