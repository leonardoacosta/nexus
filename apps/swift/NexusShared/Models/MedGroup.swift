// MedGroup + meds DTOs — wire models for the mx meds CRUD sidecar (port 8802).
//
// Capability: src-meds (mx-t66o). mx OWNS the data; these structs mirror the
// EXACT snake_case JSON shapes served by the homelab meds sidecar. They follow
// the tolerant-decoder convention (WireDecode helpers, camel+snake aliases) so
// a wire rename or a missing optional degrades gracefully instead of throwing.
//
// Beads: mx-jc0k (NexusClient meds helpers + DTOs).
//
// Base URL = http://<homelab-host>:8802 (see NexusClient+Meds.swift for the
// host derivation off NexusEndpoint.resolved). All structs are `public` so the
// iOS scenes in nexus-ios can consume them across the framework boundary.

import Foundation

// MARK: - Group + member

/// A dynamic, mergeable time-of-day group (e.g. "Morning", "Bedtime").
public struct MedGroup: Identifiable, Equatable, Hashable, Sendable, Decodable {
    public var id: String
    public var name: String
    /// Optional "HH:mm" schedule string (drives APNS reminders, decision e).
    public var scheduledTime: String?
    public var sortOrder: Int
    public var members: [MedGroupMember]
    public var createdAt: Date?
    public var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name
        case scheduledTime, scheduled_time
        case sortOrder, sort_order
        case members
        case createdAt, created_at
        case updatedAt, updated_at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = WireDecode.string(c, .id) ?? ""
        self.name = WireDecode.string(c, .name) ?? ""
        self.scheduledTime = WireDecode.nonEmpty(c, .scheduledTime, .scheduled_time)
        self.sortOrder = MedDecode.int(c, .sortOrder, .sort_order) ?? 0
        self.members = (try? c.decode([MedGroupMember].self, forKey: .members)) ?? []
        self.createdAt = WireDecode.date(c, .createdAt, .created_at)
        self.updatedAt = WireDecode.date(c, .updatedAt, .updated_at)
    }

    public init(
        id: String,
        name: String,
        scheduledTime: String? = nil,
        sortOrder: Int = 0,
        members: [MedGroupMember] = [],
        createdAt: Date? = nil,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.scheduledTime = scheduledTime
        self.sortOrder = sortOrder
        self.members = members
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// Members that WOULD be logged by a "take group" (not opted out).
    public var activeMembers: [MedGroupMember] { members.filter { !$0.optedOut } }
}

/// A med's membership in a group, with an optional per-group dose override.
public struct MedGroupMember: Identifiable, Equatable, Hashable, Sendable, Decodable {
    public var id: String
    public var groupId: String
    public var medId: String
    public var medName: String
    /// The med's standing default dose (from the medication definition).
    public var medDefault: String
    /// Per-group dose override; nil = use `medDefault`.
    public var doseOverride: String?
    /// The dose actually logged for this member (override ?? default).
    public var effectiveDose: String
    public var optedOut: Bool

    enum CodingKeys: String, CodingKey {
        case id
        case groupId, group_id
        case medId, med_id
        case medName, med_name
        case medDefault, med_default
        case doseOverride, dose_override
        case effectiveDose, effective_dose
        case optedOut, opted_out
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = WireDecode.string(c, .id) ?? ""
        self.groupId = WireDecode.string(c, .groupId, .group_id) ?? ""
        self.medId = WireDecode.string(c, .medId, .med_id) ?? ""
        self.medName = WireDecode.string(c, .medName, .med_name) ?? ""
        self.medDefault = WireDecode.string(c, .medDefault, .med_default) ?? ""
        self.doseOverride = WireDecode.nonEmpty(c, .doseOverride, .dose_override)
        self.effectiveDose = WireDecode.string(c, .effectiveDose, .effective_dose)
            ?? (doseOverride ?? medDefault)
        self.optedOut = WireDecode.bool(c, .optedOut, .opted_out)
    }

    public init(
        id: String,
        groupId: String,
        medId: String,
        medName: String,
        medDefault: String,
        doseOverride: String? = nil,
        effectiveDose: String,
        optedOut: Bool = false
    ) {
        self.id = id
        self.groupId = groupId
        self.medId = medId
        self.medName = medName
        self.medDefault = medDefault
        self.doseOverride = doseOverride
        self.effectiveDose = effectiveDose
        self.optedOut = optedOut
    }
}

// MARK: - Dose (history logbook)

/// One appended dose event in the History feed.
public struct MedDose: Identifiable, Equatable, Hashable, Sendable, Decodable {
    public var id: String
    public var medId: String
    public var medName: String?
    public var groupId: String?
    public var groupName: String?
    public var loggedAt: Date?
    public var scheduledAt: Date?
    /// "taken" | "skipped" | "missed".
    public var status: String
    public var dose: String
    /// "nx" | "healthkit" | ...
    public var source: String
    public var hkDoseUuid: String?

    enum CodingKeys: String, CodingKey {
        case id
        case medId, med_id
        case medName, med_name
        case groupId, group_id
        case groupName, group_name
        case loggedAt, logged_at
        case scheduledAt, scheduled_at
        case status, dose, source
        case hkDoseUuid, hk_dose_uuid
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = WireDecode.string(c, .id) ?? ""
        self.medId = WireDecode.string(c, .medId, .med_id) ?? ""
        self.medName = WireDecode.nonEmpty(c, .medName, .med_name)
        self.groupId = WireDecode.nonEmpty(c, .groupId, .group_id)
        self.groupName = WireDecode.nonEmpty(c, .groupName, .group_name)
        self.loggedAt = WireDecode.date(c, .loggedAt, .logged_at)
        self.scheduledAt = WireDecode.date(c, .scheduledAt, .scheduled_at)
        self.status = WireDecode.string(c, .status) ?? "taken"
        self.dose = WireDecode.string(c, .dose) ?? ""
        self.source = WireDecode.string(c, .source) ?? ""
        self.hkDoseUuid = WireDecode.nonEmpty(c, .hkDoseUuid, .hk_dose_uuid)
    }

    public init(
        id: String,
        medId: String,
        medName: String? = nil,
        groupId: String? = nil,
        groupName: String? = nil,
        loggedAt: Date? = nil,
        scheduledAt: Date? = nil,
        status: String,
        dose: String,
        source: String = "nx",
        hkDoseUuid: String? = nil
    ) {
        self.id = id
        self.medId = medId
        self.medName = medName
        self.groupId = groupId
        self.groupName = groupName
        self.loggedAt = loggedAt
        self.scheduledAt = scheduledAt
        self.status = status
        self.dose = dose
        self.source = source
        self.hkDoseUuid = hkDoseUuid
    }

    public var isTaken: Bool { status.lowercased() == "taken" }
    public var isSkipped: Bool { status.lowercased() == "skipped" }
    public var isMissed: Bool { status.lowercased() == "missed" }
}

// MARK: - Adherence (the MAIN triage surface)

/// Per-group taken/skipped/missed counts over a window — the actionable
/// "misses" signal is `missed`.
public struct MedAdherence: Identifiable, Equatable, Hashable, Sendable, Decodable {
    public var groupId: String
    public var groupName: String
    public var scheduled: Int
    public var taken: Int
    public var skipped: Int
    public var missed: Int
    public var windowStart: Date?
    public var windowEnd: Date?

    public var id: String { groupId }

    enum CodingKeys: String, CodingKey {
        case groupId, group_id
        case groupName, group_name
        case scheduled, taken, skipped, missed
        case windowStart, window_start
        case windowEnd, window_end
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.groupId = WireDecode.string(c, .groupId, .group_id) ?? ""
        self.groupName = WireDecode.string(c, .groupName, .group_name) ?? ""
        self.scheduled = MedDecode.int(c, .scheduled) ?? 0
        self.taken = MedDecode.int(c, .taken) ?? 0
        self.skipped = MedDecode.int(c, .skipped) ?? 0
        self.missed = MedDecode.int(c, .missed) ?? 0
        self.windowStart = WireDecode.date(c, .windowStart, .window_start)
        self.windowEnd = WireDecode.date(c, .windowEnd, .window_end)
    }

    public init(
        groupId: String,
        groupName: String,
        scheduled: Int,
        taken: Int,
        skipped: Int,
        missed: Int,
        windowStart: Date? = nil,
        windowEnd: Date? = nil
    ) {
        self.groupId = groupId
        self.groupName = groupName
        self.scheduled = scheduled
        self.taken = taken
        self.skipped = skipped
        self.missed = missed
        self.windowStart = windowStart
        self.windowEnd = windowEnd
    }

    /// Adherence rate as a fraction in [0, 1] (taken / scheduled).
    public var rate: Double {
        scheduled > 0 ? Double(taken) / Double(scheduled) : 0
    }

    /// True when this group has at least one missed dose (drives the red rail).
    public var hasMisses: Bool { missed > 0 }
}

// MARK: - Medication definition

/// A med/supplement definition (the add-med form, decision a, writes one).
public struct Medication: Identifiable, Equatable, Hashable, Sendable, Decodable {
    public var id: String
    public var name: String
    public var defaultDose: String
    public var unit: String
    public var rxnorm: String?
    public var hkMedId: String?
    public var archived: Bool
    public var createdAt: Date?
    public var updatedAt: Date?

    enum CodingKeys: String, CodingKey {
        case id, name
        case defaultDose, default_dose
        case unit, rxnorm
        case hkMedId, hk_med_id
        case archived
        case createdAt, created_at
        case updatedAt, updated_at
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.id = WireDecode.string(c, .id) ?? ""
        self.name = WireDecode.string(c, .name) ?? ""
        self.defaultDose = WireDecode.string(c, .defaultDose, .default_dose) ?? ""
        self.unit = WireDecode.string(c, .unit) ?? ""
        self.rxnorm = WireDecode.nonEmpty(c, .rxnorm)
        self.hkMedId = WireDecode.nonEmpty(c, .hkMedId, .hk_med_id)
        self.archived = WireDecode.bool(c, .archived)
        self.createdAt = WireDecode.date(c, .createdAt, .created_at)
        self.updatedAt = WireDecode.date(c, .updatedAt, .updated_at)
    }

    public init(
        id: String,
        name: String,
        defaultDose: String,
        unit: String,
        rxnorm: String? = nil,
        hkMedId: String? = nil,
        archived: Bool = false,
        createdAt: Date? = nil,
        updatedAt: Date? = nil
    ) {
        self.id = id
        self.name = name
        self.defaultDose = defaultDose
        self.unit = unit
        self.rxnorm = rxnorm
        self.hkMedId = hkMedId
        self.archived = archived
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// MARK: - Response envelopes

struct MedGroupsResponse: Decodable { let groups: [MedGroup] }
struct MedGroupResponse: Decodable { let group: MedGroup }
struct MedMemberResponse: Decodable { let member: MedGroupMember }
struct MedDosesResponse: Decodable { let doses: [MedDose] }
struct MedAdherenceResponse: Decodable { let adherence: [MedAdherence] }
struct MedicationsResponse: Decodable { let medications: [Medication] }
struct MedicationResponse: Decodable { let medication: Medication }

/// `GET /meds/groups/last` envelope — `{found, last:{group, due_unlogged}}`.
public struct MedLastGroup: Equatable, Sendable, Decodable {
    public var found: Bool
    public var group: MedGroup?
    public var dueUnlogged: Bool

    enum TopKeys: String, CodingKey { case found, last }
    enum LastKeys: String, CodingKey {
        case group
        case dueUnlogged, due_unlogged
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: TopKeys.self)
        self.found = (try? c.decode(Bool.self, forKey: .found)) ?? false
        if let last = try? c.nestedContainer(keyedBy: LastKeys.self, forKey: .last) {
            self.group = try? last.decode(MedGroup.self, forKey: .group)
            self.dueUnlogged = (try? last.decode(Bool.self, forKey: .dueUnlogged))
                ?? (try? last.decode(Bool.self, forKey: .due_unlogged))
                ?? false
        } else {
            self.group = nil
            self.dueUnlogged = false
        }
    }

    public init(found: Bool, group: MedGroup?, dueUnlogged: Bool) {
        self.found = found
        self.group = group
        self.dueUnlogged = dueUnlogged
    }
}

// MARK: - Local int decode helper

/// Tolerant Int decode (accepts a JSON number that arrives as Double, mirroring
/// WireDecode's tolerance). WireDecode has no `int` arm, so this lives here.
enum MedDecode {
    static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ keys: K...) -> Int? {
        for key in keys {
            if let i = try? c.decode(Int.self, forKey: key) { return i }
            if let d = try? c.decode(Double.self, forKey: key) { return Int(d) }
        }
        return nil
    }
}
