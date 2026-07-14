// MedsObserver — @MainActor ObservableObject backing the Meds tab.
//
// Capability: src-meds (mx-t66o). Beads: mx-jc0k + mx-ieau.
//
// Owns the meds-sidecar read state (adherence = the MAIN triage surface,
// groups = the manager, last-group = the "Take Last Group" hero, medications =
// the add-med catalog) plus the write actions (take/skip/CRUD/merge/adjust).
// Unlike TriageObserver, the meds endpoints are LIVE in mx, so a transport
// error surfaces as `.error` (not a sample fallback). Mutations refresh the
// affected slices on success.

import Foundation
import Combine

@MainActor
public final class MedsObserver: ObservableObject {
    public enum Phase: Equatable, Sendable {
        case loading
        case loaded
        case error(String)
    }

    // Read state.
    @Published public private(set) var adherence: [MedAdherence] = []
    @Published public private(set) var groups: [MedGroup] = []
    @Published public private(set) var lastGroup: MedLastGroup?
    @Published public private(set) var medications: [Medication] = []
    @Published public private(set) var history: [MedDose] = []
    @Published public private(set) var phase: Phase = .loading
    /// True while a write (take/skip/CRUD) is in flight — the view disables the
    /// hero button to prevent a double-tap double-log.
    @Published public private(set) var isMutating: Bool = false

    public let client: NexusClient

    private var pollTask: Task<Void, Never>?
    private let pollInterval: UInt64

    /// Window for the adherence query (default: last 7 days).
    private let adherenceWindow: TimeInterval

    nonisolated public init(
        client: NexusClient = NexusClient(),
        pollSeconds: UInt64 = 30,
        adherenceDays: Int = 7
    ) {
        self.client = client
        self.pollInterval = pollSeconds * 1_000_000_000
        self.adherenceWindow = TimeInterval(adherenceDays) * 86_400
    }

    // MARK: - Lifecycle

    public func startPolling() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in await self?.runPolling() }
    }

    public func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    private func runPolling() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: pollInterval)
        }
    }

    /// Refresh the landing surfaces (adherence + groups + last-group). History
    /// + medications load lazily from their own screens.
    public func refresh() async {
        let since = Date().addingTimeInterval(-adherenceWindow)
        do {
            async let adh = client.fetchMedAdherence(since: since)
            async let grp = client.fetchMedGroups()
            async let last = client.resolveLastGroup()
            self.adherence = try await adh
            self.groups = try await grp
            self.lastGroup = try await last
            self.phase = .loaded
        } catch {
            self.phase = .error(Self.describe(error))
        }
    }

    /// Load the medications catalog (for the add-member picker / add-med form).
    public func loadMedications(archived: Bool = false) async {
        if let meds = try? await client.fetchMedications(archived: archived) {
            self.medications = meds
        }
    }

    /// Load (or paginate) the History feed. Pass the oldest currently-loaded
    /// dose's `loggedAt` as `before` to append the next page.
    public func loadHistory(before: Date? = nil, limit: Int = 50) async {
        guard let page = try? await client.fetchMedHistory(limit: limit, before: before) else {
            return
        }
        if before == nil {
            self.history = page
        } else {
            self.history.append(contentsOf: page)
        }
    }

    // MARK: - Writes

    /// The hero action: resolve the due/unlogged group, then log it.
    /// Returns true on success. No-ops (returns false) when no group resolves.
    @discardableResult
    public func takeLastGroup() async -> Bool {
        await mutate {
            let resolved = try await self.client.resolveLastGroup()
            guard let group = resolved.group else { return false }
            _ = try await self.client.takeGroup(group.id)
            return true
        }
    }

    @discardableResult
    public func takeGroup(_ groupId: String) async -> Bool {
        await mutate {
            _ = try await self.client.takeGroup(groupId)
            return true
        }
    }

    @discardableResult
    public func skipGroup(_ groupId: String) async -> Bool {
        await mutate { _ = try await self.client.skipGroup(groupId); return true }
    }

    @discardableResult
    public func createGroup(name: String, scheduledTime: String?, sortOrder: Int) async -> Bool {
        await mutate {
            _ = try await self.client.createGroup(
                name: name, scheduledTime: scheduledTime, sortOrder: sortOrder)
            return true
        }
    }

    @discardableResult
    public func deleteGroup(_ groupId: String) async -> Bool {
        await mutate { try await self.client.deleteGroup(groupId); return true }
    }

    @discardableResult
    public func mergeGroups(into intoId: String, from fromId: String) async -> Bool {
        await mutate {
            try await self.client.mergeGroups(into: intoId, from: fromId)
            return true
        }
    }

    @discardableResult
    public func addMember(
        groupId: String, medId: String, doseOverride: String?, optedOut: Bool
    ) async -> Bool {
        await mutate {
            _ = try await self.client.addMember(
                groupId: groupId, medId: medId,
                doseOverride: doseOverride, optedOut: optedOut)
            return true
        }
    }

    @discardableResult
    public func setMemberOptedOut(_ memberId: String, optedOut: Bool) async -> Bool {
        await mutate {
            try await self.client.updateMember(
                memberId, setOptedOut: true, optedOut: optedOut)
            return true
        }
    }

    @discardableResult
    public func setMemberDoseOverride(_ memberId: String, dose: String?) async -> Bool {
        await mutate {
            try await self.client.updateMember(
                memberId, setDoseOverride: true, doseOverride: dose)
            return true
        }
    }

    @discardableResult
    public func removeMember(_ memberId: String) async -> Bool {
        await mutate { try await self.client.removeMember(memberId); return true }
    }

    @discardableResult
    public func createMedication(
        name: String, defaultDose: String, unit: String, rxnorm: String?
    ) async -> Medication? {
        let result: Medication?
        isMutating = true
        defer { isMutating = false }
        do {
            result = try await client.createMedication(
                name: name, defaultDose: defaultDose, unit: unit, rxnorm: rxnorm)
            await loadMedications()
        } catch {
            phase = .error(Self.describe(error))
            return nil
        }
        return result
    }

    /// Long-press path (decision d): update the standing default dose.
    @discardableResult
    public func updateMedicationDefaultDose(_ medId: String, dose: String) async -> Bool {
        await mutate {
            try await self.client.updateMedicationDefaultDose(medId, dose: dose)
            return true
        }
    }

    // MARK: - Helpers

    /// Run a write, toggle `isMutating`, refresh the landing surfaces on
    /// success, and fold a throw into `.error`. Returns the closure's bool
    /// (false on throw).
    private func mutate(_ body: @escaping () async throws -> Bool) async -> Bool {
        isMutating = true
        defer { isMutating = false }
        do {
            let ok = try await body()
            if ok { await refresh() }
            return ok
        } catch {
            phase = .error(Self.describe(error))
            return false
        }
    }

    private static func describe(_ error: Error) -> String {
        switch error {
        case NexusClientError.badStatus(let code): return "Server error (\(code))"
        case NexusClientError.decoding: return "Could not read the response"
        case NexusClientError.transport: return "Couldn't reach the meds service"
        default: return "Something went wrong"
        }
    }

    #if DEBUG
    /// Preview seam — set the read state without hitting the network.
    public func setForPreview(
        adherence: [MedAdherence] = [],
        groups: [MedGroup] = [],
        lastGroup: MedLastGroup? = nil,
        medications: [Medication] = [],
        history: [MedDose] = [],
        phase: Phase = .loaded
    ) {
        self.adherence = adherence
        self.groups = groups
        self.lastGroup = lastGroup
        self.medications = medications
        self.history = history
        self.phase = phase
    }
    #endif
}
