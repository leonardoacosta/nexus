// NexusClient+Decision — decide-flow endpoints on the agent's mx-gateway
// passthroughs (openspec/changes/add-decide-flow-menubar).
//
// Two agent routes back the macOS menubar decide pilot:
//   • GET  /queue        — the ranked verdict-bearing batch (fail-soft empty-200:
//                          a gateway-down / 404 / empty body all resolve to `[]`
//                          so the popover renders "queue unavailable", never spins).
//   • GET  /queue/head   — a single-item fallback session when the batch endpoint
//                          hasn't landed (mx add-queue-batch); same card mechanics.
//   • POST /requests/{id}/decision — the write-back. NOT fail-soft: a 409 (no live
//                          verdict / already decided) surfaces as the typed
//                          `DecideError.alreadyDecided`; other non-2xx propagate as
//                          `.badStatus`; transport failure as `.transport`. A
//                          swallowed decision is silent pilot-data loss (design §Agent).
//
// The core NexusClient's `getJSON` / `session` / `decoder` are `private`, so this
// extension carries its OWN lightweight transport (mirroring NexusClient+Meds)
// rather than reaching into the actor's private state. It resolves URLs against
// THIS client instance's `endpoint.baseURL` so iOS/watch injected endpoints work.

import Foundation

/// Typed errors for the (non-fail-soft) decision write. `alreadyDecided` is the
/// 409 case the card-level "already decided elsewhere — refreshing" flow keys off.
public enum DecideError: Error, Equatable, Sendable {
    /// Gateway 409 — no live verdict, or the request was already decided.
    case alreadyDecided
    /// Non-2xx (and non-409) gateway status.
    case badStatus(Int)
    /// Transport failure before a response arrived.
    case transport
    /// The item carries no `verdictId`, so no decision can be posted.
    case notActionable
}

extension NexusClient {

    // MARK: - Wire envelopes

    /// `GET /queue` envelope — `{ "items": [...] }`. A missing/empty `items`
    /// decodes to `[]` so the fail-soft read degrades to an empty session.
    private struct QueueEnvelope: Decodable {
        let items: [TriageItem]
        init(from decoder: Decoder) throws {
            let c = try? decoder.container(keyedBy: CodingKeys.self)
            self.items = (try? c?.decode([TriageItem].self, forKey: .items)) ?? []
        }
        enum CodingKeys: String, CodingKey { case items }
    }

    // MARK: - Transport (self-contained; mirrors core getJSON / POST)

    private func decideSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.timeoutIntervalForResource = 30
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }

    /// GET + decode, returning nil on ANY failure (fail-soft reads).
    private func decideGetSoft<T: Decodable>(_ url: URL) async -> T? {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, response) = try? await decideSession().data(for: req)
        else { return nil }
        if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
            return nil
        }
        return try? JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Queue reads (fail-soft)

    /// `GET /queue?limit=N` — the ranked verdict batch for a decide session.
    /// Fail-soft: gateway down / non-2xx / decode failure / empty all resolve to
    /// `[]`. Server ranking is authoritative — the client NEVER re-ranks.
    public func fetchDecideQueue(limit: Int = 10) async -> [TriageItem] {
        var comps = URLComponents(
            url: endpoint.baseURL.appendingPathComponent("queue"),
            resolvingAgainstBaseURL: false
        )!
        comps.queryItems = [URLQueryItem(name: "limit", value: String(limit))]
        guard let url = comps.url else { return [] }
        let env: QueueEnvelope? = await decideGetSoft(url)
        return env?.items ?? []
    }

    /// `GET /queue/head` — a single ranked item, the fallback when the batch
    /// endpoint (mx add-queue-batch) hasn't landed. Fail-soft: nil on any
    /// failure or an empty body. Accepts either a bare item object or a
    /// `{ "item": {...} }` / `{ "items": [...] }` envelope.
    public func fetchDecideQueueHead() async -> TriageItem? {
        let url = endpoint.baseURL
            .appendingPathComponent("queue")
            .appendingPathComponent("head")
        // Prefer a bare item; fall back to an envelope shape.
        if let item: TriageItem = await decideGetSoft(url) {
            return item
        }
        if let env: QueueEnvelope = await decideGetSoft(url) {
            return env.items.first
        }
        return nil
    }

    // MARK: - Decision write (NOT fail-soft)

    /// `POST /requests/{id}/decision` — post a human accept/override decision.
    /// NOT fail-soft (design §Agent): a swallowed decision corrupts the pilot's
    /// data. Throws `DecideError.alreadyDecided` on 409, `.badStatus` on other
    /// non-2xx, `.transport` on a connection failure.
    ///
    /// - action: the accepted/overriding action (defer/delegate/preempt/group/
    ///   resolve/snooze). For a straight ACCEPT this is the verdict's own action.
    /// - overrideAction: set ONLY when the human overrode the verdict (the six-way
    ///   picker choice); nil for an accept.
    /// - note: optional single-line "why? (this tunes the model)" string.
    public func postDecision(
        requestID: String,
        action: String,
        overrideAction: String? = nil,
        note: String? = nil
    ) async throws {
        let escaped = requestID.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? requestID
        let url = endpoint.baseURL
            .appendingPathComponent("requests")
            .appendingPathComponent(escaped)
            .appendingPathComponent("decision")
        var body: [String: Any] = ["action": action]
        if let overrideAction, !overrideAction.isEmpty {
            body["override_action"] = overrideAction
        }
        if let note, !note.isEmpty {
            body["note"] = note
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let response: URLResponse
        do {
            (_, response) = try await decideSession().data(for: req)
        } catch {
            throw DecideError.transport
        }
        guard let http = response as? HTTPURLResponse else {
            throw DecideError.badStatus(0)
        }
        if http.statusCode == 409 {
            throw DecideError.alreadyDecided
        }
        guard (200...299).contains(http.statusCode) else {
            throw DecideError.badStatus(http.statusCode)
        }
    }
}
