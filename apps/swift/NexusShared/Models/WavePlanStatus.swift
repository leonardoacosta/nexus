// WavePlanStatus — Codable mirror of the agent's GET /wave-plans/active row.
//
// Spec: openspec/changes/specs-tab-accordion-with-topology (task 2.1)
//
// Source of truth: apps/agent/src/routes/wave-plans.ts (`WavePlanPayload`
// + `SpecStatusWire`). Wire shape uses camelCase end-to-end. The agent
// projects the on-disk wave-plan.json onto this shape and normalizes
// every per-spec status onto the canonical `SpecRunStatus` enum below
// (legacy aliases `pending` / `done` / `merged` / `error` are collapsed
// agent-side; Swift only sees the canonical variants).
//
// Empty-state contract: when no /apply is active the agent returns
// `{ runId: null, planName: null, status: null, currentWave: null,
//    currentPhase: null, specStatuses: [] }`. We decode that as a
// fully-populated `WavePlanStatus` with `isActive == false` so callers
// can distinguish "fetched, no active run" from "fetch failed" (nil).
//
// Malformed-state contract: when wave-plan.json fails to parse the
// agent surfaces an `error` field alongside the empty payload. We keep
// it as an Optional string so the dashboard can show a degraded chip
// without forcing a separate error type.

import Foundation

/// Canonical per-spec status enum mirrored end-to-end with the agent's
/// `WavePlanWireStatus` type. Underlying raw values are snake_case to
/// match the wire (`in_progress`).
public enum SpecRunStatus: String, Codable, CaseIterable, Sendable, Hashable {
    case queued
    case dispatched
    case in_progress
    case completed
    case failed
    case skipped
}

/// One row of the flattened wave-plan: one spec, its wave number, its
/// canonical status, and the optional /apply phase classification it
/// landed in (`P1`, `API`, `UI`, `E2E`, …).
public struct SpecStatus: Equatable, Hashable, Codable, Sendable {
    public var name: String
    public var wave: Int
    public var status: SpecRunStatus
    public var phase: String?
    public var dispatchedAt: Date?

    public enum CodingKeys: String, CodingKey {
        case name
        case wave
        case status
        case phase
        case dispatchedAt
    }

    public init(
        name: String,
        wave: Int = 0,
        status: SpecRunStatus = .queued,
        phase: String? = nil,
        dispatchedAt: Date? = nil
    ) {
        self.name = name
        self.wave = wave
        self.status = status
        self.phase = phase
        self.dispatchedAt = dispatchedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.name   = try c.decode(String.self, forKey: .name)
        self.wave   = try c.decodeIfPresent(Int.self, forKey: .wave) ?? 0
        self.status = try c.decodeIfPresent(SpecRunStatus.self, forKey: .status) ?? .queued
        let phaseRaw = try c.decodeIfPresent(String.self, forKey: .phase)
        self.phase  = (phaseRaw?.isEmpty ?? true) ? nil : phaseRaw
        if let s = try c.decodeIfPresent(String.self, forKey: .dispatchedAt) {
            let f1 = ISO8601DateFormatter()
            f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let f2 = ISO8601DateFormatter()
            f2.formatOptions = [.withInternetDateTime]
            self.dispatchedAt = f1.date(from: s) ?? f2.date(from: s)
        } else {
            self.dispatchedAt = nil
        }
    }
}

/// Top-level payload returned by `GET /wave-plans/active`. Every field
/// except `specStatuses` is optional because the empty-state contract
/// emits explicit nulls.
public struct WavePlanStatus: Equatable, Hashable, Codable, Sendable {
    public var runId: String?
    public var planName: String?
    public var status: String?
    public var currentWave: Int?
    public var currentPhase: String?
    public var specStatuses: [SpecStatus]
    /// Present ONLY when the agent could not parse wave-plan.json. Lets
    /// the dashboard surface a degraded chip without a separate type.
    public var error: String?

    public enum CodingKeys: String, CodingKey {
        case runId
        case planName
        case status
        case currentWave
        case currentPhase
        case specStatuses
        case error
    }

    public init(
        runId: String? = nil,
        planName: String? = nil,
        status: String? = nil,
        currentWave: Int? = nil,
        currentPhase: String? = nil,
        specStatuses: [SpecStatus] = [],
        error: String? = nil
    ) {
        self.runId = runId
        self.planName = planName
        self.status = status
        self.currentWave = currentWave
        self.currentPhase = currentPhase
        self.specStatuses = specStatuses
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.runId         = try c.decodeIfPresent(String.self, forKey: .runId)
        self.planName      = try c.decodeIfPresent(String.self, forKey: .planName)
        self.status        = try c.decodeIfPresent(String.self, forKey: .status)
        self.currentWave   = try c.decodeIfPresent(Int.self, forKey: .currentWave)
        self.currentPhase  = try c.decodeIfPresent(String.self, forKey: .currentPhase)
        self.specStatuses  = try c.decodeIfPresent([SpecStatus].self, forKey: .specStatuses) ?? []
        self.error         = try c.decodeIfPresent(String.self, forKey: .error)
    }

    /// True iff the agent reports an active /apply run with at least one
    /// dispatched spec. The empty-state payload (runId nil, specStatuses
    /// empty) reads as `false`, which is what every chip-rendering path
    /// keys on to stay hidden when nothing is in flight.
    public var isActive: Bool {
        runId != nil && !specStatuses.isEmpty
    }

    /// Lookup a per-spec row by `name`. Used by the per-row enrichment
    /// in SpecsView — O(N) is fine because wave plans rarely exceed a
    /// dozen rows.
    public func lookupSpec(name: String) -> SpecStatus? {
        specStatuses.first { $0.name == name }
    }
}
