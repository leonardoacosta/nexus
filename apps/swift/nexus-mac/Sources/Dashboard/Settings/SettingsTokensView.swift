// SettingsTokensView — per-device bearer-token overrides for the mx homelab
// sidecars + ingest (meds :8802, plaid control :8801, health ingest :8798).
//
// These tokens default to the build-time values seeded from the gitignored
// Secrets.xcconfig (see SettingsStore.medsToken / .plaidControlToken /
// .healthIngestToken — UserDefaults override wins, else the Info.plist value).
// This pane lets a device set an explicit override without a rebuild; leaving
// a field empty clears the override and reverts to the build default.
//
// Distinct from CredentialsView (agent API-key usage) — this pane only edits
// the sidecar/ingest Bearer tokens SettingsStore feeds NexusClient+Meds /
// NexusClient+Plaid / HealthKitPushManager.

import SwiftUI
import NexusShared

@MainActor
final class SettingsTokensViewModel: ObservableObject {
    @Published var medsToken: String
    @Published var plaidControlToken: String
    @Published var healthIngestToken: String
    @Published var savedConfirmation: Bool = false

    private let store: SettingsStore

    init(store: SettingsStore = .shared) {
        self.store = store
        medsToken = store.medsToken ?? ""
        plaidControlToken = store.plaidControlToken ?? ""
        healthIngestToken = store.healthIngestToken ?? ""
    }

    /// Persist the fields. An empty field clears the override (nil) so the
    /// getter falls back to the build-time Info.plist default.
    func save() {
        store.medsToken = medsToken.isEmpty ? nil : medsToken
        store.plaidControlToken = plaidControlToken.isEmpty ? nil : plaidControlToken
        store.healthIngestToken = healthIngestToken.isEmpty ? nil : healthIngestToken
        savedConfirmation = true
    }
}

struct SettingsTokensView: View {
    @StateObject private var model = SettingsTokensViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Access Tokens").font(.title3).bold()

                Text("Bearer tokens for the mx homelab sidecars. Leave a field blank to use the build-time default seeded from Secrets.xcconfig.")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                tokenField(
                    label: "Meds sidecar (:8802)",
                    text: $model.medsToken,
                    id: "settings.tokens.meds"
                )
                tokenField(
                    label: "Plaid control (:8801)",
                    text: $model.plaidControlToken,
                    id: "settings.tokens.plaid"
                )
                tokenField(
                    label: "Health ingest (:8798)",
                    text: $model.healthIngestToken,
                    id: "settings.tokens.health"
                )

                Button("Save tokens") {
                    model.save()
                }
                .accessibilityIdentifier("settings.tokens.save")

                if model.savedConfirmation {
                    Text("Tokens saved")
                        .font(.caption)
                        .foregroundStyle(.green)
                }

                Spacer(minLength: 12)
            }
            .padding(20)
        }
        .accessibilityIdentifier("settings.tokens.view")
    }

    @ViewBuilder
    private func tokenField(label: String, text: Binding<String>, id: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.subheadline)
            SecureField("Bearer token", text: text)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier(id)
        }
    }
}
