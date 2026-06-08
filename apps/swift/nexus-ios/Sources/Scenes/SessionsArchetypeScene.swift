// SessionsArchetypeScene (mx-i3fx) — CODE_SESSION surface (claude-code sessions
// from Nexus). Standalone (not in the work-triage aggregate). Renders
// SessionBody over the Core spine. READ-ONLY (mx v1).
//
// NOTE on naming: the existing SessionListScene drives the live-attach terminal
// surface; this archetype scene is named SessionsArchetypeScene to coexist (per
// the wiring contract — keep SessionListScene in the repo, just not the tab).
//
// Design: ~/dev/mx/docs/nx-ui/nx-wireframe-sessions.html (iOS compact).
// "Needs you" (agent_state blocked/waiting = MINE) first, then Running, then
// Idle/Ended. Row = status dot, title, machine/model/branch badges, agentState
// pill, cost mono, rate-limit bar. Tap -> DetailScene.

import SwiftUI
import NexusShared

struct SessionsArchetypeScene: View {
    @ObservedObject var observer: TriageObserver

    var body: some View {
        List {
            if observer.isSampleData {
                Section { SampleCaptionRow(id: "sessions-sample-caption") }
            }
            if !needsYou.isEmpty {
                Section {
                    ForEach(needsYou) { row($0) }
                } header: {
                    Label("Needs you · \(needsYou.count)", systemImage: "person.crop.circle.badge.exclamationmark")
                        .foregroundStyle(.blue)
                }
            }
            if !running.isEmpty {
                Section("Running") { ForEach(running) { row($0) } }
            }
            if !idleEnded.isEmpty {
                Section("Idle / Ended") { ForEach(idleEnded) { row($0) } }
            }
            if observer.sessions.isEmpty {
                Section { ContentUnavailableView("No sessions", systemImage: "terminal") }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Sessions")
        .navigationDestination(for: TriageItem.self) { DetailScene(item: $0) }
        .accessibilityIdentifier("sessions-archetype-scene")
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
    }

    private func row(_ item: TriageItem) -> some View {
        NavigationLink(value: item) { SessionRow(item: item) }
    }

    // agent_state in {blocked, waiting} => MINE / needs attention.
    private var needsYou: [TriageItem] {
        observer.sessions.filter {
            let st = $0.payload.session?.agentState ?? ""
            return st == "blocked" || st == "waiting"
        }
    }
    private var running: [TriageItem] {
        observer.sessions.filter {
            $0.payload.session?.status == "running" && !needsYou.contains($0)
        }
    }
    private var idleEnded: [TriageItem] {
        observer.sessions.filter {
            let s = $0.payload.session?.status ?? ""
            return (s == "idle" || s == "ended") && !needsYou.contains($0)
        }
    }
}

private struct SessionRow: View {
    let item: TriageItem
    private var b: SessionBody? { item.payload.session }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusDot(status: b?.status ?? "idle").padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                Text(item.title).font(.subheadline.weight(.medium)).lineLimit(2)
                HStack(spacing: 6) {
                    if let m = b?.machine { Badge(m) }
                    if let model = b?.model { Badge(short(model)) }
                    if let br = b?.branch { Badge(br) }
                }
                HStack(spacing: 6) {
                    if let st = b?.agentState {
                        OutlinePill(text: st, tint: (st == "blocked" || st == "waiting") ? .blue : .secondary)
                    }
                    if let cost = b?.totalCostUsd {
                        Text(String(format: "$%.2f", cost))
                            .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    if let util = b?.rateLimitUtilization { RateBar(value: util) }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("session-row-\(item.id)")
    }

    private func short(_ model: String) -> String {
        model.replacingOccurrences(of: "claude-", with: "")
    }
}

private struct StatusDot: View {
    let status: String
    var body: some View {
        Group {
            switch status {
            case "running": Circle().fill(Color.green)
            case "ended": Circle().stroke(Color.secondary, lineWidth: 1.5)
            default: Circle().fill(Color.gray)
            }
        }
        .frame(width: 9, height: 9)
        .accessibilityLabel(status)
    }
}

private struct Badge: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .medium, design: .monospaced))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 5).padding(.vertical, 1)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 4))
            .lineLimit(1)
    }
}

private struct RateBar: View {
    let value: Double
    var body: some View {
        HStack(spacing: 4) {
            Text("rate")
                .font(.system(size: 9)).foregroundStyle(.tertiary)
            ZStack(alignment: .leading) {
                Capsule().fill(Color.secondary.opacity(0.2)).frame(width: 44, height: 5)
                Capsule().fill(value > 0.8 ? Color.red : Color.blue)
                    .frame(width: 44 * Swift.min(Swift.max(value, 0), 1), height: 5)
            }
        }
        .accessibilityLabel("rate limit \(Int(value * 100)) percent")
    }
}

#if DEBUG
#Preview("Sessions (sample)") {
    NavigationStack {
        SessionsArchetypeScene(observer: {
            let o = TriageObserver(); o.setItemsForPreview(TriageItem.sampleData, isSample: true); return o
        }())
    }
}
#endif
