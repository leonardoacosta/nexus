// CcProfileStatusView — read-only display of cc_profiles managed by the agent.
//
// Spec: openspec/changes/add-cc-credential-manager (task 1.6)
//
// The agent's cc-credential-manager exposes profile state via the existing
// /credentials/active endpoint plus a new /cc-profiles endpoint (to be wired
// in a follow-up). This view consumes the response as a passive observer —
// it never POSTs back. Swap and refresh decisions live in the agent.

import SwiftUI

struct CcProfile: Codable, Identifiable {
    let id: String
    let type: String         // "pro" | "max" | "api_key"
    let expiryTs: Date?
    let rateLimitStatus: String
    let accountEmail: String?
    let currentCostUsd: Double
}

struct CcProfileStatusView: View {
    @State private var profiles: [CcProfile] = []
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Claude Profiles")
                .font(.headline)
            if let error {
                Text(error).foregroundColor(.red).font(.caption)
            }
            if profiles.isEmpty {
                Text("No profiles observed yet").foregroundColor(.secondary)
            } else {
                ForEach(profiles) { profile in
                    HStack {
                        Image(systemName: statusIcon(profile.rateLimitStatus))
                            .foregroundColor(statusColor(profile.rateLimitStatus))
                        VStack(alignment: .leading) {
                            Text(profile.accountEmail ?? profile.id.prefix(8).description)
                                .font(.body)
                            HStack(spacing: 8) {
                                Text(profile.type.uppercased())
                                    .font(.caption2)
                                    .padding(.horizontal, 4)
                                    .background(Color.gray.opacity(0.2))
                                    .cornerRadius(3)
                                if let expiry = profile.expiryTs {
                                    Text("expires \(expiry, style: .relative)")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                        Spacer()
                        Text(String(format: "$%.2f", profile.currentCostUsd))
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                    Divider()
                }
            }
        }
        .task {
            await reload()
        }
    }

    private func statusIcon(_ status: String) -> String {
        switch status {
        case "rate_limited": return "exclamationmark.triangle.fill"
        case "warning": return "exclamationmark.circle"
        default: return "checkmark.circle.fill"
        }
    }

    private func statusColor(_ status: String) -> Color {
        switch status {
        case "rate_limited": return .red
        case "warning": return .orange
        default: return .green
        }
    }

    @MainActor
    private func reload() async {
        // Wired against the agent's /cc-profiles read-only endpoint. The
        // endpoint contract is owned by P4.6 follow-up; this view degrades
        // gracefully to "no profiles observed yet" when the endpoint is
        // absent or returns a non-2xx.
        guard let url = URL(string: "http://127.0.0.1:7400/cc-profiles") else { return }
        do {
            let (data, response) = try await URLSession.shared.data(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                self.profiles = []
                return
            }
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            self.profiles = try decoder.decode([CcProfile].self, from: data)
        } catch {
            self.error = String(describing: error)
        }
    }
}
