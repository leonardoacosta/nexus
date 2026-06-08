// CommsMessage — one message off the on-demand conversation thread endpoint
// (`GET {agent}/thread?source=<src>&id=<coreId>`), oldest -> newest.
//
// Spec: mx-rkir.1 STAGE 3 — the comms-detail redesign + conversation thread.
// Backend: mesh `/thread` (Stage 1, deployed). Teams is live; other sources
// light up as Stage 2 lands — this model renders ANY source's messages.
//
// WIRE SHAPE: `{ "author": "...", "author_handle": "...", "text": "...",
// "ts": "2026-06-08T18:29:29Z", "self": true }`. `author_handle` is optional;
// `self` is a reserved Swift keyword so it maps to the `isSelf` property.
// `ts` is permissive (ISO8601 fractional / no-fraction / numeric epoch s|ms),
// cloning the HealthSnapshot.swift / TriageItem.swift convention.

import Foundation

public struct CommsMessage: Identifiable, Equatable, Hashable, Codable, Sendable {
    /// Display name of the message author.
    public var author: String
    /// Raw handle (email / UPN / login) when the source supplies one. Optional.
    public var authorHandle: String?
    /// Message body text.
    public var text: String
    /// Timestamp (RFC3339). nil when absent/unparseable.
    public var ts: Date?
    /// True when the message is from the local user (renders trailing / blue).
    public var isSelf: Bool

    /// Stable per-row id (no server id on the wire) — author + ts + text hash.
    public var id: String {
        let stamp = ts.map { String(Int($0.timeIntervalSince1970)) } ?? "—"
        return "\(author)|\(stamp)|\(text.hashValue)"
    }

    public enum CodingKeys: String, CodingKey {
        case author
        case authorHandle = "author_handle"
        case text
        case ts
        case isSelf = "self"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.author = (try? c.decode(String.self, forKey: .author)) ?? ""
        self.authorHandle = try? c.decodeIfPresent(String.self, forKey: .authorHandle)
        self.text = (try? c.decode(String.self, forKey: .text)) ?? ""
        if let s = try? c.decode(String.self, forKey: .ts), !s.isEmpty {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.ts = f1.date(from: s) ?? f2.date(from: s)
        } else if let n = try? c.decode(Double.self, forKey: .ts) {
            self.ts = n > 1_000_000_000_000
                ? Date(timeIntervalSince1970: n / 1000)
                : Date(timeIntervalSince1970: n)
        } else {
            self.ts = nil
        }
        self.isSelf = (try? c.decode(Bool.self, forKey: .isSelf)) ?? false
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(author, forKey: .author)
        try c.encodeIfPresent(authorHandle, forKey: .authorHandle)
        try c.encode(text, forKey: .text)
        if let ts {
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime]
            try c.encode(f.string(from: ts), forKey: .ts)
        }
        try c.encode(isSelf, forKey: .isSelf)
    }

    public init(
        author: String,
        authorHandle: String? = nil,
        text: String,
        ts: Date? = nil,
        isSelf: Bool = false
    ) {
        self.author = author
        self.authorHandle = authorHandle
        self.text = text
        self.ts = ts
        self.isSelf = isSelf
    }
}
