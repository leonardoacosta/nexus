// ApnsRegistrar — POST APNS device token to the agent for routing.
//
// Spec: openspec/changes/scaffold-nexus-ios-target (task 1.5)
//
// Scaffolding only. The agent-side `/apns/register` endpoint lands when
// bd:nx-gsgvk completes (Apple Developer provisioning + entitlement).

import Foundation
import NexusShared

actor ApnsRegistrar {
    static let shared = ApnsRegistrar()

    private var lastToken: String?

    func register(token: String) async {
        guard lastToken != token else { return }
        lastToken = token

        let endpoint: URL
        if let raw = Bundle.main.object(forInfoDictionaryKey: "NEXUS_ENDPOINT") as? String,
           let base = URL(string: raw) {
            endpoint = base.appendingPathComponent("apns/register")
        } else {
            endpoint = URL(string: "http://homelab:7400/apns/register")!
        }

        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "platform": "ios",
            "token": token,
            "bundleId": Bundle.main.bundleIdentifier ?? "dev.leonardoacosta.nexus.ios"
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
    }
}
