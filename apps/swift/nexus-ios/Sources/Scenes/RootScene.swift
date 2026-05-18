// RootScene — iOS root container.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.3)
//
// Lightweight TabView wrapping SessionListScene + a placeholder Settings
// route. Real settings parity ships via swift-dashboard-feature-parity.

import SwiftUI
import NexusShared

struct RootScene: View {
    @EnvironmentObject private var observer: SessionObserver
    @EnvironmentObject private var navigation: NavigationState

    var body: some View {
        TabView {
            NavigationStack {
                SessionListScene()
                    .navigationTitle("Sessions")
            }
            .tabItem {
                Label("Sessions", systemImage: "terminal")
            }

            NavigationStack {
                HealthSummaryScene()
                    .navigationTitle("Health")
            }
            .tabItem {
                Label("Health", systemImage: "waveform.path.ecg")
            }
        }
        .sheet(item: Binding(
            get: { navigation.attachingSessionId.map(SessionIdBox.init) },
            set: { navigation.attachingSessionId = $0?.id }
        )) { box in
            AttachScene(sessionId: box.id)
        }
    }
}

/// Small wrapper to use String as `Identifiable` for `.sheet(item:)`.
struct SessionIdBox: Identifiable {
    let id: String
}
