// SessionDetailScene — single-session detail with Attach CTA.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.3)

import SwiftUI
import NexusShared

struct SessionDetailScene: View {
    let sessionId: String

    @EnvironmentObject private var observer: SessionObserver
    @EnvironmentObject private var navigation: NavigationState

    private var session: Session? {
        observer.sessions.first(where: { $0.id == sessionId })
    }

    var body: some View {
        Group {
            if let session {
                List {
                    Section("Identity") {
                        labeled("Project", session.project ?? "—")
                        labeled("Branch", session.branch ?? "—")
                        labeled("Agent", session.originAgent)
                        labeled("Status", session.status)
                    }
                    if let cwd = session.cwd {
                        Section("Working directory") {
                            Text(cwd).font(.system(.body, design: .monospaced))
                        }
                    }
                    Section {
                        Button {
                            navigation.attachingSessionId = session.id
                        } label: {
                            Label("Attach", systemImage: "terminal")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(session.tmuxTarget == nil)
                    } footer: {
                        if session.tmuxTarget == nil {
                            Text("Attach requires a tmuxTarget on the session row.")
                        }
                    }
                }
            } else {
                ProgressView("Loading session…")
            }
        }
        .navigationTitle(session?.project ?? "Session")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func labeled(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
    }
}
