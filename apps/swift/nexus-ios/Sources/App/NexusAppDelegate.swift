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
import BackgroundTasks

final class NexusAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    // BGTaskScheduler identifiers — MUST match Info.plist
    // BGTaskSchedulerPermittedIdentifiers. The refresh task is a frequent, short
    // health flush; the processing task is a heavier flush iOS schedules when the
    // device is idle/charging (good for large backfills).
    static let healthRefreshTaskID = "dev.leonardoacosta.nexus.ios.health.refresh"
    static let healthProcessingTaskID = "dev.leonardoacosta.nexus.ios.health.processing"

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
        // Apple HealthKit biometric push (mx src-health producer): request read
        // auth + register background observers that POST samples to the homelab
        // mx-health ingest. Distinct from the system-metrics "health" surface.
        if #available(iOS 15.0, *) {
            registerHealthBackgroundTasks()
            Task { await HealthKitPushManager.shared.bootstrap() }
            scheduleHealthBackgroundTasks()
        }
        // src-meds HealthKit medication bridge (mx-aw88): reads the user's Apple
        // Health med list + logged dose events and pushes them to the mx
        // meds-ingest (:8802). iOS 26 only (HKMedicationDoseEvent /
        // HKUserAnnotatedMedication); no-ops cleanly on older OSes.
        if #available(iOS 26.0, *) {
            Task { await HealthKitMedBridge.shared.bootstrap() }
        }
        return true
    }

    // MARK: - Background health flush (BGTaskScheduler)
    //
    // Three independent wake paths feed the SAME flushAll():
    //   1. HKObserverQuery + background delivery (event-driven, in the manager)
    //   2. BGTaskScheduler refresh/processing (iOS-scheduled periodic, below)
    //   3. silent APNS push (server-driven cadence, didReceiveRemoteNotification)
    // iOS gives no guaranteed interval for any single one, so layering them is how
    // you approximate "periodically push in the background" on a platform with no
    // persistent background service.

    @available(iOS 15.0, *)
    private func registerHealthBackgroundTasks() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.healthRefreshTaskID, using: nil) { task in
            self.handleHealthFlush(task)
        }
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.healthProcessingTaskID, using: nil) { task in
            self.handleHealthFlush(task)
        }
    }

    @available(iOS 15.0, *)
    func scheduleHealthBackgroundTasks() {
        let refresh = BGAppRefreshTaskRequest(identifier: Self.healthRefreshTaskID)
        refresh.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60) // iOS treats this as a floor, not a guarantee
        try? BGTaskScheduler.shared.submit(refresh)

        let processing = BGProcessingTaskRequest(identifier: Self.healthProcessingTaskID)
        processing.requiresNetworkConnectivity = true
        processing.requiresExternalPower = false
        processing.earliestBeginDate = Date(timeIntervalSinceNow: 60 * 60)
        try? BGTaskScheduler.shared.submit(processing)
    }

    /// Run flushAll, reschedule the next occurrence, and honor the OS expiration
    /// deadline. Shared by both the refresh and processing tasks.
    @available(iOS 15.0, *)
    private func handleHealthFlush(_ task: BGTask) {
        scheduleHealthBackgroundTasks() // always reschedule so the chain continues
        let work = Task {
            await HealthKitPushManager.shared.flushAll()
            if #available(iOS 26.0, *) {
                await HealthKitMedBridge.shared.flushAll()
            }
            task.setTaskCompleted(success: true)
        }
        task.expirationHandler = { work.cancel() }
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

    /// Silent APNS push (aps content-available:1) — the SERVER-DRIVEN background
    /// wake. The homelab sends a background push on its own cadence to wake the app
    /// and flush HealthKit, guaranteeing an interval the on-device schedulers
    /// (throttled by iOS) cannot. A health-flush push carries
    /// userInfo["nexusKind"] == "health-flush"; anything else falls through with
    /// .noData so unrelated silent pushes don't trigger a flush.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard userInfo["nexusKind"] as? String == "health-flush" else {
            completionHandler(.noData)
            return
        }
        if #available(iOS 15.0, *) {
            Task {
                await HealthKitPushManager.shared.flushAll()
                if #available(iOS 26.0, *) {
                    await HealthKitMedBridge.shared.flushAll()
                }
                completionHandler(.newData)
            }
        } else {
            completionHandler(.noData)
        }
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
