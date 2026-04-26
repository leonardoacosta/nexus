// nexus-stub.swift — minimal app entrypoint for per-project Nexus bundles.
//
// Each ~/Applications/Nexus-<code>.app needs a real executable in
// Contents/MacOS/. Without one Gatekeeper rejects the bundle as malformed.
// More subtly, terminal-notifier's `-sender <bundle-id>` only renders the
// bundle's icon in the LEFT slot of a banner if that bundle has called
// UNUserNotificationCenter.requestAuthorization() at least once — without
// the registration, macOS silently falls back to the calling tool's own
// bundle (terminal-notifier's logo).
//
// This stub:
//   1. Initializes NSApplication (required for UN delegate registration).
//   2. Calls UNUserNotificationCenter.current().requestAuthorization() —
//      the act of asking is what registers the bundle as a notification
//      source with the OS, regardless of whether the user grants.
//   3. Terminates immediately so the user never sees a Dock icon or window.
//
// Compiled once, copied into every bundle's Contents/MacOS/.

import Cocoa
import UserNotifications

class StubAppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { _, _ in
            DispatchQueue.main.async {
                NSApp.terminate(nil)
            }
        }
        // Fallback timeout — if the auth callback never fires (rare but
        // possible during initial bundle registration), exit anyway after
        // 3s so we don't leak a stuck process.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) {
            NSApp.terminate(nil)
        }
    }
}

let app = NSApplication.shared
let delegate = StubAppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
