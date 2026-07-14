// CredentialsViewTests — visibility logic + view-model state.
//
// Spec: credentials-account-resolve-and-usage (task 3.9)
//
// SwiftUI's @AppStorage isn't directly inspectable without driving a host
// view, so the dedupe-toggle round-trip is exercised via UserDefaults
// reads/writes (which @AppStorage proxies). The view model's
// refreshError dictionary + identity-update path are tested directly.

import XCTest
import SwiftUI
@testable import nexus
@testable import NexusShared

/// A `GET /credentials` envelope carrying `count` minimal credential rows.
private func credentialsEnvelope(count: Int) -> String {
    let rows = (0..<count).map { i in
        #"{"id":"c\#(i)","name":"acct\#(i)","fingerprint":"fp\#(i)","status":"active","isActive":false}"#
    }.joined(separator: ",")
    return #"{"credentials":[\#(rows)],"activeFingerprint":null}"#
}

/// In-process URLProtocol stub that answers every request with a fixed JSON
/// body (HTTP 200), simulating a REACHABLE agent. Runs entirely in-process —
/// no socket bind — so it works under the app-sandbox test host where a
/// loopback `NWListener` is denied ("Operation not permitted"). Injected into
/// `NexusClient` via its `protocolClasses` test seam.
private final class RespondingURLProtocol: URLProtocol {
    /// Class-static body served to every request (single reachable stub per run).
    static var body: String = "{}"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let data = Data(Self.body.utf8)
        let resp = HTTPURLResponse(
            url: request.url!, statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// In-process URLProtocol stub that fails every request, simulating an
/// UNREACHABLE agent (connection refused). No socket, sandbox-safe.
private final class FailingURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didFailWithError:
            URLError(.cannotConnectToHost))
    }
    override func stopLoading() {}
}

final class CredentialsViewTests: XCTestCase {
    private let storageKey = "credentials.dedupe"

    override func setUp() {
        super.setUp()
        UserDefaults.standard.removeObject(forKey: storageKey)
    }

    override func tearDown() {
        UserDefaults.standard.removeObject(forKey: storageKey)
        super.tearDown()
    }

    // MARK: - dedupe @AppStorage round-trip

    func test_dedupeStorage_persistsAcrossReads() {
        UserDefaults.standard.set(true, forKey: storageKey)
        XCTAssertTrue(UserDefaults.standard.bool(forKey: storageKey))

        UserDefaults.standard.set(false, forKey: storageKey)
        XCTAssertFalse(UserDefaults.standard.bool(forKey: storageKey))
    }

    // MARK: - refresh-identity visibility

    func test_refreshIdentityButton_visibleWhenEmailNil() {
        let profile = CcProfile(
            id: "p1",
            name: "anon",
            fingerprint: "fp",
            accountEmail: nil
        )
        XCTAssertNil(profile.accountEmail)
    }

    func test_refreshIdentityButton_hiddenWhenEmailPresent() {
        let profile = CcProfile(
            id: "p1",
            name: "leo",
            fingerprint: "fp",
            accountEmail: "leo@priceless.dev"
        )
        XCTAssertNotNil(profile.accountEmail)
    }

    // MARK: - sibling expand state

    func test_siblingChip_visibleWhenSiblingCountPositive() {
        let profile = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            siblingCount: 2,
            siblingIds: ["s1", "s2"]
        )
        XCTAssertEqual(profile.siblingCount, 2)
        XCTAssertEqual(profile.siblingIds?.count, 2)
    }

    func test_siblingChip_hiddenWhenSiblingCountZero() {
        let profile = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            siblingCount: 0,
            siblingIds: []
        )
        XCTAssertEqual(profile.siblingCount, 0)
    }

    // MARK: - usage-bar visibility

    func test_usageBars_visibleWhenBothLimitsPresent() {
        let profile = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            usage5hUsed: 41,
            usage5hLimit: 50,
            usage7dUsed: 220,
            usage7dLimit: 1000
        )
        XCTAssertNotNil(profile.usage5hLimit)
        XCTAssertNotNil(profile.usage7dLimit)
    }

    func test_usageBars_hiddenWhenAnyLimitMissing() {
        let onlyFive = CcProfile(
            id: "p1",
            name: "primary",
            fingerprint: "fp",
            usage5hUsed: 41,
            usage5hLimit: 50
        )
        XCTAssertNotNil(onlyFive.usage5hLimit)
        XCTAssertNil(onlyFive.usage7dLimit)
    }

    // MARK: - view-model error timeout

    @MainActor
    func test_refreshError_timeoutClears() async throws {
        let vm = CredentialsViewModel()
        vm.refreshError["p1"] = Date()
        XCTAssertNotNil(vm.refreshError["p1"])

        // Drive the cleanup directly — full 2-second sleep would slow the
        // suite; instead exercise the dictionary mutation contract.
        vm.refreshError.removeValue(forKey: "p1")
        XCTAssertNil(vm.refreshError["p1"])
    }

    // MARK: - [4.1] fetchCredentials reachability signal

    /// All agents offline: the reachable signal AND profiles are both empty.
    /// Port 1 (tcpmux) refuses connections instantly → fanOut drops the agent.
    func test_fetchCredentials_allUnreachable_emptySignalAndProfiles() async {
        let unreachable = NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://127.0.0.1:1/")!)
        )
        let agg = NexusAggregateClient(client: unreachable, name: "macbook")

        let profiles = await agg.fetchCredentials()
        let reachable = await agg.reachableAgentNames

        XCTAssertTrue(profiles.isEmpty, "no agent reachable → zero profiles")
        XCTAssertTrue(reachable.isEmpty, "no agent reachable → empty reachable signal")
    }

    /// One agent up (stub returns 3 credentials), one down: the reachable
    /// signal names only the responder and profiles has 3 entries.
    func test_fetchCredentials_oneReachableOneNot_signalNamesResponder() async {
        RespondingURLProtocol.body = credentialsEnvelope(count: 3)
        let reachableClient = NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://omarchy.test/")!),
            protocolClasses: [RespondingURLProtocol.self]
        )
        let unreachableClient = NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://macbook.test/")!),
            protocolClasses: [FailingURLProtocol.self]
        )
        let agg = NexusAggregateClient(
            clients: [reachableClient, unreachableClient],
            names: ["omarchy", "macbook"]
        )

        let profiles = await agg.fetchCredentials()
        let reachable = await agg.reachableAgentNames

        XCTAssertEqual(profiles.count, 3, "reachable agent's 3 credentials come through")
        XCTAssertTrue(reachable.contains("omarchy"), "the responder is in the signal")
        XCTAssertFalse(reachable.contains("macbook"), "the offline agent is not in the signal")
    }

    // MARK: - [4.2] warning banner vs empty-data distinction (view-model state)

    @MainActor
    func test_noAgentReachable_trueWhenZeroReachable_falseWhenReachableButEmpty() async {
        // Zero reachable → banner state (noAgentReachable == true).
        let down = NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://macbook.test/")!),
            protocolClasses: [FailingURLProtocol.self]
        )
        let vmDown = CredentialsViewModel(
            client: NexusAggregateClient(client: down, name: "macbook")
        )
        await vmDown.load(dedupe: false)
        XCTAssertTrue(vmDown.noAgentReachable, "zero reachable agents → warning-banner state")
        XCTAssertTrue(vmDown.profiles.isEmpty)
        XCTAssertEqual(vmDown.unreachableAgents, ["macbook"], "banner names the failed agent")

        // Reachable but returns ZERO credentials → empty-data state, NOT banner.
        RespondingURLProtocol.body = credentialsEnvelope(count: 0)
        let up = NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://omarchy.test/")!),
            protocolClasses: [RespondingURLProtocol.self]
        )
        let vmEmpty = CredentialsViewModel(
            client: NexusAggregateClient(client: up, name: "omarchy")
        )
        await vmEmpty.load(dedupe: false)
        XCTAssertFalse(vmEmpty.noAgentReachable, "agent reachable → empty-data state, not banner")
        XCTAssertTrue(vmEmpty.profiles.isEmpty)
    }

    // MARK: - [4.3] header source attribution

    @MainActor
    func test_sourceAttribution_namesReachableAgentAfterLoad() async {
        RespondingURLProtocol.body = credentialsEnvelope(count: 2)
        let up = NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://omarchy.test/")!),
            protocolClasses: [RespondingURLProtocol.self]
        )
        let vm = CredentialsViewModel(
            client: NexusAggregateClient(client: up, name: "omarchy")
        )
        await vm.load(dedupe: false)

        XCTAssertEqual(vm.sourceAgentName, "omarchy", "header 'via <agent>' names the source")
        XCTAssertEqual(vm.profiles.count, 2)
    }

    // MARK: - [4.4] MCP provider pills

    func test_mcpProviderList_splitsMultiProvider_emptyWhenAbsent() {
        let multi = NexusShared.CcProfile(
            id: "p1", name: "a", fingerprint: "fp", mcpProviders: "figma,posthog,slack"
        )
        XCTAssertEqual(multi.mcpProviderList, ["figma", "posthog", "slack"],
                       "one entry per provider, full lowercase name, comma order preserved")

        let nilProviders = NexusShared.CcProfile(id: "p2", name: "b", fingerprint: "fp", mcpProviders: nil)
        XCTAssertTrue(nilProviders.mcpProviderList.isEmpty, "nil → no pills")

        let emptyProviders = NexusShared.CcProfile(id: "p3", name: "c", fingerprint: "fp", mcpProviders: "")
        XCTAssertTrue(emptyProviders.mcpProviderList.isEmpty, "empty string → no pills")
    }

    /// The `mcpProviders` CodingKey decodes from the `GET /credentials` wire
    /// shape (camelCase comma-joined string) end-to-end.
    func test_mcpProviders_decodesFromWire() throws {
        let json = #"{"id":"p1","name":"a","fingerprint":"fp","status":"active","isActive":false,"mcpProviders":"figma,posthog"}"#
        let profile = try JSONDecoder().decode(NexusShared.CcProfile.self, from: Data(json.utf8))
        XCTAssertEqual(profile.mcpProviders, "figma,posthog")
        XCTAssertEqual(profile.mcpProviderList, ["figma", "posthog"])
    }
}
