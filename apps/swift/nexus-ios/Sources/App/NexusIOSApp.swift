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
    @StateObject private var observer = SessionObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    @StateObject private var sourceIndex = SourceIndexObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    @StateObject private var triage = TriageObserver(
        client: NexusClient(endpoint: Self.defaultEndpoint())
    )
    @StateObject private var navigation = NavigationState()

    var body: some Scene {
        WindowGroup {
            RootScene()
                .environmentObject(observer)
                .environmentObject(sourceIndex)
                .environmentObject(triage)
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
