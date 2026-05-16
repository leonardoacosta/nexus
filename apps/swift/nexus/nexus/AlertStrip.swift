//
//  AlertStrip.swift
//  nexus
//
//  Renders an amber (recoverable) or critical (unreachable / 401) strip when
//  `viewModel.alert` is non-nil. Tucked between IdentityRow and MetricsRow.
//

import SwiftUI

struct AlertStrip: View {
    @EnvironmentObject private var vm: NexusViewModel

    var body: some View {
        if let alert = vm.alert {
            HStack(spacing: 10) {
                Image(systemName: alert.severity == .critical ? "exclamationmark.octagon.fill" : "exclamationmark.triangle.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(accentColor(for: alert.severity))
                Text(alert.body)
                    .font(.jbm(10))
                    .foregroundStyle(accentColor(for: alert.severity))
                Spacer()
                if let label = alert.actionLabel {
                    Button(label.uppercased()) {
                        // Action routing is owned by the view model; v1 just
                        // dismisses the strip when the user accepts.
                        Task { await vm.dispatchAlertAction(alert) }
                    }
                    .buttonStyle(.plain)
                    .font(.jbm(10, weight: .semibold))
                    .foregroundStyle(accentColor(for: alert.severity))
                    .underline()
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(stripBackground(for: alert.severity))
        }
    }

    private func accentColor(for severity: NexusAlert.Severity) -> Color {
        switch severity {
        case .amber:    return Color.nx.amber
        case .critical: return Color.nx.critical
        }
    }

    private func stripBackground(for severity: NexusAlert.Severity) -> some View {
        let tint: Color = (severity == .critical) ? Color.nx.critical : Color.nx.amber
        return tint.opacity(0.08)
            .overlay(Rectangle().stroke(tint.opacity(0.18), lineWidth: 1))
    }
}

extension NexusViewModel {
    /// Stub dispatcher — v1 resolves the alert by clearing it. Future revs
    /// will route to the actual remediation (re-auth, retry, etc.).
    func dispatchAlertAction(_ alert: NexusAlert) async {
        await client.setAlert(nil)
    }
}
