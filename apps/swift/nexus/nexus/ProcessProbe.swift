//
//  ProcessProbe.swift
//  nexus
//
//  Fallback path **B** for real-Claude-Code session discovery. The agent's
//  `/sessions` table is currently a sea of telemetry-ping stubs that lack
//  the discriminator fields (`pid`, `tmuxTarget`, `ccSessionId`, `cwd`).
//  Until `fix-agent-cc-session-tracking` lands, we SSH to homelab and run
//  `pgrep -af claude` to enumerate the real CC processes directly.
//
//  Probe results are surfaced as synthetic `NexusSession` rows via
//  `NexusSession.fromProbe(...)`. The synthetic ID is namespaced
//  `probe-<host>-<pid>` so they cannot collide with agent-issued rows.
//
//  Cadence: only runs when the agent path returns zero CC-fingerprinted
//  rows AND the panel is open. Cached for 10 s to avoid SSH spam.
//

import Foundation

actor ProcessProbe {
    static let shared = ProcessProbe()

    private var lastProbedAt: Date?
    private var cachedSessions: [NexusSession] = []
    private let cacheTTL: TimeInterval = 10
    private let host = "homelab"
    private let user = "nyaptor"

    /// Run `ssh <user>@<host> pgrep -af claude` and parse output into
    /// synthetic sessions. Returns the cached value if within TTL.
    func probeHomelab() async -> [NexusSession] {
        if let t = lastProbedAt, Date().timeIntervalSince(t) < cacheTTL {
            return cachedSessions
        }
        let lines = await runSSH()
        let rows: [NexusSession] = lines.compactMap { line in
            // Format: "<pid> <command line>"
            let parts = line.split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
            guard parts.count == 2, let pid = Int(parts[0]) else { return nil }
            let cmd = String(parts[1])
            // Filter to the actual `claude` binary — drop helper procs (mcp/zsh).
            guard cmd.hasPrefix("claude") || cmd.contains("/claude ") || cmd == "claude"
            else { return nil }
            return NexusSession.fromProbe(pid: pid, command: cmd, host: host, project: nil)
        }
        cachedSessions = rows
        lastProbedAt = Date()
        return rows
    }

    private func runSSH() async -> [String] {
        await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async { [user, host] in
                let task = Process()
                task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
                task.arguments = [
                    "-o", "ConnectTimeout=3",
                    "-o", "BatchMode=yes",
                    "\(user)@\(host)",
                    "pgrep -af claude"
                ]
                let pipe = Pipe()
                task.standardOutput = pipe
                task.standardError = Pipe() // discard
                do {
                    try task.run()
                    task.waitUntilExit()
                } catch {
                    continuation.resume(returning: [])
                    return
                }
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                let text = String(data: data, encoding: .utf8) ?? ""
                let lines = text.split(separator: "\n").map { String($0) }
                continuation.resume(returning: lines)
            }
        }
    }
}
