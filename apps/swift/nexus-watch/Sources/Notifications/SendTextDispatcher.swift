// SendTextDispatcher — POSTs the notification-action text to the agent.
//
// Spec: openspec/changes/scaffold-nexus-watch-target (task 1.5)
//
// Targets the agent endpoint added in task 1.2:
//   POST /commands/send-text { sessionId, text, appendNewline }

import Foundation
import NexusShared

actor SendTextDispatcher {
    static let shared = SendTextDispatcher()

    private let endpoint: URL = {
        if let raw = Bundle.main.object(forInfoDictionaryKey: "NEXUS_ENDPOINT") as? String,
           let base = URL(string: raw) {
            return base.appendingPathComponent("commands/send-text")
        }
        return URL(string: "http://homelab:7400/commands/send-text")!
    }()

    func send(sessionId: String, text: String, appendNewline: Bool = true) async {
        var req = URLRequest(url: endpoint)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        let body: [String: Any] = [
            "sessionId": sessionId,
            "text": text,
            "appendNewline": appendNewline,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        _ = try? await URLSession.shared.data(for: req)
    }
}
