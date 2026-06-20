// FleetPresence — wire model for `GET /presence/fleet`.
//
// Spec: openspec/changes/cross-machine-delivery (Phase 1.6),
// requirement "Fleet Presence Dashboard Indicator".
//
// The agent route (apps/agent/src/routes/presence-fleet.ts) returns:
//
//   {
//     "machines": [ <fleet_presence row>, ... ],
//     "liveConsole": "<resolved live-console machine>",
//     "localMachine": "<this agent's machine name>"
//   }
//
// Each fleet_presence row is a drizzle `$inferSelect` value serialized via
// JSON.stringify, so the keys are the schema's CAMELCASE property names
// (`onConsole` / `macActive` / `macLocked` / `heartbeat` / `updatedAt`),
// NOT the snake_case column names. `heartbeat` / `updatedAt` arrive as ISO
// strings (drizzle `mode: "date"` -> Date -> JSON ISO8601). Decoding is
// permissive (clone of HealthSnapshot.swift): unknown / missing dates fall
// back gracefully so a partial row never aborts the whole response decode.

import Foundation

/// One `fleet_presence` row (one per machine).
public struct FleetMachine: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var machine: String
    public var onConsole: Bool
    public var macActive: Bool?
    public var macLocked: Bool?
    public var heartbeat: Date?
    public var updatedAt: Date?

    /// `machine` is the table's primary key — use it as the identity.
    public var id: String { machine }

    public enum CodingKeys: String, CodingKey {
        case machine
        case onConsole
        case macActive
        case macLocked
        case heartbeat
        case updatedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.machine = (try? c.decode(String.self, forKey: .machine)) ?? ""
        self.onConsole = (try? c.decode(Bool.self, forKey: .onConsole)) ?? false
        self.macActive = (try? c.decodeIfPresent(Bool.self, forKey: .macActive)) ?? nil
        self.macLocked = (try? c.decodeIfPresent(Bool.self, forKey: .macLocked)) ?? nil
        self.heartbeat = Self.decodeFlexibleDate(c, forKey: .heartbeat)
        self.updatedAt = Self.decodeFlexibleDate(c, forKey: .updatedAt)
    }

    public init(
        machine: String,
        onConsole: Bool,
        macActive: Bool? = nil,
        macLocked: Bool? = nil,
        heartbeat: Date? = nil,
        updatedAt: Date? = nil
    ) {
        self.machine = machine
        self.onConsole = onConsole
        self.macActive = macActive
        self.macLocked = macLocked
        self.heartbeat = heartbeat
        self.updatedAt = updatedAt
    }

    /// Permissive date decode: ISO8601 (with/without fractional seconds) or a
    /// numeric epoch (s / ms). Missing or unparseable -> nil.
    private static func decodeFlexibleDate(
        _ c: KeyedDecodingContainer<CodingKeys>,
        forKey key: CodingKeys
    ) -> Date? {
        if let s = (try? c.decodeIfPresent(String.self, forKey: key)) ?? nil {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            return f1.date(from: s) ?? f2.date(from: s)
        }
        if let n = (try? c.decodeIfPresent(Double.self, forKey: key)) ?? nil {
            return n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
                : Date(timeIntervalSince1970: n)
        }
        return nil
    }
}

/// Envelope for `GET /presence/fleet`.
public struct FleetPresenceResponse: Equatable, Hashable, Codable, Sendable {
    public var machines: [FleetMachine]
    public var liveConsole: String
    public var localMachine: String

    public enum CodingKeys: String, CodingKey {
        case machines
        case liveConsole
        case localMachine
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.machines = (try? c.decode([FleetMachine].self, forKey: .machines)) ?? []
        self.liveConsole = (try? c.decode(String.self, forKey: .liveConsole)) ?? ""
        self.localMachine = (try? c.decode(String.self, forKey: .localMachine)) ?? ""
    }

    public init(
        machines: [FleetMachine],
        liveConsole: String,
        localMachine: String
    ) {
        self.machines = machines
        self.liveConsole = liveConsole
        self.localMachine = localMachine
    }
}
