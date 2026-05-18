// NexusAppDelegate — APNS registration + notification routing.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.5)
//
// Wire scaffolding only — the push entitlement and provisioning profile
// land via bd:nx-gsgvk (Apple Developer Console work). The code below
// compiles against UIKit without push capability but no real device push
// will arrive until provisioning lands.

import Foundation
#if canImport(UIKit)
import UIKit
import UserNotifications

final class NexusAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, _ in
            DispatchQueue.main.async {
                if granted {
                    application.registerForRemoteNotifications()
                }
            }
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        // POST the token to the nexus agent so server-side notification
        // dispatch can target this device. The agent route is part of
        // the broader notification surface and is gated on entitlement.
        Task {
            await ApnsRegistrar.shared.register(token: token)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Silent in dev (no entitlement -> always fails). bd:nx-gsgvk
        // unblocks this path.
    }

    // Foreground display.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // Tap handler — route to session detail via deep link.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        if let sessionId = info["sessionId"] as? String {
            DispatchQueue.main.async {
                NotificationCenter.default.post(
                    name: .nexusOpenSessionDetail,
                    object: sessionId
                )
            }
        }
        completionHandler()
    }
}

extension Notification.Name {
    static let nexusOpenSessionDetail = Notification.Name("nexusOpenSessionDetail")
}

#endif
