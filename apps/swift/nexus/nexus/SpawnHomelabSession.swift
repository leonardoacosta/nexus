//
//  SpawnHomelabSession.swift
//  nexus
//
//  Implementation for `⌃⌥H`: POST `/session/start`, then attach via the same
//  Ghostty launcher used by the ATTACH button.
//

import Foundation
import AppKit

enum SpawnHomelabSession {
    /// Returns the resolved tmux window name on success. Surfaces an alert via
    /// the view model on failure.
    @MainActor
    static func run(viewModel: NexusViewModel) async {
        let target = viewModel.spawnTarget
        let url = NexusEndpoint.baseURL.appendingPathComponent("session/start")
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "project": target.code,
            "path": target.path
        ])

        let response: (Data, URLResponse)?
        do {
            response = try await URLSession.shared.data(for: req)
        } catch {
            await viewModel.client.setAlert(
                NexusAlert(severity: .critical,
                           body: "Spawn failed: \(error.localizedDescription)",
                           actionLabel: "DISMISS", actionKey: "dismiss")
            )
            return
        }

        guard let (data, http) = response,
              let httpResp = http as? HTTPURLResponse,
              (200...299).contains(httpResp.statusCode) else {
            await viewModel.client.setAlert(
                NexusAlert(severity: .critical,
                           body: "homelab refused spawn",
                           actionLabel: "DISMISS", actionKey: "dismiss")
            )
            return
        }

        struct StartResponse: Decodable { let session_name: String; let started: Bool? }
        guard let body = try? JSONDecoder().decode(StartResponse.self, from: data),
              body.started != false else {
            await viewModel.client.setAlert(
                NexusAlert(severity: .amber,
                           body: "spawn ok but no session id returned",
                           actionLabel: nil, actionKey: nil)
            )
            return
        }

        // The agent's tmux window name == sessionName == `<project>-<ts>`.
        do {
            try GhosttyLauncher.attach(window: body.session_name)
        } catch {
            await viewModel.client.setAlert(
                NexusAlert(severity: .critical,
                           body: "Ghostty.app not found at /Applications/Ghostty.app",
                           actionLabel: "OPEN APP STORE", actionKey: "open-app-store")
            )
        }
    }
}
