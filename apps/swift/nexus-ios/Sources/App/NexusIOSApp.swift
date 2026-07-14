// NexusIOSApp — iOS app entrypoint.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.3)
//
// Wires the shared NexusShared.SessionObserver into the SwiftUI scene
// graph, registers for APNS, and routes deep-link taps to AttachScene.

import SwiftUI
import NexusShared
#if canImport(UIKit)
import UIKit
#endif

@main
struct NexusIOSApp: App {
    @UIApplicationDelegateAdaptor(NexusAppDelegate.self) private var delegate

    /// Persist the iOS default endpoint into `SettingsStore.dashboardEndpoint`
    /// on first launch (mirrors macOS `nexusApp.init`). iOS injects its endpoint
    /// via the `NexusClient(endpoint:)` constructor, but STATIC consumers of
    /// `NexusEndpoint.resolved` — notably `HealthKitMedBridge`'s meds-ingest POST,
    /// which has no `NexusClient` instance — read `dashboardEndpoint`. Unset, it
    /// collapsed to `.localhost`, so the catalog/dose ingest POSTed to
    /// `http://localhost:8802` and silently failed (mx `/meds/medications` empty).
    /// Seeding it here — BEFORE `NexusAppDelegate` bootstraps the HealthKit med
    /// bridge — makes `.resolved` return `homelab:7400` for every static consumer.
    /// Honors the Info.plist `NEXUS_ENDPOINT` override via `defaultEndpoint()`.
    init() {
        if SettingsStore.shared.dashboardEndpoint == nil {
            SettingsStore.shared.dashboardEndpoint =
                Self.defaultEndpoint().baseURL.absoluteString
        }
    }

    @StateObject private var observer = SessionObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    @StateObject private var sourceIndex = SourceIndexObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    @StateObject private var triage = TriageObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    // src-meds (mx-ieau): the Meds tab talks to the meds CRUD sidecar (:8802),
    // whose host NexusClient+Meds derives from the resolved dashboard endpoint.
    @StateObject private var meds = MedsObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    @StateObject private var navigation = NavigationState()

    var body: some Scene {
        WindowGroup {
            RootScene()
                .environmentObject(observer)
                .environmentObject(sourceIndex)
                .environmentObject(triage)
                .environmentObject(meds)
                .environmentObject(navigation)
                .onAppear {
                    observer.startStreams()
                }
                .onOpenURL { url in
                    navigation.handle(deepLink: url)
                }
        }
    }

    /// Default endpoint hits the homelab Tailnet hostname. Override via
    /// Info.plist `NEXUS_ENDPOINT` when running against a different peer.
    private static func defaultEndpoint() -> NexusEndpoint {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "NEXUS_ENDPOINT") as? String,
           let url = URL(string: raw) {
            return NexusEndpoint(baseURL: url)
        }
        return NexusEndpoint(baseURL: URL(string: "http://homelab:7400")!)
    }
}
