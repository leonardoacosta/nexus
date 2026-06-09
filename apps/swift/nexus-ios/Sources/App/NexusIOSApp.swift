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
                    wireHealthKitMedSave()
                }
                .onOpenURL { url in
                    navigation.handle(deepLink: url)
                }
        }
    }

    /// Wire the meds two-way HealthKit save hook (src-meds mx-aw88): after a
    /// group take succeeds against the mx sidecar, mirror "taken" dose events
    /// into Apple Health via HealthKitMedBridge. On iOS 26.4 the bridge's write
    /// is a no-op (no HKMedicationDoseEvent write API — the Health app is the
    /// sole writer), but the call site is wired and ready for a future SDK.
    private func wireHealthKitMedSave() {
        if #available(iOS 26.0, *) {
            meds.onGroupTaken = { members in
                let writeMembers = members.map {
                    HealthKitMedBridge.MedicationWriteMember(
                        medID: $0.medId, hkMedID: $0.hkMedId, dose: $0.dose)
                }
                await HealthKitMedBridge.shared.saveDoseEvents(forGroup: writeMembers)
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
