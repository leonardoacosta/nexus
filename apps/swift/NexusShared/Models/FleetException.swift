// FleetException — Codable mirror of one `GET /exceptions` row.
//
// Spec: openspec/changes/add-fleet-exceptions-feed (task 2.1)
//
// Wire contract (apps/agent — commit 60ec7ab4):
//   GET /exceptions -> FleetExceptionEntry[]   (a BARE JSON array; clean
//   fleet = `[]`, no envelope — silent-when-clean).
//   interface FleetExceptionEntry {
//     repo: string        // e.g. "nx"
//     class: FleetExceptionClass
//     count: number
//     offenders: string[] // worst-first, capped at 3 server-side
//   }
//
// `class` is a Swift keyword, so it maps to `exceptionClass` via CodingKeys.
// Decoding is unknown-tolerant (an unrecognised class folds to `.unknown`,
// missing scalars degrade to sensible defaults) so a server-side extension
// never hard-fails the menubar section. Foundation only — cross-platform so
// iOS/watch can adopt without a wire change.

import Foundation

/// `FleetExceptionEntry.class` — the exception taxonomy. Unknown-tolerant:
/// an unrecognised wire string decodes to `.unknown`.
public enum FleetExceptionClass: String, Codable, Sendable, CaseIterable, Hashable {
    case p0Open            = "p0_open"
    case p1Open            = "p1_open"
    case inProgressStale   = "in_progress_stale"
    case readyHeadStale    = "ready_head_stale"
    case unarchivedChanges = "unarchived_changes"
    case unknown           = "unknown"

    /// Tolerant construction from the raw wire value.
    public init(wire raw: String?) {
        guard let raw, !raw.isEmpty else { self = .unknown; return }
        self = FleetExceptionClass(rawValue: raw) ?? .unknown
    }

    public init(from decoder: Decoder) throws {
        self = FleetExceptionClass(
            wire: try? decoder.singleValueContainer().decode(String.self)
        )
    }

    /// Short uppercase label for the menubar text line.
    public var label: String {
        switch self {
        case .p0Open:            return "P0 OPEN"
        case .p1Open:            return "P1 OPEN"
        case .inProgressStale:   return "IN-PROGRESS STALE"
        case .readyHeadStale:    return "READY-HEAD STALE"
        case .unarchivedChanges: return "UNARCHIVED"
        case .unknown:           return "UNKNOWN"
        }
    }
}

/// One `GET /exceptions` row: a (repo, class) pairing with a count and the
/// worst-first offender ids (already capped at 3 server-side).
public struct FleetException: Identifiable, Equatable, Hashable, Codable, Sendable {
    public var repo: String
    public var exceptionClass: FleetExceptionClass
    public var count: Int
    public var offenders: [String]

    /// Stable identity across renders — one row per (repo, class).
    public var id: String { "\(repo)/\(exceptionClass.rawValue)" }

    public enum CodingKeys: String, CodingKey {
        case repo
        case exceptionClass = "class"
        case count
        case offenders
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.repo = (try? c.decode(String.self, forKey: .repo)) ?? ""
        self.exceptionClass =
            (try? c.decode(FleetExceptionClass.self, forKey: .exceptionClass)) ?? .unknown
        self.count = (try? c.decode(Int.self, forKey: .count)) ?? 0
        self.offenders = (try? c.decode([String].self, forKey: .offenders)) ?? []
    }

    public init(
        repo: String,
        exceptionClass: FleetExceptionClass,
        count: Int,
        offenders: [String]
    ) {
        self.repo = repo
        self.exceptionClass = exceptionClass
        self.count = count
        self.offenders = offenders
    }
}
