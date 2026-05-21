// HealthView — macOS dashboard parity for apps/nextjs/src/app/health.
//
// Spec: openspec/changes/swift-dashboard-feature-parity (task 1.9)
// bd:nx-gaquu
//
// Extended by openspec/changes/health-tab-process-view: a per-machine
// process table now renders below the CPU/RAM/Disk time series. The
// machine picker drives BOTH the time series AND the process table —
// switching machines clears the previous machine's processes within
// one render frame to prevent flashing stale data while the new fetch
// resolves.
//
// Auto-refresh: a background Task polls /health/processes every 5s
// while the view is on screen and cancels on disappear. Stale-snapshot
// grey-out kicks in when `collectedAt > 30s` old, with a
// `TimelineView`-driven caption that re-evaluates without re-fetching.

import SwiftUI
import Charts
import NexusShared

struct HealthView: View {
    @StateObject private var model = HealthViewModel()
    @State private var refreshTask: Task<Void, Never>? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            header
            if model.points.isEmpty && model.processes == nil {
                ContentUnavailableView(
                    "No health samples",
                    systemImage: "waveform.path.ecg",
                    description: Text(
                        model.isLoading
                            ? "Loading…"
                            : "Agent reachable but health_snapshots is empty for the selected window."
                    )
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        if !model.points.isEmpty {
                            chartsBlock
                        }
                        processesSection
                    }
                }
            }
        }
        .padding(.vertical, 8)
        .task {
            await model.loadAll()
            startAutoRefresh()
        }
        .onDisappear {
            refreshTask?.cancel()
            refreshTask = nil
        }
        .refreshable {
            await model.loadAll()
        }
    }

    private func startAutoRefresh() {
        refreshTask?.cancel()
        refreshTask = Task { [weak model] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5 * 1_000_000_000)
                if Task.isCancelled { return }
                await model?.loadProcesses()
            }
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            Text("HEALTH")
                .font(.system(.caption, design: .monospaced))
                .tracking(2)
                .foregroundStyle(.secondary)
            Picker("", selection: $model.windowMinutes) {
                Text("10m").tag(10)
                Text("1h").tag(60)
                Text("6h").tag(360)
                Text("24h").tag(1440)
            }
            .pickerStyle(.segmented)
            .frame(width: 240)
            .onChange(of: model.windowMinutes) { _, _ in
                Task { await model.loadAll() }
            }
            machinePicker
            Spacer()
            Text("\(model.points.count) pts")
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
            Button {
                Task { await model.loadAll() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .help("Refresh")
            .keyboardShortcut("r", modifiers: .command)
        }
        .padding(.horizontal, 14)
    }

    @ViewBuilder
    private var machinePicker: some View {
        if !model.knownMachines.isEmpty {
            Picker("", selection: $model.selectedMachine) {
                Text("All").tag(String?.none)
                ForEach(model.knownMachines, id: \.self) { name in
                    Text(name).tag(String?.some(name))
                }
            }
            .pickerStyle(.menu)
            .frame(minWidth: 120)
            .onChange(of: model.selectedMachine) { _, _ in
                // Clear stale processes IMMEDIATELY so the previous machine's
                // data doesn't flash while the new fetch resolves
                // (health-process-machine-selector-reuse scenario).
                model.clearProcessesForMachineSwitch()
                Task { await model.loadAll() }
            }
        }
    }

    private var chartsBlock: some View {
        VStack(alignment: .leading, spacing: 16) {
            HealthChart(
                title: "CPU",
                color: .red,
                points: model.points,
                value: { $0.cpuPercent }
            )
            HealthChart(
                title: "RAM",
                color: .blue,
                points: model.points,
                value: { $0.ramPercent }
            )
            HealthChart(
                title: "DISK",
                color: .orange,
                points: model.points,
                value: { $0.diskPercent }
            )
        }
        .padding(.horizontal, 14)
    }

    @ViewBuilder
    private var processesSection: some View {
        // Hide the section entirely when both lists are empty
        // (warming-up case, health-process-table-view §empty scenario).
        if let processes = model.processes,
           !(processes.topCpu.isEmpty && processes.topRam.isEmpty) {
            TimelineView(.periodic(from: .now, by: 1.0)) { context in
                let staleInfo = staleness(for: processes, at: context.date)
                ProcessTableView(
                    processes: processes,
                    isStale: staleInfo.isStale,
                    staleAgeLabel: staleInfo.label
                )
            }
        }
    }

    /// Returns whether the snapshot is older than the 30s threshold plus a
    /// human-readable age string. Delegates to `processSnapshotStaleness`
    /// so HealthView and the unit tests share one implementation.
    private func staleness(
        for processes: HealthProcessesResponse,
        at now: Date
    ) -> (isStale: Bool, label: String?) {
        processSnapshotStaleness(
            collectedAt: processes.collectedAt,
            now: now
        )
    }
}

private struct HealthChart: View {
    let title: String
    let color: Color
    let points: [HealthSnapshot]
    let value: (HealthSnapshot) -> Double?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(title)
                    .font(.system(.caption, design: .monospaced))
                    .tracking(1.5)
                    .foregroundStyle(.secondary)
                Spacer()
                if let latest = points.last, let v = value(latest) {
                    Text(String(format: "%.1f%%", v))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(color)
                }
            }
            Chart {
                ForEach(points.indices, id: \.self) { idx in
                    let p = points[idx]
                    if let v = value(p) {
                        LineMark(
                            x: .value("t", p.timestamp),
                            y: .value(title, v)
                        )
                        .foregroundStyle(color)
                        .interpolationMethod(.monotone)
                        AreaMark(
                            x: .value("t", p.timestamp),
                            y: .value(title, v)
                        )
                        .foregroundStyle(color.opacity(0.12))
                        .interpolationMethod(.monotone)
                    }
                }
            }
            .chartYScale(domain: 0...100)
            .chartYAxis {
                AxisMarks(values: [0, 50, 100]) { value in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                    AxisValueLabel {
                        if let n = value.as(Double.self) {
                            Text("\(Int(n))").font(.caption2)
                        }
                    }
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisGridLine().foregroundStyle(.secondary.opacity(0.2))
                    AxisValueLabel(format: .dateTime.hour().minute())
                }
            }
            .frame(height: 120)
        }
    }
}

@MainActor
final class HealthViewModel: ObservableObject {
    @Published var windowMinutes: Int = 60
    @Published private(set) var points: [HealthSnapshot] = []
    @Published private(set) var isLoading: Bool = false

    /// Latest process snapshot from `GET /health/processes`. `nil` until
    /// the first fetch resolves OR while a machine-switch is in flight.
    @Published private(set) var processes: HealthProcessesResponse? = nil

    /// User-selected machine; `nil` means "all" (aggregate across reachable
    /// agents). Drives both the time-series fan-out and the process fetch.
    @Published var selectedMachine: String? = nil

    /// Distinct machines seen in the most recent time-series response —
    /// used to populate the machine picker.
    @Published private(set) var knownMachines: [String] = []

    private let client = NexusShared.NexusAggregateClient()

    /// Single entry point so the header refresh / pull-down / window-change
    /// hit both endpoints in one task and keep them in sync.
    func loadAll() async {
        isLoading = true
        defer { isLoading = false }
        await loadSeries()
        await loadProcesses()
    }

    func loadSeries() async {
        let since = Date().addingTimeInterval(-Double(windowMinutes) * 60)
        let machineParam = selectedMachine ?? ""
        let rows = await client.fetchHealthSeries(machine: machineParam, since: since)
        points = rows.sorted { $0.timestamp < $1.timestamp }
        // Refresh the machine picker from the registry; this stays static
        // while the view is open (agents.toml rarely changes mid-session).
        if knownMachines.isEmpty {
            knownMachines = AgentRegistry.loadAgents().map(\.name).sorted()
        }
    }

    /// Fetch a fresh process snapshot for the currently-selected machine.
    /// Called by the auto-refresh task on a 5s cadence AND on machine
    /// switch (after the model has cleared the previous list).
    func loadProcesses() async {
        let snapshot = await client.fetchHealthProcesses(
            machine: selectedMachine,
            limit: 10
        )
        processes = snapshot
    }

    /// Invoked by the machine picker's `onChange` so the previous machine's
    /// process list disappears within one render frame instead of lingering
    /// behind the new fetch (health-process-machine-selector-reuse §switch
    /// scenario). The next `loadProcesses()` call repopulates.
    func clearProcessesForMachineSwitch() {
        processes = nil
    }

    /// Test-only seam — preset the processes property without going through
    /// the network. Used by ProcessTableViewTests to drive the
    /// machine-switch-clears invariant without spinning up a fake client.
    func setProcessesForTest(_ value: HealthProcessesResponse?) {
        processes = value
    }
}
