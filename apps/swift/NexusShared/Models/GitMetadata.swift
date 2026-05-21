// GitMetadata — Codable mirror of the `git_metadata` field on
// `GET /projects` rows.
//
// Spec: openspec/changes/projects-tab-accordion-deeplink (task 1.3)
//
// Source of truth: packages/core/src/types/project.ts `GitMetadata`.
// Surfaced by the agent's `getGitMetadata(cwd)` extension (per-cwd
// 30s cache, 2s subprocess timeout). The outer field on
// `ProjectAggregate` is `gitMetadata: GitMetadata?`:
//   - Missing field   → nil (older agent that pre-dates this spec).
//   - JSON `null`     → nil (cwd is non-git, or subprocess failed).
//   - Non-nil object  → real value; `branch` may still be nil for a
//                       detached HEAD.
//
// `lastCommit.ts` decodes from ISO-8601 with fractional seconds AND
// without — git's `%aI` format emits without fractional seconds
// (e.g. `2026-05-21T18:00:00-05:00`). The decoder uses a static
// ISO8601DateFormatter so the parsing is independent of the
// JSONDecoder.dateDecodingStrategy callers configure.

import Foundation

public struct GitMetadata: Equatable, Hashable, Codable, Sendable {
    /// Branch name, or `nil` for detached HEAD. The outer optional on
    /// `ProjectAggregate.gitMetadata` distinguishes "no git" (nil) from
    /// "detached HEAD" (non-nil object with `branch == nil`).
    public let branch: String?
    public let ahead: Int
    public let behind: Int
    public let dirty: Bool
    public let lastCommit: Commit?

    public struct Commit: Equatable, Hashable, Codable, Sendable {
        public let author: String
        public let ts: Date

        public init(author: String, ts: Date) {
            self.author = author
            self.ts = ts
        }

        public enum CodingKeys: String, CodingKey {
            case author
            case ts
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            author = try c.decode(String.self, forKey: .author)
            let raw = try c.decode(String.self, forKey: .ts)
            ts = try GitMetadata.decodeISO8601(raw)
        }

        public func encode(to encoder: Encoder) throws {
            var c = encoder.container(keyedBy: CodingKeys.self)
            try c.encode(author, forKey: .author)
            try c.encode(GitMetadata.iso8601Formatter.string(from: ts),
                         forKey: .ts)
        }
    }

    public init(
        branch: String?,
        ahead: Int,
        behind: Int,
        dirty: Bool,
        lastCommit: Commit?
    ) {
        self.branch = branch
        self.ahead = ahead
        self.behind = behind
        self.dirty = dirty
        self.lastCommit = lastCommit
    }

    public enum CodingKeys: String, CodingKey {
        case branch
        case ahead
        case behind
        case dirty
        case lastCommit = "last_commit"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        branch = try c.decodeIfPresent(String.self, forKey: .branch)
        ahead = try c.decode(Int.self, forKey: .ahead)
        behind = try c.decode(Int.self, forKey: .behind)
        dirty = try c.decode(Bool.self, forKey: .dirty)
        lastCommit = try c.decodeIfPresent(Commit.self, forKey: .lastCommit)
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(branch, forKey: .branch)
        try c.encode(ahead, forKey: .ahead)
        try c.encode(behind, forKey: .behind)
        try c.encode(dirty, forKey: .dirty)
        try c.encode(lastCommit, forKey: .lastCommit)
    }

    // ── ISO-8601 decode helpers (offset + no-fraction tolerant) ─────────

    fileprivate static let iso8601Formatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    fileprivate static let iso8601FractionalFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    fileprivate static func decodeISO8601(_ raw: String) throws -> Date {
        if let d = iso8601Formatter.date(from: raw) { return d }
        if let d = iso8601FractionalFormatter.date(from: raw) { return d }
        throw DecodingError.dataCorrupted(
            DecodingError.Context(
                codingPath: [],
                debugDescription: "invalid ISO-8601 timestamp: \(raw)"
            )
        )
    }
}
