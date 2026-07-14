// OwningAgentResolutionTests — `NexusAggregateClient.resolveOwningAgent(project:)`
// picks the single agent that owns a project out of a multi-agent fixture.
//
// Spec: openspec/changes/add-board-detail-live-updates (E2E batch — owning-agent
// resolution against a multi-agent fixture, mirroring the `fetchSpecContent`
// fan-out-and-first-success pattern).
//
// No real socket: each fixture agent is a real `NexusClient` whose session is
// backed by a `URLProtocol` stub (the same `protocolClasses:` injection seam
// `NexusClient.init` exposes for tests). The stub routes by request host — the
// owner host answers `GET /specs?project=…` with a one-row list, every other
// host answers `[]`, so a non-empty response IS the ownership signal.

import XCTest
import NexusShared

/// Answers `GET /specs?project=…` for the fixture. The owner host returns a
/// single minimal `SpecSummary`; all other hosts return an empty array (they
/// don't own the project). Routing is by URL host so one stub class can back
/// every fixture client.
final class SpecsOwnershipStubURLProtocol: URLProtocol {
    /// Host whose agent owns the fixture project. Constant per test run.
    static let ownerHost = "owner.local"

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let host = request.url?.host ?? ""
        let body =
            host == Self.ownerHost
            ? #"[{"name":"add-thing","project":"nx","status":"draft","completedTasks":0,"totalTasks":2}]"#
            : "[]"
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class OwningAgentResolutionTests: XCTestCase {

    private func stubClient(host: String) -> NexusClient {
        NexusClient(
            endpoint: NexusEndpoint(baseURL: URL(string: "http://\(host):7400")!),
            protocolClasses: [SpecsOwnershipStubURLProtocol.self]
        )
    }

    /// The owning agent is returned regardless of its position in the client
    /// list — only its non-empty `GET /specs` response identifies it, so
    /// fan-out completion order does not matter.
    func test_resolveOwningAgent_returnsTheSingleOwnerFromMultiAgentFixture() async {
        let owner = stubClient(host: SpecsOwnershipStubURLProtocol.ownerHost)
        let other = stubClient(host: "other.local")
        // Put the non-owner first to prove ordering doesn't leak in.
        let aggregate = NexusAggregateClient(
            clients: [other, owner],
            names: ["other", "owner"]
        )

        let identity = await aggregate.resolveOwningAgent(project: "nx")

        XCTAssertEqual(identity?.name, "owner")
    }

    /// No reachable agent owns the project → nil (the detail rail opens no
    /// connection).
    func test_resolveOwningAgent_nilWhenNoAgentOwnsTheProject() async {
        let a = stubClient(host: "other-a.local")
        let b = stubClient(host: "other-b.local")
        let aggregate = NexusAggregateClient(clients: [a, b], names: ["a", "b"])

        let identity = await aggregate.resolveOwningAgent(project: "nx")

        XCTAssertNil(identity)
    }
}
