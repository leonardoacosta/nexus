// NotificationActivationHandler — UNUserNotificationCenterDelegate that
// routes banner-click activations through `NSWorkspace.shared.open(_:)`
// when the originating `NotificationEvent.logPath` was non-empty.
//
// Spec: openspec/changes/adopt-reaper-into-nx-cron (task 3.3 — fixes the
// raw-osascript click-attribution bug for all nx notifications).
//
// Wiring contract
// ───────────────
// `nexusApp.init()` mounts this delegate on `UNUserNotificationCenter
// .current()` so banner clicks land here. The delegate inspects the
// notification's userInfo for the `nexus.logPath` key (written by
// `TTSObserver.postBanner`) and:
//   - If a non-empty path is present → `NSWorkspace.shared.open(URL)`
//   - Otherwise → no-op (default activation: the OS focuses nexus.app)
//
// Why a separate file (not inlined in `nexusApp.swift`)
// ─────────────────────────────────────────────────────
// `UNUserNotificationCenter` requires its delegate to be an `NSObject`
// subclass, which doesn't compose well with the SwiftUI `App` struct.
// Splitting also lets the type be unit-tested through the public
// `activate(userInfo:)` seam without needing a real banner-click flow.

import AppKit
import Foundation
import NexusShared
import UserNotifications
import os.log

/// Routes banner-click activations through the OS default opener so the
/// click is attributed to the signed nexus.app process (fixes the
/// "raw osascript click-attribution" bug).
///
/// Construction takes an injectable `openFile` closure so tests can
/// observe the resolved URL without invoking AppKit. Production uses
/// `NSWorkspace.shared.open(_:)`.
///
/// Not `@MainActor`-isolated at the type level so it can conform to
/// `UNUserNotificationCenterDelegate` without the actor-conformance
/// warning. The delegate callbacks are documented by UN to run on the
/// main thread (AppKit posts them there); the public `activate(userInfo:)`
/// seam matches.
public final class NotificationActivationHandler: NSObject, UNUserNotificationCenterDelegate {

    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "NotificationActivationHandler"
    )

    /// Injected file opener. Returns `true` if the OS accepted the
    /// open request (matches `NSWorkspace.open` semantics — the handler
    /// only logs and forwards the result; it does not retry). Closure
    /// is already main-actor-bound by virtue of the enclosing type's
    /// `@MainActor` isolation.
    public typealias FileOpener = (URL) -> Bool

    private let openFile: FileOpener

    /// Production initializer wires `NSWorkspace.shared.open(_:)`.
    public override init() {
        self.openFile = { url in
            NSWorkspace.shared.open(url)
        }
        super.init()
    }

    /// Test initializer accepts a custom opener so the activation path
    /// can be asserted without invoking AppKit.
    public init(openFile: @escaping FileOpener) {
        self.openFile = openFile
        super.init()
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Show banners even when the app is foreground. Without this method,
    /// the OS silently suppresses notifications when nexus.app is the
    /// frontmost process — and since we just enabled `.regular` activation
    /// (Dock + Cmd-Tab) the app is foreground far more often than under
    /// the previous LSUIElement=true topology.
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // notification-fidelity (task 2.5): foreground gate. Defense-in-depth
        // for any already-posted request — when the banner toggle is off,
        // present nothing even if a request slipped past the poster gate.
        // Same raw-UserDefaults precedent as TTSObserver.postBanner.
        guard UserDefaults.standard.object(forKey: "nx.notifications.bannerEnabled") as? Bool ?? true else {
            completionHandler([])
            return
        }
        completionHandler([.banner, .sound])
    }

    /// Banner-click activation. Reads the `nexus.logPath` userInfo entry
    /// stashed by `TTSObserver.postBanner`. Non-empty path → route to
    /// `NSWorkspace.shared.open(_:)`. Empty / absent → no-op (the OS
    /// default activation focuses nexus.app, which preserves
    /// pre-fix behavior for every non-reaper notification).
    public func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        activate(userInfo: userInfo)
        completionHandler()
    }

    // MARK: - Test seam

    /// Public seam used by tests to drive the activation logic without
    /// constructing an UNNotificationResponse (Apple's initializers are
    /// SPI). Production calls into this from the delegate callback.
    public func activate(userInfo: [AnyHashable: Any]) {
        switch NotificationActivation.target(from: userInfo) {
        case .defaultActivation:
            Self.logger.debug(
                "NotificationActivationHandler: default activation (no logPath)"
            )
        case .openFile(let url):
            Self.logger.info(
                "NotificationActivationHandler: opening logPath=\(url.path, privacy: .public)"
            )
            let opened = openFile(url)
            if !opened {
                Self.logger.error(
                    "NotificationActivationHandler: NSWorkspace.open returned false for path=\(url.path, privacy: .public)"
                )
            }
        }
    }
}
