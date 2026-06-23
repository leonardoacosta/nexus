// HealthKitSettingsView — on-device controls for the HealthKit push producer.
//
// Presented as a sheet from HealthMetricsScene's toolbar. Exposes:
//   - "Resync Full History": clears ALL per-target HealthKit anchors and
//     kicks off a full flushAll() so ap (and mx when it returns) receive the
//     complete HealthKit history. Both backends dedup, so re-pushing is safe.
//
// Design: a single-section Form with a destructive-style button and a plain
// explanatory footer. No external dependencies beyond SwiftUI + HealthKit actor.

import SwiftUI

@available(iOS 15.0, *)
struct HealthKitSettingsView: View {
    @Environment(\.dismiss) private var dismiss

    @State private var isResyncing = false
    @State private var resyncComplete = false
    @State private var errorMessage: String? = nil

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button(role: .destructive) {
                        triggerResync()
                    } label: {
                        HStack {
                            Text(isResyncing ? "Resyncing..." : "Resync Full History")
                            Spacer()
                            if isResyncing {
                                ProgressView()
                            } else if resyncComplete {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(.green)
                            }
                        }
                    }
                    .disabled(isResyncing)
                    .accessibilityIdentifier("healthkit-resync-button")
                } header: {
                    Text("HealthKit Push")
                } footer: {
                    Text(footerText)
                        .font(.caption)
                }

                if let msg = errorMessage {
                    Section {
                        Label(msg, systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.red)
                            .font(.caption)
                            .accessibilityIdentifier("healthkit-resync-error")
                    }
                }
            }
            .navigationTitle("HealthKit Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("healthkit-settings-done")
                }
            }
        }
    }

    private var footerText: String {
        if resyncComplete {
            return "Anchors cleared. The full HealthKit history will be pushed to all configured targets on the next flush. Both ap and mx deduplicate by stable key, so re-pushing is safe."
        }
        return "Clears all per-target push anchors and re-queues the full HealthKit history. Use this when ap or mx is missing historical data. Both backends deduplicate, so re-pushing is safe even if data already exists."
    }

    private func triggerResync() {
        isResyncing = true
        resyncComplete = false
        errorMessage = nil
        Task {
            // Clear anchors on the actor, then kick a full flush.
            await HealthKitPushManager.shared.resetAllAnchors()
            await HealthKitPushManager.shared.flushAll()
            await MainActor.run {
                isResyncing = false
                resyncComplete = true
            }
        }
    }
}

#if DEBUG
@available(iOS 15.0, *)
#Preview("HealthKit Settings") {
    HealthKitSettingsView()
}
#endif
