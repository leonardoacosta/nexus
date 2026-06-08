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
    @EnvironmentObject private var sourceIndex: SourceIndexObserver
    @EnvironmentObject private var triage: TriageObserver
    @EnvironmentObject private var navigation: NavigationState

    var body: some View {
        // Tab order Leo approved: Sources, Comms, Calendar, Finance, Health,
        // Sessions. Each archetype tab hosts its scene in a NavigationStack so
        // row -> DetailScene pushes work. The existing SessionListScene /
        // HealthSummaryScene remain in the repo (not primary tabs).
        TabView {
            NavigationStack {
                SourcesScene(observer: sourceIndex)
                    .navigationTitle("Sources")
            }
            .tabItem {
                Label("Sources", systemImage: "square.grid.2x2")
            }

            NavigationStack {
                CommsScene(observer: triage)
            }
            .tabItem {
                Label("Comms", systemImage: "tray.full")
            }

            NavigationStack {
                CalendarScene(observer: triage)
            }
            .tabItem {
                Label("Calendar", systemImage: "calendar")
            }

            NavigationStack {
                FinanceScene(observer: triage)
            }
            .tabItem {
                Label("Finance", systemImage: "creditcard")
            }

            NavigationStack {
                HealthMetricsScene(observer: triage)
            }
            .tabItem {
                Label("Health", systemImage: "heart")
            }

            NavigationStack {
                SessionsArchetypeScene(observer: triage)
            }
            .tabItem {
                Label("Sessions", systemImage: "terminal")
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
