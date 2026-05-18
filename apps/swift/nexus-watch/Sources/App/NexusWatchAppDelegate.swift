// NexusWatchAppDelegate — handles APNS registration and notification taps.
//
// Spec: openspec/changes/scaffold-nexus-watch-target (tasks 1.4, 1.5)
//
// Provisioning + pairing (task 1.6) lands via bd:nx-gsgvk; this delegate
// compiles without the entitlement but no real push will arrive until
// provisioning completes.

import Foundation
import WatchKit
import UserNotifications

final class NexusWatchAppDelegate: NSObject, WKApplicationDelegate, UNUserNotificationCenterDelegate {

    func applicationDidFinishLaunching() {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(
            options: [.alert, .badge, .sound]
        ) { granted, _ in
            DispatchQueue.main.async {
                if granted {
                    WKExtension.shared().registerForRemoteNotifications()
                }
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    /// Notification action handler — routes Approve / Deny / Custom taps
    /// back to the originating CC session via `/commands/send-text`.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        guard let sessionId = info["sessionId"] as? String else {
            completionHandler()
            return
        }

        let text: String?
        switch response.actionIdentifier {
        case NotificationActionRegistry.approveActionId:
            text = "approve"
        case NotificationActionRegistry.denyActionId:
            text = "deny"
        case NotificationActionRegistry.customActionId:
            // Voice-to-text dictation (nx-pqx3i) lands later. Today we
            // surface a generic "continue".
            text = "continue"
        case UNNotificationDefaultActionIdentifier,
             UNNotificationDismissActionIdentifier:
            text = nil
        default:
            text = nil
        }

        if let text {
            Task {
                await SendTextDispatcher.shared.send(sessionId: sessionId, text: text)
                completionHandler()
            }
        } else {
            completionHandler()
        }
    }
}
