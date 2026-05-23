// NexusMacAppDelegate — NSApplicationDelegate for the Mac target.
//
// Spec: bd:nx-fkewy
//
// Why this exists
// ---------------
// On macOS 26.3 (Tahoe), SwiftUI's `.defaultLaunchBehavior(.presented)`
// modifier on a singleton `Window` scene does NOT actually present the
// window at cold launch. Empirical evidence (2026-05-22):
//
//   - lsappinfo reports flavor=3 (kLSApplicationFlavorDocked, i.e. the
//     regular .regular activation policy from LSUIElement=false).
//   - `count of windows` via System Events = 0, three seconds after
//     launching with `-uitest-open-dashboard YES`.
//   - The "Window > Nexus Dashboard" menu entry IS present (SwiftUI
//     registered the scene), proving the scene exists but is unpresented.
//   - Calling NSApp.activate(ignoringOtherApps: true) alone does NOT
//     surface the window — only clicking the menu entry does.
//
// This is the upstream cause of the XCUITest fault #4 regression:
// `testEveryDashboardSectionRenders` clicks the Sessions sidebar row,
// but the row never exists because the host Window scene was never
// presented. The test's symptom is "SessionsView never mounted" but
// the actual broken layer is the Window scene itself.
//
// Workaround
// ----------
// In `applicationDidFinishLaunching(_:)` we (1) explicitly activate
// the app and (2) trigger the SwiftUI-generated Window menu entry for
// "Nexus Dashboard" via NSApp.sendAction — which is the same code path
// `openWindow(id:)` invokes internally. This forces the singleton
// Window scene to present at cold launch, restoring the pre-eaa1a98
// behavior under LSUIElement=false.
//
// Defensive: if the menu entry can't be found (different macOS build,
// future SwiftUI change), we fall back to ordering any NSWindow whose
// identifier contains "dashboard". A second fallback (notification
// posting) lets the existing NexusPanel @Environment(\.openWindow) seam
// handle it if both menu and NSWindow paths miss.

import AppKit
import SwiftUI
import os.log

@MainActor
final class NexusMacAppDelegate: NSObject, NSApplicationDelegate {
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "AppDelegate"
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Step 1 — guarantee foreground activation. Without this, even
        // the menu-click path below sometimes lands while the app is
        // still .accessory-shaped from the LSUIElement legacy state.
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)

        // Step 2 — defer one runloop tick so SwiftUI has registered the
        // Window scenes (the "Nexus Dashboard" menu entry isn't present
        // synchronously at didFinishLaunching).
        DispatchQueue.main.async { [weak self] in
            self?.presentDashboardWindow()
        }
    }

    private func presentDashboardWindow() {
        // Primary: programmatically fire the SwiftUI-generated Window
        // menu entry. This is the same code path the user clicking
        // `Window > Nexus Dashboard` exercises, and the same one
        // openWindow(id: "dashboard") would call from Environment.
        if let windowMenu = NSApp.mainMenu?.items
            .first(where: { $0.submenu?.title == "Window" })?.submenu,
           let dashboardItem = windowMenu.items
            .first(where: { $0.title == "Nexus Dashboard" }),
           let action = dashboardItem.action
        {
            Self.logger.info("AppDelegate: triggering Window > Nexus Dashboard menu item")
            _ = NSApp.sendAction(action, to: dashboardItem.target, from: dashboardItem)
            return
        }

        // Fallback A: bring forward an existing NSWindow whose
        // identifier marks it as the dashboard scene. SwiftUI tags
        // Window scenes with the `id:` we provided ("dashboard").
        if let dashboardWindow = NSApp.windows.first(where: { window in
            (window.identifier?.rawValue ?? "").contains("dashboard")
        }) {
            Self.logger.info("AppDelegate: ordering existing dashboard NSWindow forward")
            dashboardWindow.makeKeyAndOrderFront(nil)
            return
        }

        // Fallback B: post a notification — any view that mounts later
        // (NexusPanel.onAppear) can observe and call openWindow.
        Self.logger.warning(
            "AppDelegate: no dashboard menu item or NSWindow found — posting fallback notification"
        )
        NotificationCenter.default.post(
            name: Self.openDashboardNotification, object: nil
        )
    }

    /// Fallback B notification name. Views in SwiftUI scope can listen
    /// via `.onReceive(NotificationCenter.default.publisher(for:))` and
    /// call `openWindow(id: "dashboard")` from their Environment.
    static let openDashboardNotification = Notification.Name(
        "dev.leonardoacosta.nexus.openDashboard"
    )
}
