// AgentRegistry — discover peer agents from ~/.config/nexus/agents.toml.
//
// Spec: nx-4ohfs (Swift-side multi-agent aggregation — replaces the deleted
// peer-connector federation, remove-peer-connector / d2e965e).
//
// The agents.toml shape is the entire contract here, so we hand-parse it
// rather than pull a TOML SPM dependency. The file is:
//
//     # comment
//     self_name   = "macbook"
//     role        = "primary"
//     bind_address = "0.0.0.0"
//
//     [[agents]]
//     name = "homelab"
//     host = "100.73.182.4"
//     port = 7400
//     user = "nyaptor"
//
//     [[agents]]
//     ...
//
// Only `[[agents]]` array-of-tables records carry endpoint info. Top-level
// scalars (self_name/role/bind_address) are ignored by the dashboard.
//
// Missing file -> [] (the dashboard degrades to localhost-only via
// NexusAggregateClient's fallback; it must not crash).

import Foundation

/// One reachable agent entry parsed from a `[[agents]]` table.
public struct AgentDescriptor: Sendable, Equatable {
    public let name: String
    public let host: String
    public let port: Int
    public let user: String?

    public init(name: String, host: String, port: Int, user: String? = nil) {
        self.name = name
        self.host = host
        self.port = port
        self.user = user
    }

    /// Endpoint for this agent. agents.toml is loopback/Tailnet only — no auth
    /// (dropped per drop-attach-secret-gate).
    public var endpoint: NexusEndpoint {
        NexusEndpoint(baseURL: URL(string: "http://\(host):\(port)")!)
    }
}

public enum AgentRegistry {
    /// Default path: ~/.config/nexus/agents.toml.
    public static var defaultPath: URL {
        #if os(macOS)
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/nexus/agents.toml")
        #else
        // iOS has no user home directory — `homeDirectoryForCurrentUser` is
        // unavailable. Fall back to Application Support (sandboxed); the file
        // typically won't exist there, so loadAgents() degrades to [] which
        // is the intended localhost-only behavior on mobile clients.
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("nexus/agents.toml")
        #endif
    }

    /// Parse `[[agents]]` records from agents.toml. Returns `[]` if the file
    /// is absent or unreadable — the dashboard degrades, it does not die.
    public static func loadAgents(path: URL? = nil) -> [AgentDescriptor] {
        let url = path ?? defaultPath
        guard let raw = try? String(contentsOf: url, encoding: .utf8) else {
            return []
        }
        return parse(raw)
    }

    /// Hand-rolled line parser. Only understands the agents.toml dialect:
    /// `#` comments, blank lines, `[[agents]]` to open a new record, and
    /// `key = "value"` / `key = 123` scalars within the active record.
    static func parse(_ contents: String) -> [AgentDescriptor] {
        var agents: [AgentDescriptor] = []
        var inAgent = false
        var name: String?
        var host: String?
        var port: Int?
        var user: String?

        func flush() {
            if let name, let host, let port {
                agents.append(AgentDescriptor(name: name, host: host, port: port, user: user))
            }
            name = nil; host = nil; port = nil; user = nil
        }

        for rawLine in contents.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") { continue }

            if line == "[[agents]]" {
                if inAgent { flush() }
                inAgent = true
                continue
            }
            // Any other table header (e.g. a future [section]) closes the
            // current agent record and stops scalar capture.
            if line.hasPrefix("[") {
                if inAgent { flush() }
                inAgent = false
                continue
            }
            guard inAgent, let eq = line.firstIndex(of: "=") else { continue }

            let key = line[..<eq].trimmingCharacters(in: .whitespaces)
            var value = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            // Strip a trailing inline comment outside of quotes.
            if !value.hasPrefix("\""), let hash = value.firstIndex(of: "#") {
                value = String(value[..<hash]).trimmingCharacters(in: .whitespaces)
            }
            // Unwrap surrounding double quotes if present.
            if value.hasPrefix("\"") && value.hasSuffix("\"") && value.count >= 2 {
                value = String(value.dropFirst().dropLast())
            }

            switch key {
            case "name": name = value
            case "host": host = value
            case "port": port = Int(value)
            case "user": user = value.isEmpty ? nil : value
            default: break
            }
        }
        if inAgent { flush() }
        return agents
    }
}
