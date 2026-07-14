// BoardDetailLiveUpdatesTests — the detail rail's live-update state machine:
// SpecTransition-driven cache revalidation and the single-connection lifecycle.
//
// Spec: openspec/changes/add-board-detail-live-updates (E2E batch)
//
// Target placement
// ────────────────
// Lives in nexus-mac-Tests (host-bundled) because `BoardDetailModel` lives in
// the nexus-mac app target (module `nexus`), reached via `@testable import
// nexus`. No network: the live-update source is a fake `SpecLiveUpdating` and
// the content fetcher is an injected counting closure, so these assert the
// model's own filter + connection lifecycle deterministically.

import XCTest
@testable import nexus
import NexusShared

// MARK: - Test doubles

/// Counts revalidation fetches so a test can assert exactly how many times the
/// cache refetch ran.
private actor CallCounter {
    private(set) var count = 0
    func bump() { count += 1 }
}

/// Fake `SpecLiveUpdating`. `resolvesOwner` controls whether a stream is opened;
/// each stream tags its open/cancel log entry with the resolved agent name
/// (which the test sets to the project) so connection lifecycle is observable.
private actor FakeLiveSource: SpecLiveUpdating {
    enum Entry: Equatable {
        case open(String)
        case cancel(String)
    }

    private let resolvesOwner: Bool
    private(set) var log: [Entry] = []

    init(resolvesOwner: Bool) {
        self.resolvesOwner = resolvesOwner
    }

    func resolveOwningAgent(project: String) async -> AgentIdentity? {
        resolvesOwner ? AgentIdentity(name: project) : nil
    }

    func streamSpecEvents(
        from agent: AgentIdentity,
        onConnect: @Sendable @escaping (Bool) async -> Void,
        handler: @Sendable @escaping (SSEEvent) async -> Void
    ) async {
        await onConnect(false)
        log.append(.open(agent.name))
        // Block until the surrounding task is cancelled (the model cancels the
        // previous connection before opening a new one).
        while !Task.isCancelled {
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        log.append(.cancel(agent.name))
    }
}

@MainActor
final class BoardDetailLiveUpdatesTests: XCTestCase {

    /// One coalesced `spec-transition` SSE frame targeting (project, spec).
    private func frame(project: String, spec: String) -> SSEEvent {
        let json = """
        {"seq":1,"ts":"2026-07-14T00:00:00Z","events":[\
        {"kind":"progress","project":"\(project)","spec":"\(spec)","completed":1,"total":2}]}
        """
        return SSEEvent(name: "spec-transition", data: json)
    }

    /// Poll `condition` until true or the deadline elapses (non-flaky wait for
    /// cooperative-cancellation / cross-actor effects to land).
    private func poll(
        timeout: TimeInterval = 2.0,
        _ condition: @Sendable () async -> Bool
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
    }

    // MARK: - SpecTransition → cache revalidation (targeted vs no-op)

    func test_specTransition_forOpenItem_revalidates_andForOtherItem_isNoOp() async {
        let counter = CallCounter()
        let model = BoardDetailModel(
            cache: SpecContentCache(),
            live: FakeLiveSource(resolvesOwner: false),
            contentFetcher: { _ in await counter.bump(); return "BODY" }
        )

        // Select a proposal → binds (project, slug) as the open item.
        model.updateSelection(.proposal(project: "nx", slug: "add-thing"))

        // A transition for the open (project, slug) revalidates exactly once.
        await model.handleSpecEvent(
            frame(project: "nx", spec: "add-thing"),
            project: "nx",
            slug: "add-thing"
        )
        let afterMatch = await counter.count
        XCTAssertEqual(afterMatch, 1, "matching transition triggers one revalidation")

        // A transition for a different (project, slug) is ignored.
        await model.handleSpecEvent(
            frame(project: "oo", spec: "something-else"),
            project: "nx",
            slug: "add-thing"
        )
        let afterNonMatch = await counter.count
        XCTAssertEqual(afterNonMatch, 1, "non-matching transition is a no-op")

        model.teardown()
    }

    // MARK: - Single-connection lifecycle (cancel-before-open on reselect)

    func test_reselect_cancelsOpenConnection_beforeOpeningNew() async {
        let fake = FakeLiveSource(resolvesOwner: true)
        let model = BoardDetailModel(
            cache: SpecContentCache(),
            live: fake,
            contentFetcher: { _ in nil }
        )

        // Select proposal A → opens one connection tagged "pa".
        model.updateSelection(.proposal(project: "pa", slug: "x"))
        await poll { await fake.log.contains(.open("pa")) }

        // Reselect proposal B → must cancel A's connection and open B's.
        model.updateSelection(.proposal(project: "pb", slug: "y"))
        await poll { await fake.log.contains(.open("pb")) }
        await poll { await fake.log.contains(.cancel("pa")) }

        let log = await fake.log
        XCTAssertTrue(log.contains(.open("pa")), "A opened a connection")
        XCTAssertTrue(log.contains(.open("pb")), "reselect opened B's connection")
        XCTAssertTrue(log.contains(.cancel("pa")), "A's connection was cancelled on reselect")
        XCTAssertFalse(log.contains(.cancel("pb")), "B's connection stays open")

        // Deselect entirely → B's connection cancels too.
        model.teardown()
        await poll { await fake.log.contains(.cancel("pb")) }
        let final = await fake.log
        XCTAssertTrue(final.contains(.cancel("pb")), "teardown cancels the open connection")
    }
}
