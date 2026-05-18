// HealthSnapshot — one sample from `GET /health/history?hours=N`.
//
// Spec: openspec/changes/add-nexus-shared-framework (task 1.2)
//
// Source of truth: apps/agent/src/routes/health-history.ts. Renamed from
// HealthPoint (nexus-mac's pre-NexusShared name) to better reflect that
// each row IS a point-in-time snapshot of the host's resource state.

import Foundation

public struct HealthSnapshot: Equatable, Hashable, Codable, Sendable {
    public var timestamp: Date
    public var cpuPercent: Double?
    public var ramPercent: Double?
    public var diskPercent: Double?

    public enum CodingKeys: String, CodingKey {
        case timestamp
        case cpuPercent  = "cpu_percent"
        case ramPercent  = "ram_percent"
        case diskPercent = "disk_percent"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = try? c.decode(String.self, forKey: .timestamp) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.timestamp = f1.date(from: s) ?? f2.date(from: s) ?? Date()
        } else if let n = try? c.decode(Double.self, forKey: .timestamp) {
            self.timestamp = n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
                : Date(timeIntervalSince1970: n)
        } else {
            self.timestamp = Date()
        }
        self.cpuPercent  = try c.decodeIfPresent(Double.self, forKey: .cpuPercent)
        self.ramPercent  = try c.decodeIfPresent(Double.self, forKey: .ramPercent)
        self.diskPercent = try c.decodeIfPresent(Double.self, forKey: .diskPercent)
    }

    public init(
        timestamp: Date,
        cpuPercent: Double? = nil,
        ramPercent: Double? = nil,
        diskPercent: Double? = nil
    ) {
        self.timestamp = timestamp
        self.cpuPercent = cpuPercent
        self.ramPercent = ramPercent
        self.diskPercent = diskPercent
    }
}
