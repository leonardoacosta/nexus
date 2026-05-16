//
//  AutostartInstaller.swift
//  nexus
//
//  Writes / removes `~/Library/LaunchAgents/com.nexus.menubar.plist`. Per
//  design.md §A6 we stay on LaunchAgent (not SMAppService) for v1 because
//  unsigned dev builds can't register via SMAppService.
//

import Foundation
import AppKit

enum AutostartInstaller {
    static let label = "com.nexus.menubar"

    static var plistURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent("Library")
            .appendingPathComponent("LaunchAgents")
            .appendingPathComponent("\(label).plist")
    }

    /// One-shot first-run prompt. Honors `PrefsKey.firstRun` so it only fires
    /// on the very first launch — accept or decline both record the choice.
    static func firstRunPromptIfNeeded() {
        let defaults = UserDefaults.nx
        if defaults.object(forKey: PrefsKey.firstRun) != nil { return }
        defaults.set(true, forKey: PrefsKey.firstRun)

        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
            let alert = NSAlert()
            alert.messageText = "Launch Nexus at login?"
            alert.informativeText = "Install a LaunchAgent so the menu bar starts when you log in."
            alert.addButton(withTitle: "Install")
            alert.addButton(withTitle: "Not now")
            alert.alertStyle = .informational
            let resp = alert.runModal()
            if resp == .alertFirstButtonReturn {
                defaults.set(true, forKey: PrefsKey.autostart)
                AutostartInstaller.install()
            } else {
                defaults.set(false, forKey: PrefsKey.autostart)
            }
        }
    }

    /// Write the plist + `launchctl bootstrap`. Best-effort — surfaces failures
    /// silently to console; UI feedback would require richer error handling
    /// than v1 needs.
    static func install() {
        do {
            let plistData = try makePlistData()
            try ensureDirectoryExists()
            try plistData.write(to: plistURL, options: .atomic)
            _ = try? launchctl(["bootstrap", domainTarget(), plistURL.path])
        } catch {
            NSLog("[nexus] autostart install failed: \(error)")
        }
    }

    static func uninstall() {
        _ = try? launchctl(["bootout", "\(domainTarget())/\(label)"])
        try? FileManager.default.removeItem(at: plistURL)
    }

    // MARK: - Internals (also exercised by LaunchAgentInstallerTests)

    static func makePlistData() throws -> Data {
        let appPath = Bundle.main.bundlePath
        let execName = (Bundle.main.executableURL?.lastPathComponent) ?? "nexus"
        let execPath = "\(appPath)/Contents/MacOS/\(execName)"
        let dict: [String: Any] = [
            "Label": label,
            "ProgramArguments": [execPath],
            "RunAtLoad": true,
            "KeepAlive": false,
            "StandardOutPath": "/tmp/\(label).out.log",
            "StandardErrorPath": "/tmp/\(label).err.log"
        ]
        return try PropertyListSerialization.data(
            fromPropertyList: dict,
            format: .xml,
            options: 0
        )
    }

    static func domainTarget() -> String {
        let uid = getuid()
        return "gui/\(uid)"
    }

    private static func ensureDirectoryExists() throws {
        let dir = plistURL.deletingLastPathComponent()
        if !FileManager.default.fileExists(atPath: dir.path) {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        }
    }

    @discardableResult
    private static func launchctl(_ args: [String]) throws -> Int32 {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        proc.arguments = args
        try proc.run()
        proc.waitUntilExit()
        return proc.terminationStatus
    }
}
