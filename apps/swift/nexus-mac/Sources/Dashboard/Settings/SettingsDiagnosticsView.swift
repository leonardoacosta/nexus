// SettingsDiagnosticsView — read-only key/value health/liveness pane with
// traffic-light staleness dots and a confirmed-copy diagnostics button.
//
// Spec: openspec/changes/settings-tab-redesign (tasks 2.8 + 2.9,
// bd:nx-112m3, bd:nx-yrpys)
//
// Fields surfaced (per proposal §6):
//   - last health snapshot ts + age
//   - last process-watcher tick ts + age (traffic light)
//   - socket-spine listening (boolean)
//   - db_ok (boolean)
//   - agents.toml entry count
//   - dashboard build SHA (CFBundleShortVersionString + Bundle GitSha)
//   - agent build SHA (best-effort from /health payload)
//
// Traffic-light thresholds (per spec scenarios):
//   green  <30s
//   yellow <2min
//   red    ≥2min
//
// Copy diagnostics: builds a plain-text payload under a
// `nexus diagnostics — <ISO date>` header, shows a confirmation dialog
// with the exact payload, only writes to NSPasteboard.general on Copy.

import SwiftUI
import AppKit
import NexusShared

/// Thin abstraction so tests can inject a stubbed health-detail payload.
public protocol DiagnosticsFetcher: Sendable {
    func fetchHealthDetail() async -> [String: Any]
}

public struct DefaultDiagnosticsFetcher: DiagnosticsFetcher {
    public init() {}
    public func fetchHealthDetail() async -> [String: Any] {
        let endpoint = NexusShared.NexusEndpoint.resolved
        let url = endpoint.baseURL
            .appendingPathComponent("health")
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return [:]
        }
        comps.queryItems = [URLQueryItem(name: "detail", value: "true")]
        guard let final = comps.url else { return [:] }
        var req = URLRequest(url: final)
        req.timeoutInterval = 5
        do {
            let (data, _) = try await URLSession.shared.data(for: req)
            if let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
                return json
            }
        } catch {
            return ["error": "\(error)"]
        }
        return [:]
    }
}

/// Traffic-light bucket for a "last tick" age. Thresholds per spec scenarios.
enum StalenessIndicator {
    case green
    case yellow
    case red

    static func bucket(ageSeconds: TimeInterval) -> StalenessIndicator {
        if ageSeconds < 30 { return .green }
        if ageSeconds < 120 { return .yellow }
        return .red
    }

    var color: Color {
        switch self {
        case .green:  return .green
        case .yellow: return .yellow
        case .red:    return .red
        }
    }
}

@MainActor
final class SettingsDiagnosticsViewModel: ObservableObject {
    @Published var healthDetail: [String: Any] = [:]
    @Published var lastFetch: Date?
    @Published var agentsCount: Int = 0
    @Published var showingCopyConfirmation: Bool = false
    @Published var pendingPayload: String = ""
    @Published var toastMessage: String?

    let fetcher: DiagnosticsFetcher

    init(fetcher: DiagnosticsFetcher = DefaultDiagnosticsFetcher()) {
        self.fetcher = fetcher
    }

    func refresh() async {
        healthDetail = await fetcher.fetchHealthDetail()
        lastFetch = Date()
        agentsCount = (try? AgentsConfigStore.read())?.count ?? 0
    }

    // MARK: - Field extraction

    /// `last_health_snapshot_at` from /health?detail=true if present.
    /// Falls back to the fetch timestamp so the UI still renders.
    var lastSnapshotDate: Date? {
        Self.dateField(in: healthDetail, keys: ["last_snapshot_at", "collected_at", "ts"])
            ?? lastFetch
    }

    var lastWatcherDate: Date? {
        Self.dateField(in: healthDetail, keys: ["last_watcher_tick_at", "watcher_at"])
            ?? lastSnapshotDate
    }

    var socketSpineListening: Bool {
        (healthDetail["socket_listening"] as? Bool) ?? (healthDetail["socket"] as? Bool) ?? false
    }

    var dbOk: Bool {
        (healthDetail["db_ok"] as? Bool) ?? false
    }

    var agentBuildSHA: String? {
        healthDetail["build_sha"] as? String ?? healthDetail["agent_sha"] as? String
    }

    var dashboardBuildSHA: String? {
        let info = Bundle.main.infoDictionary
        if let sha = info?["GitSha"] as? String, !sha.isEmpty { return sha }
        return info?["CFBundleShortVersionString"] as? String
    }

    static func dateField(in dict: [String: Any], keys: [String]) -> Date? {
        for key in keys {
            if let s = dict[key] as? String {
                let f1 = ISO8601DateFormatter()
                f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                if let d = f1.date(from: s) { return d }
                let f2 = ISO8601DateFormatter()
                f2.formatOptions = [.withInternetDateTime]
                if let d = f2.date(from: s) { return d }
            } else if let n = dict[key] as? Double {
                return n > 1_000_000_000_000
                    ? Date(timeIntervalSince1970: n / 1000)
                    : Date(timeIntervalSince1970: n)
            }
        }
        return nil
    }

    static func formatAge(_ seconds: TimeInterval) -> String {
        if seconds < 60 { return "\(Int(seconds))s ago" }
        if seconds < 3600 {
            let m = Int(seconds) / 60
            let s = Int(seconds) % 60
            return "\(m)m \(s)s ago"
        }
        let h = Int(seconds) / 3600
        let m = (Int(seconds) % 3600) / 60
        return "\(h)h \(m)m ago"
    }

    // MARK: - Copy

    /// Build the plain-text payload exactly as it would be copied. Pure
    /// function so tests can pin the format independent of clipboard IO.
    func buildPayload(now: Date = Date()) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        var lines: [String] = []
        lines.append("nexus diagnostics — \(iso.string(from: now))")
        lines.append("")
        if let snap = lastSnapshotDate {
            let age = now.timeIntervalSince(snap)
            lines.append("last_snapshot     : \(iso.string(from: snap)) (\(Self.formatAge(age)))")
        } else {
            lines.append("last_snapshot     : (none)")
        }
        if let w = lastWatcherDate {
            let age = now.timeIntervalSince(w)
            lines.append("last_watcher_tick : \(iso.string(from: w)) (\(Self.formatAge(age)))")
        } else {
            lines.append("last_watcher_tick : (none)")
        }
        lines.append("socket_listening  : \(socketSpineListening)")
        lines.append("db_ok             : \(dbOk)")
        lines.append("agents_count      : \(agentsCount)")
        lines.append("dashboard_sha     : \(dashboardBuildSHA ?? "unknown")")
        lines.append("agent_sha         : \(agentBuildSHA ?? "unknown")")
        return lines.joined(separator: "\n") + "\n"
    }

    /// Prepare a copy attempt — stages the payload and arms the dialog.
    /// The dialog's Copy button calls `confirmCopy()`.
    func requestCopy() {
        pendingPayload = buildPayload()
        showingCopyConfirmation = true
    }

    /// User confirmed — write the staged payload to the system pasteboard.
    /// Test seam: `pasteboardWriter` defaults to NSPasteboard.general but
    /// tests can swap in a stub via the @MainActor-isolated property.
    var pasteboardWriter: (String) -> Void = { value in
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }

    func confirmCopy() {
        pasteboardWriter(pendingPayload)
        showingCopyConfirmation = false
        toastMessage = "Diagnostics copied to clipboard"
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            toastMessage = nil
        }
    }

    func cancelCopy() {
        showingCopyConfirmation = false
        pendingPayload = ""
    }
}

struct SettingsDiagnosticsView: View {
    @StateObject private var model = SettingsDiagnosticsViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text("Diagnostics").font(.title3).bold()
                    Spacer()
                    Button {
                        Task { await model.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Refresh")
                }

                snapshotRow(label: "Last health snapshot", date: model.lastSnapshotDate)
                snapshotRow(label: "Last watcher tick", date: model.lastWatcherDate)
                booleanRow(label: "Socket spine listening", on: model.socketSpineListening)
                booleanRow(label: "DB ok", on: model.dbOk)
                LabeledContent("agents.toml entries", value: "\(model.agentsCount)")
                LabeledContent("Dashboard SHA", value: model.dashboardBuildSHA ?? "unknown")
                LabeledContent("Agent SHA", value: model.agentBuildSHA ?? "unknown")

                Button("Copy diagnostics to clipboard") {
                    model.requestCopy()
                }

                if let toast = model.toastMessage {
                    Text(toast)
                        .font(.caption)
                        .foregroundStyle(.green)
                }
                Spacer(minLength: 12)
            }
            .padding(20)
        }
        .task {
            await model.refresh()
        }
        .confirmationDialog(
            "Copy diagnostics to clipboard?",
            isPresented: $model.showingCopyConfirmation,
            titleVisibility: .visible
        ) {
            Button("Copy") {
                model.confirmCopy()
            }
            Button("Cancel", role: .cancel) {
                model.cancelCopy()
            }
        } message: {
            Text(model.pendingPayload)
        }
    }

    @ViewBuilder
    private func snapshotRow(label: String, date: Date?) -> some View {
        HStack {
            if let date {
                let age = Date().timeIntervalSince(date)
                Circle()
                    .fill(StalenessIndicator.bucket(ageSeconds: age).color)
                    .frame(width: 8, height: 8)
                Text(label)
                Spacer()
                Text(SettingsDiagnosticsViewModel.formatAge(age))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            } else {
                Circle()
                    .fill(Color.gray)
                    .frame(width: 8, height: 8)
                Text(label)
                Spacer()
                Text("none").font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func booleanRow(label: String, on: Bool) -> some View {
        HStack {
            Circle()
                .fill(on ? Color.green : Color.red)
                .frame(width: 8, height: 8)
            Text(label)
            Spacer()
            Text(on ? "yes" : "no").font(.caption.monospaced()).foregroundStyle(.secondary)
        }
    }
}
