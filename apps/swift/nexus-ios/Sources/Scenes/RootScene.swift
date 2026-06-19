// RootScene — iOS root container.
//
// Spec: openspec/changes/ios-session-navigation (UI 2.2, 2.6)
//
// TabView (selection-bound to navigation.selectedTab) wrapping each archetype
// scene in its own NavigationStack. The Sessions tab's stack is bound to
// navigation.sessionPath ([String] of session ids); appending an id pushes
// AttachScene(sessionId:) via .navigationDestination. A notification-banner
// tap (APNS) or a cross-tab Attach button selects the Sessions tab, then
// appends to sessionPath — no modal sheet.

import SwiftUI
import NexusShared

struct RootScene: View {
    @EnvironmentObject private var observer: SessionObserver
    @EnvironmentObject private var sourceIndex: SourceIndexObserver
    @EnvironmentObject private var triage: TriageObserver
    @EnvironmentObject private var meds: MedsObserver
    @EnvironmentObject private var navigation: NavigationState

    /// Cold-launch buffer: if an APNS tap fires `.nexusOpenSessionDetail`
    /// before the Sessions stack has mounted, stash the id here and replay it
    /// on `.onAppear` so the push is never dropped.
    @State private var pendingSessionId: String?
    @State private var didAppear = false

    var body: some View {
        // Tab order Leo approved: Sources, Comms, Calendar, Finance, Health,
        // Meds, Sessions, Notifications. Each archetype tab hosts its scene in a
        // NavigationStack so row -> push works. Each tab is `.tag`ed with its
        // RootTab case so `selection: $navigation.selectedTab` can switch tabs
        // for cross-tab deep links.
        TabView(selection: $navigation.selectedTab) {
            NavigationStack {
                SourcesScene(observer: sourceIndex)
                    .navigationTitle("Sources")
            }
            .tabItem {
                Label("Sources", systemImage: "square.grid.2x2")
            }
            .tag(RootTab.sources)

            NavigationStack {
                CommsScene(observer: triage)
            }
            .tabItem {
                Label("Comms", systemImage: "tray.full")
            }
            .tag(RootTab.comms)

            NavigationStack {
                CalendarScene(observer: triage)
            }
            .tabItem {
                Label("Calendar", systemImage: "calendar")
            }
            .tag(RootTab.calendar)

            NavigationStack {
                FinanceScene(observer: triage)
            }
            .tabItem {
                Label("Finance", systemImage: "creditcard")
            }
            .tag(RootTab.finance)

            NavigationStack {
                HealthMetricsScene(observer: triage)
            }
            .tabItem {
                Label("Health", systemImage: "heart")
            }
            .tag(RootTab.health)

            NavigationStack {
                // src-meds (mx-ieau + mx-jc0k): medication group manager. The
                // adherence/misses triage is the landing surface; the per-dose
                // logbook (History) + add-med form hang off its toolbar menu.
                // Writes round-trip through the meds CRUD sidecar (:8802).
                MedicationGroupScene(observer: meds)
            }
            .tabItem {
                Label("Meds", systemImage: "pills")
            }
            .tag(RootTab.meds)

            NavigationStack(path: $navigation.sessionPath) {
                // ios-session-navigation (UI 2.2): the Sessions tab's stack is
                // driven by navigation.sessionPath. A row tap (or a deep link)
                // appends a session id, which pushes AttachScene(sessionId:)
                // (live PTY) via the .navigationDestination below — no sheet.
                SessionsArchetypeScene()
                    .navigationDestination(for: String.self) { sessionId in
                        AttachScene(sessionId: sessionId)
                    }
            }
            .tabItem {
                Label("Sessions", systemImage: "terminal")
            }
            .tag(RootTab.sessions)

            NavigationStack {
                // mx-rkir.9: Notifications list + full-detail subview. iOS
                // banners truncate; this lets Leo read the full notification
                // in-app. Binds to SessionObserver.notifications + backfills
                // from GET /notifications.
                NotificationsScene()
            }
            .tabItem {
                Label("Notifications", systemImage: "bell")
            }
            .tag(RootTab.notifications)
        }
        // mx-7i4k + mx-rkir.3 / ios-session-navigation (UI 2.6): deep-link a
        // notification-banner tap (APNS) straight to the originating session's
        // LIVE PTY. NexusAppDelegate.didReceive posts `.nexusOpenSessionDetail`
        // (object: sessionId). We observe it at the always-mounted root: select
        // the Sessions tab, then push by appending to sessionPath. If we fire
        // before the body has appeared (cold launch), buffer the id and replay
        // on `.onAppear` so the push is not dropped.
        .onReceive(NotificationCenter.default.publisher(
            for: .nexusOpenSessionDetail
        )) { note in
            guard let id = note.object as? String else { return }
            if didAppear {
                pushSession(id)
            } else {
                pendingSessionId = id
            }
        }
        .onAppear {
            didAppear = true
            if let id = pendingSessionId {
                pendingSessionId = nil
                pushSession(id)
            }
        }
    }

    /// Select the Sessions tab, then append the id so AttachScene pushes onto
    /// the Sessions stack (the only stack carrying the .navigationDestination).
    private func pushSession(_ id: String) {
        navigation.selectedTab = .sessions
        navigation.sessionPath.append(id)
    }
}
