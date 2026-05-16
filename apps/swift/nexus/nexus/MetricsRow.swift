//
//  MetricsRow.swift
//  nexus
//
//  Two side-by-side `Sparkline` charts for CPU + RAM, fed by
//  `viewModel.metrics`. Polls `/health/history?hours=0.167` on appear and
//  receives live deltas from `HomelabHeartbeat` SSE events.
//

import SwiftUI

struct MetricsRow: View {
    @EnvironmentObject private var vm: NexusViewModel

    var body: some View {
        HStack(spacing: 0) {
            metricCell(label: "CPU",
                       latest: latestCPU,
                       values: cpuSeries,
                       stale: isStale)
                .overlay(divider, alignment: .trailing)
            metricCell(label: "RAM",
                       latest: latestRAM,
                       values: ramSeries,
                       stale: isStale)
        }
        .overlay(
            Rectangle().fill(Color.nx.hairline).frame(height: 1),
            alignment: .bottom
        )
    }

    private var divider: some View {
        Rectangle().fill(Color.nx.hairline).frame(width: 1)
    }

    private var cpuSeries: [Double] {
        vm.metrics.map { $0.cpuPercent ?? 0 }
    }
    private var ramSeries: [Double] {
        vm.metrics.map { $0.ramPercent ?? 0 }
    }
    private var latestCPU: Double? {
        vm.metrics.last?.cpuPercent
    }
    private var latestRAM: Double? {
        vm.metrics.last?.ramPercent
    }
    private var isStale: Bool {
        vm.aggregateState == .stale || vm.aggregateState == .unreachable
    }

    @ViewBuilder
    private func metricCell(label: String, latest: Double?, values: [Double], stale: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                    .font(.jbm(9))
                    .tracking(1.6)
                    .foregroundStyle(Color.nx.ink4)
                Spacer()
                Text(latestLabel(latest))
                    .font(.jbm(14, weight: .semibold))
                    .foregroundStyle(valueColor(latest))
            }
            Sparkline(values: values,
                      stroke: strokeColor,
                      fill: vm.aggregateState == .idle ? NxGradient.muted : NxGradient.phosphor,
                      isStale: stale,
                      staleLabel: staleLabel)
                .frame(height: 32)
            HStack {
                Text("-10m").font(.jbm(8)).foregroundStyle(Color.nx.ink4)
                Spacer()
                Text("now").font(.jbm(8)).foregroundStyle(Color.nx.ink4)
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
    }

    private func latestLabel(_ v: Double?) -> String {
        guard let v = v else { return "—" }
        return String(format: "%.0f%%", v)
    }

    private func valueColor(_ v: Double?) -> Color {
        guard let v = v else { return Color.nx.ink3 }
        if v >= 90 { return Color.nx.critical }
        if v >= 70 { return Color.nx.amber }
        return Color.nx.phosphor
    }

    private var strokeColor: Color {
        switch vm.aggregateState {
        case .idle:        return Color.nx.ink3
        case .stale:       return Color.nx.amber
        case .unreachable: return Color.nx.critical
        case .active:      return Color.nx.phosphor
        }
    }

    private var staleLabel: String {
        guard let hb = vm.lastHeartbeat else { return "STALE" }
        let secs = Int(Date().timeIntervalSince(hb))
        let mm = secs / 60
        let ss = secs % 60
        return String(format: "STALE %02d:%02d", mm, ss)
    }
}
