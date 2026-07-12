// NexusClient+Triage — the triage-ledger WRITE routes on the mx-gateway
// (mx triage-ledger design §4, bead mx-dmj1).
//
// Two POST routes let the viewer land a decision on an item so a later
// `/triage` fetch reflects it (via the gateway's request-time overlay):
//   • POST /triage/{id}/status  — body `{status, resolution?, bd_id?, comment?}`;
//                                 upserts the row, sets manual=true. Covers
//                                 done (RESOLVED) / open / archive / inbox / keep.
//   • POST /triage/{id}/snooze  — body `{until}` (RFC3339); sets snoozed_until.
// Both return the resulting `ledgerJSON` object, decoded to `LedgerEntry`.
//
// AUTH: the gateway fails CLOSED on every POST (design §4) — these carry the
// `MX_GATEWAY_TOKEN` bearer via `SettingsStore.shared.gatewayToken`, the same
// token the decide `/requests/{id}/decision` route now requires. When no token
// is configured the header is omitted and the gateway 401s (surfaced as
// `NexusClientError.badStatus(401)`) — the app still builds/runs, reads work.
//
// Like NexusClient+Decision / NexusClient+Meds, this extension carries its OWN
// lightweight transport (the core `getJSON` / `session` / `decoder` are private)
// and resolves URLs against THIS client instance's `endpoint.baseURL` so the
// iOS / watch injected endpoints work.

import Foundation

extension NexusClient {

    // MARK: - Transport (self-contained; mirrors NexusClient+Decision)

    private func triageSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 30
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }

    /// Attach the mx-gateway bearer when configured; omit it otherwise (the
    /// gateway 401s a token-less write rather than the app failing to run).
    private func triageAuth(_ req: inout URLRequest) {
        if let token = SettingsStore.shared.gatewayToken, !token.isEmpty {
            req.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    /// RFC3339 (internet date-time) formatter for the snooze `until` field.
    private static let rfc3339: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    /// POST JSON to a gateway triage route and decode the returned `ledgerJSON`.
    /// NOT fail-soft: transport failure -> `.transport`, non-2xx -> `.badStatus`,
    /// a bad body -> `.decoding` (a silently-dropped write would desync the UI).
    private func triagePost(_ url: URL, body: [String: Any]) async throws -> LedgerEntry {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        triageAuth(&req)
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await triageSession().data(for: req)
        } catch {
            throw NexusClientError.transport(error)
        }
        guard let http = response as? HTTPURLResponse else {
            throw NexusClientError.badStatus(0)
        }
        guard (200...299).contains(http.statusCode) else {
            throw NexusClientError.badStatus(http.statusCode)
        }
        do {
            return try JSONDecoder().decode(LedgerEntry.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    private func triageURL(id: String, action: String) -> URL {
        let escaped = id.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? id
        return endpoint.baseURL
            .appendingPathComponent("triage")
            .appendingPathComponent(escaped)
            .appendingPathComponent(action)
    }

    // MARK: - Triage-ledger writes

    /// `POST /triage/{id}/status` — land a viewer status decision on an item.
    /// `status` is one of INBOX | OPEN | WAITING | RESOLVED | ARCHIVED. Optional
    /// `resolution` (close note), `bdId` (promoted-to-beads link), and `comment`
    /// ride the same body. Returns the resulting ledger row.
    @discardableResult
    public func postTriageStatus(
        id: String,
        status: String,
        resolution: String? = nil,
        bdId: String? = nil,
        comment: String? = nil
    ) async throws -> LedgerEntry {
        var body: [String: Any] = ["status": status]
        if let resolution, !resolution.isEmpty { body["resolution"] = resolution }
        if let bdId, !bdId.isEmpty { body["bd_id"] = bdId }
        if let comment, !comment.isEmpty { body["comment"] = comment }
        return try await triagePost(triageURL(id: id, action: "status"), body: body)
    }

    /// `POST /triage/{id}/snooze` — snooze an item until `until` (RFC3339 on the
    /// wire). Returns the resulting ledger row (`snoozedUntil` set).
    @discardableResult
    public func postTriageSnooze(
        id: String,
        until: Date
    ) async throws -> LedgerEntry {
        let body: [String: Any] = ["until": Self.rfc3339.string(from: until)]
        return try await triagePost(triageURL(id: id, action: "snooze"), body: body)
    }
}
