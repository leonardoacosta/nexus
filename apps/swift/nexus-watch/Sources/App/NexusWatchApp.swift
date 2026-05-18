// NexusWatchApp — watchOS entrypoint.
//
// Spec: openspec/changes/scaffold-nexus-watch-target (task 1.3)
//
// Single-tab WatchKit app. Subscribes to the agent via NexusShared and
// renders compact session count + last alert. Notification taps route
// through NexusWatchNotificationDelegate.

import SwiftUI
import NexusShared
import UserNotifications

@main
struct NexusWatchApp: App {
    @WKApplicationDelegateAdaptor(NexusWatchAppDelegate.self) private var delegate
    @StateObject private var observer = SessionObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(observer)
                .onAppear {
                    observer.startStreams()
                    NotificationActionRegistry.registerCategories()
                }
        }
    }

    private static func defaultEndpoint() -> NexusEndpoint {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "NEXUS_ENDPOINT") as? String,
           let url = URL(string: raw) {
            return NexusEndpoint(baseURL: url)
        }
        return NexusEndpoint(baseURL: URL(string: "http://homelab:7400")!)
    }
}
