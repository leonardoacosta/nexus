// NexusClient+Meds — typed HTTP client for the mx meds CRUD sidecar (port 8802).
//
// Capability: src-meds (mx-t66o). Beads: mx-jc0k.
//
// The meds sidecar is a SEPARATE homelab service from the agent API (:7400).
// The phone reaches it directly over the Tailnet. We derive the homelab HOST
// from `NexusEndpoint.resolved.baseURL` and build URLs against
// `http://<host>:<medsPort>` (default 8802). Both the port and the entire base
// URL are overridable via SettingsStore (`medsPort` / `medsBaseURL`), mirroring
// the dashboard-endpoint override. Auth is an optional bearer token
// (`SettingsStore.medsToken`); absent it, no header (tailnet-trust).
//
// The core NexusClient's `getJSON` / `session` / `decoder` are `private`, so
// this extension carries its OWN lightweight transport (mirroring the
// getJSON / JSONSerialization-POST patterns + NexusClientError handling) rather
// than reaching into the actor's private state.

import Foundation

extension NexusClient {

    // MARK: - Base URL derivation

    /// Resolve the meds sidecar base URL. Order:
    ///   1) `SettingsStore.medsBaseURL` (full override) if parseable.
    ///   2) Host of `NexusEndpoint.resolved.baseURL` + `:medsPort` over http.
    ///   3) `http://localhost:<medsPort>` fallback.
    public static func medsBaseURL() -> URL {
        let store = SettingsStore.shared
        if let raw = store.medsBaseURL, !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        let port = store.medsPort
        let host = NexusEndpoint.resolved.baseURL.host ?? "localhost"
        return URL(string: "http://\(host):\(port)")
            ?? URL(string: "http://localhost:\(port)")!
    }

    private func medsURL(_ path: String, query: [URLQueryItem] = []) -> URL {
        let base = Self.medsBaseURL()
        var comps = URLComponents(
            url: base.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty { comps?.queryItems = query }
        return comps?.url ?? base.appendingPathComponent(path)
    }

    // MARK: - Transport (self-contained; mirrors core getJSON / POST)

    private func medsSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 30
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }

    private func medsAuth(_ req: inout URLRequest) {
        if let token = SettingsStore.shared.medsToken, !token.isEmpty {
            req.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func medsGet<T: Decodable>(_ url: URL) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        medsAuth(&req)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await medsSession().data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    /// POST JSON, decode the response into `T`.
    private func medsPost<T: Decodable>(
        _ url: URL,
        body: [String: Any] = [:]
    ) async throws -> T {
        let data = try await medsPostRaw(url, body: body)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    /// POST JSON, ignore the decoded body (used for `{"ok":true}` endpoints).
    @discardableResult
    private func medsPostOK(_ url: URL, body: [String: Any] = [:]) async throws -> Data {
        try await medsPostRaw(url, body: body)
    }

    private func medsPostRaw(_ url: URL, body: [String: Any]) async throws -> Data {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        medsAuth(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await medsSession().data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        return data
    }

    // MARK: - Reads (GET)

    /// `GET /meds/groups` -> `{groups:[...]}`.
    public func fetchMedGroups() async throws -> [MedGroup] {
        let env: MedGroupsResponse = try await medsGet(medsURL("meds/groups"))
        return env.groups
    }

    /// `GET /meds/groups/last?now=<rfc3339?>` — the most-recent DUE & unlogged
    /// group (decision b), powering the "Take Last Group" button.
    public func resolveLastGroup(now: Date? = nil) async throws -> MedLastGroup {
        var q: [URLQueryItem] = []
        if let now { q.append(URLQueryItem(name: "now", value: Self.rfc3339(now))) }
        return try await medsGet(medsURL("meds/groups/last", query: q))
    }

    /// `GET /meds/history?limit=&before=<rfc3339>` — the per-dose logbook,
    /// reverse-chronological, paginated via `before`.
    public func fetchMedHistory(
        limit: Int = 50,
        before: Date? = nil
    ) async throws -> [MedDose] {
        var q = [URLQueryItem(name: "limit", value: String(limit))]
        if let before { q.append(URLQueryItem(name: "before", value: Self.rfc3339(before))) }
        let env: MedDosesResponse = try await medsGet(medsURL("meds/history", query: q))
        return env.doses
    }

    /// `GET /meds/adherence?since=<rfc3339>` — per-group taken/skipped/missed.
    public func fetchMedAdherence(since: Date? = nil) async throws -> [MedAdherence] {
        var q: [URLQueryItem] = []
        if let since { q.append(URLQueryItem(name: "since", value: Self.rfc3339(since))) }
        let env: MedAdherenceResponse = try await medsGet(medsURL("meds/adherence", query: q))
        return env.adherence
    }

    /// `GET /meds/medications?archived=` — med definitions.
    public func fetchMedications(archived: Bool = false) async throws -> [Medication] {
        let q = [URLQueryItem(name: "archived", value: archived ? "true" : "false")]
        let env: MedicationsResponse = try await medsGet(medsURL("meds/medications", query: q))
        return env.medications
    }

    // MARK: - Group writes (POST)

    /// `POST /meds/groups/{id}/take` -> appended doses (logs all non-opted-out
    /// members in one tap).
    @discardableResult
    public func takeGroup(_ groupId: String) async throws -> [MedDose] {
        let env: MedDosesResponse = try await medsPost(
            medsURL("meds/groups/\(groupId)/take"))
        return env.doses
    }

    /// `POST /meds/groups/{id}/skip` -> appended (skipped) doses.
    @discardableResult
    public func skipGroup(_ groupId: String) async throws -> [MedDose] {
        let env: MedDosesResponse = try await medsPost(
            medsURL("meds/groups/\(groupId)/skip"))
        return env.doses
    }

    /// `POST /meds/groups` -> the created group.
    @discardableResult
    public func createGroup(
        name: String,
        scheduledTime: String? = nil,
        sortOrder: Int = 0
    ) async throws -> MedGroup {
        var body: [String: Any] = ["name": name, "sort_order": sortOrder]
        if let scheduledTime { body["scheduled_time"] = scheduledTime }
        let env: MedGroupResponse = try await medsPost(medsURL("meds/groups"), body: body)
        return env.group
    }

    /// `POST /meds/groups/{id}` — rename and/or set/clear the schedule.
    /// `setScheduledTime=true` with a nil `scheduledTime` CLEARS the schedule.
    public func updateGroup(
        _ groupId: String,
        name: String? = nil,
        setScheduledTime: Bool = false,
        scheduledTime: String? = nil
    ) async throws {
        var body: [String: Any] = ["set_scheduled_time": setScheduledTime]
        if let name { body["name"] = name }
        if let scheduledTime { body["scheduled_time"] = scheduledTime }
        try await medsPostOK(medsURL("meds/groups/\(groupId)"), body: body)
    }

    /// `POST /meds/groups/{id}/delete`.
    public func deleteGroup(_ groupId: String) async throws {
        try await medsPostOK(medsURL("meds/groups/\(groupId)/delete"))
    }

    /// `POST /meds/groups/merge` body `{into_id, from_id}` (decision c).
    public func mergeGroups(into intoId: String, from fromId: String) async throws {
        try await medsPostOK(
            medsURL("meds/groups/merge"),
            body: ["into_id": intoId, "from_id": fromId])
    }

    // MARK: - Member writes (POST)

    /// `POST /meds/groups/{id}/members` -> the created member.
    @discardableResult
    public func addMember(
        groupId: String,
        medId: String,
        doseOverride: String? = nil,
        optedOut: Bool = false
    ) async throws -> MedGroupMember {
        var body: [String: Any] = ["med_id": medId, "opted_out": optedOut]
        if let doseOverride { body["dose_override"] = doseOverride }
        let env: MedMemberResponse = try await medsPost(
            medsURL("meds/groups/\(groupId)/members"), body: body)
        return env.member
    }

    /// `POST /meds/members/{id}` — set/clear dose override (decision d, the
    /// long-press standing-override path is `updateMedicationDefaultDose`) and
    /// set the opted-out flag (per-med opt-out). The `set_*` flags gate which
    /// fields are applied so a partial update leaves the other field untouched.
    public func updateMember(
        _ memberId: String,
        setDoseOverride: Bool = false,
        doseOverride: String? = nil,
        setOptedOut: Bool = false,
        optedOut: Bool = false
    ) async throws {
        var body: [String: Any] = [
            "set_dose_override": setDoseOverride,
            "set_opted_out": setOptedOut,
            "opted_out": optedOut,
        ]
        if let doseOverride { body["dose_override"] = doseOverride }
        try await medsPostOK(medsURL("meds/members/\(memberId)"), body: body)
    }

    /// `POST /meds/members/{id}/delete`.
    public func removeMember(_ memberId: String) async throws {
        try await medsPostOK(medsURL("meds/members/\(memberId)/delete"))
    }

    // MARK: - Dose adjustment (POST)

    /// `POST /meds/doses/{id}/adjust-time` body `{logged_at}` — adjust time
    /// taken (the #1 per-med action, decision d / tap).
    public func adjustDoseTime(_ doseId: String, loggedAt: Date) async throws {
        try await medsPostOK(
            medsURL("meds/doses/\(doseId)/adjust-time"),
            body: ["logged_at": Self.rfc3339(loggedAt)])
    }

    /// `POST /meds/doses/{id}/adjust-dose` body `{dose}` — adjust THIS dose's
    /// amount (decision d / tap; the standing default is a separate call).
    public func adjustDoseAmount(_ doseId: String, dose: String) async throws {
        try await medsPostOK(
            medsURL("meds/doses/\(doseId)/adjust-dose"),
            body: ["dose": dose])
    }

    // MARK: - Medication writes (POST)

    /// `POST /meds/medications` -> the created med (the add-med form,
    /// decision a).
    @discardableResult
    public func createMedication(
        name: String,
        defaultDose: String,
        unit: String,
        rxnorm: String? = nil,
        hkMedId: String? = nil
    ) async throws -> Medication {
        var body: [String: Any] = [
            "name": name,
            "default_dose": defaultDose,
            "unit": unit,
        ]
        if let rxnorm { body["rxnorm"] = rxnorm }
        if let hkMedId { body["hk_med_id"] = hkMedId }
        let env: MedicationResponse = try await medsPost(
            medsURL("meds/medications"), body: body)
        return env.medication
    }

    /// `POST /meds/medications/{id}/default-dose` body `{dose}` — update the
    /// standing default dose (decision d, the long-press path).
    public func updateMedicationDefaultDose(_ medId: String, dose: String) async throws {
        try await medsPostOK(
            medsURL("meds/medications/\(medId)/default-dose"),
            body: ["dose": dose])
    }

    /// `POST /meds/medications/{id}/archive`.
    public func archiveMedication(_ medId: String) async throws {
        try await medsPostOK(medsURL("meds/medications/\(medId)/archive"))
    }

    // MARK: - Helpers

    /// RFC3339 with fractional seconds (matches the WireDecode date tolerance).
    static func rfc3339(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: date)
    }
}
