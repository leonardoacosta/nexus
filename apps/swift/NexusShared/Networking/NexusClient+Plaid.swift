// NexusClient+Plaid — typed HTTP client for the mx Plaid control sidecar (8801).
//
// Capability: src-finance. Beads: mx-dhhj (helpers) + mx-6s9s (AddBankScene).
//
// The Plaid control sidecar is a SEPARATE homelab service from the agent API
// (:7400) and the meds sidecar (:8802). The phone reaches it directly over the
// Tailnet. We derive the homelab HOST from `NexusEndpoint.resolved.baseURL` and
// build URLs against `http://<host>:<plaidControlPort>` (default 8801). Both the
// port and the entire base URL are overridable via SettingsStore
// (`plaidControlPort` / `plaidControlBaseURL`), mirroring the meds sidecar
// derivation. Auth is an optional bearer token (`SettingsStore.plaidControlToken`);
// absent it, no header (tailnet-trust).
//
// The core NexusClient's `getJSON` / `session` / `decoder` are `private`, so
// this extension carries its OWN lightweight transport (mirroring the
// getJSON / JSONSerialization-POST patterns + NexusClientError handling) rather
// than reaching into the actor's private state — same approach as
// NexusClient+Meds.
//
// Add-Bank flow (the Go sidecar drives Plaid Link server-side):
//   1) GET /plaid/link?label=<name?>  -> link_token + hosted_url + label.
//      The phone opens hosted_url in Safari; the user completes Plaid Link.
//   2) GET /plaid/link/poll?link_token=<t> -> {done, public_token?}. The client
//      polls until done==true and public_token is non-null.
//   3) POST /plaid/exchange {public_token, label} -> {item_id, institution, label}.
//      IMPORTANT: the `label` returned by /plaid/link is server-authoritative and
//      MUST be passed THROUGH to /plaid/exchange unchanged — the Go side keys the
//      token file on it.

import Foundation

// MARK: - Wire models

/// Response from `GET /plaid/link` — the started Plaid Link handle.
/// `hostedURL` is the page the phone opens in Safari; `label` is
/// server-authoritative and threaded through to `/plaid/exchange`.
public struct PlaidLinkStart: Identifiable, Equatable, Hashable, Codable, Sendable {
    public let linkToken: String
    public let hostedURL: String
    public let label: String

    public var id: String { linkToken }

    public init(linkToken: String, hostedURL: String, label: String) {
        self.linkToken = linkToken
        self.hostedURL = hostedURL
        self.label = label
    }

    enum CodingKeys: String, CodingKey {
        case linkToken = "link_token"
        case hostedURL = "hosted_url"
        case label
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.linkToken = try c.decode(String.self, forKey: .linkToken)
        self.hostedURL = try c.decode(String.self, forKey: .hostedURL)
        self.label = (try? c.decode(String.self, forKey: .label)) ?? ""
    }
}

/// Response from `GET /plaid/link/poll` — `public_token` is JSON null until the
/// user finishes Plaid Link in Safari (then `done == true`).
public struct PlaidLinkPoll: Equatable, Hashable, Codable, Sendable {
    public let done: Bool
    public let publicToken: String?

    public init(done: Bool, publicToken: String?) {
        self.done = done
        self.publicToken = publicToken
    }

    enum CodingKeys: String, CodingKey {
        case done
        case publicToken = "public_token"
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.done = (try? c.decode(Bool.self, forKey: .done)) ?? false
        // public_token is `null` until done — decodeIfPresent tolerates both
        // an absent key and an explicit JSON null.
        self.publicToken = try? c.decodeIfPresent(String.self, forKey: .publicToken)
    }
}

/// Response from `POST /plaid/exchange` — the linked Item, ready to use with
/// NO restart (mx hot-reload).
public struct PlaidExchangeResult: Identifiable, Equatable, Hashable, Codable, Sendable {
    public let itemID: String
    public let institution: String
    public let label: String

    public var id: String { itemID }

    public init(itemID: String, institution: String, label: String) {
        self.itemID = itemID
        self.institution = institution
        self.label = label
    }

    enum CodingKeys: String, CodingKey {
        case itemID = "item_id"
        case institution
        case label
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.itemID = (try? c.decode(String.self, forKey: .itemID)) ?? ""
        self.institution = (try? c.decode(String.self, forKey: .institution)) ?? ""
        self.label = (try? c.decode(String.self, forKey: .label)) ?? ""
    }
}

// MARK: - Client

extension NexusClient {

    // MARK: - Base URL derivation

    /// Resolve the Plaid control sidecar base URL. Order:
    ///   1) `SettingsStore.plaidControlBaseURL` (full override) if parseable.
    ///   2) Host of `NexusEndpoint.resolved.baseURL` + `:plaidControlPort` (http).
    ///   3) `http://localhost:<plaidControlPort>` fallback.
    public static func plaidControlBaseURL() -> URL {
        let store = SettingsStore.shared
        if let raw = store.plaidControlBaseURL, !raw.isEmpty, let url = URL(string: raw) {
            return url
        }
        let port = store.plaidControlPort
        let host = NexusEndpoint.resolved.baseURL.host ?? "localhost"
        return URL(string: "http://\(host):\(port)")
            ?? URL(string: "http://localhost:\(port)")!
    }

    private func plaidURL(_ path: String, query: [URLQueryItem] = []) -> URL {
        let base = Self.plaidControlBaseURL()
        var comps = URLComponents(
            url: base.appendingPathComponent(path),
            resolvingAgainstBaseURL: false
        )
        if !query.isEmpty { comps?.queryItems = query }
        return comps?.url ?? base.appendingPathComponent(path)
    }

    // MARK: - Transport (self-contained; mirrors core getJSON / POST)

    private func plaidSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 15
        cfg.timeoutIntervalForResource = 30
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: cfg)
    }

    private func plaidAuth(_ req: inout URLRequest) {
        if let token = SettingsStore.shared.plaidControlToken, !token.isEmpty {
            req.addValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
    }

    private func plaidGet<T: Decodable>(_ url: URL) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        plaidAuth(&req)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await plaidSession().data(for: req)
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

    private func plaidPost<T: Decodable>(
        _ url: URL,
        body: [String: Any]
    ) async throws -> T {
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.addValue("application/json", forHTTPHeaderField: "Content-Type")
        req.addValue("application/json", forHTTPHeaderField: "Accept")
        plaidAuth(&req)
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await plaidSession().data(for: req)
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
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw NexusClientError.decoding(error)
        }
    }

    // MARK: - Add-Bank flow

    /// `GET /plaid/link?label=<name?>` — start a Plaid Link session. Returns the
    /// link token, the hosted-page URL to open in Safari, and the
    /// server-authoritative `label` to thread through to `plaidExchange`.
    public func plaidStartLink(label: String?) async throws -> PlaidLinkStart {
        var q: [URLQueryItem] = []
        if let label, !label.isEmpty {
            q.append(URLQueryItem(name: "label", value: label))
        }
        return try await plaidGet(plaidURL("plaid/link", query: q))
    }

    /// `GET /plaid/link/poll?link_token=<t>` — poll for completion. `done` flips
    /// true with a non-nil `publicToken` once the user finishes Plaid Link in
    /// Safari; until then `done == false` and `publicToken == nil`.
    public func plaidPollLink(linkToken: String) async throws -> PlaidLinkPoll {
        let q = [URLQueryItem(name: "link_token", value: linkToken)]
        return try await plaidGet(plaidURL("plaid/link/poll", query: q))
    }

    /// `POST /plaid/exchange` body `{public_token, label}` — exchange the public
    /// token for a persisted Item. `label` MUST be the server-authoritative value
    /// from `plaidStartLink` (the Go side keys the token file on it). The new
    /// account goes live with NO restart (mx hot-reload).
    @discardableResult
    public func plaidExchange(
        publicToken: String,
        label: String
    ) async throws -> PlaidExchangeResult {
        try await plaidPost(
            plaidURL("plaid/exchange"),
            body: ["public_token": publicToken, "label": label]
        )
    }
}
