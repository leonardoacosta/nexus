//
//  NotificationRingBufferTests.swift
//  nexusTests
//
//  Exercises the in-memory ring buffer at sizes 0, 1, 50, 51 (one over cap)
//  plus round-tripping through UserDefaults persistence.
//

import XCTest
@testable import nexus

final class NotificationRingBufferTests: XCTestCase {

    /// Use a per-test suite so we don't trample the live menu bar's data.
    private static let testSuite = "com.nexus.menubar.tests"
    private var store: NotificationStore!
    private var client: NexusClient!

    override func setUp() {
        super.setUp()
        store = NotificationStore(suiteName: Self.testSuite)
        store.reset()
        client = NexusClient(store: store)
    }

    override func tearDown() {
        store.reset()
        super.tearDown()
    }

    func testEmptyBufferRoundTrip() async {
        let snap = await client.snapshot()
        XCTAssertEqual(snap.notifications.count, 0)
    }

    func testSingleInsertReturnedAtTop() async {
        await client.prependNotification(NotificationEvent(body: "alpha"))
        let snap = await client.snapshot()
        XCTAssertEqual(snap.notifications.count, 1)
        XCTAssertEqual(snap.notifications.first?.body, "alpha")
    }

    func testFiftyInserts() async {
        for i in 0..<50 {
            await client.prependNotification(NotificationEvent(body: "n\(i)"))
        }
        let snap = await client.snapshot()
        XCTAssertEqual(snap.notifications.count, 50)
        // Most recent should be at index 0 (prepend semantics).
        XCTAssertEqual(snap.notifications.first?.body, "n49")
        XCTAssertEqual(snap.notifications.last?.body, "n0")
    }

    func testFiftyOneInsertsEvictsOldest() async {
        for i in 0..<51 {
            await client.prependNotification(NotificationEvent(body: "n\(i)"))
        }
        let snap = await client.snapshot()
        XCTAssertEqual(snap.notifications.count, 50)
        XCTAssertEqual(snap.notifications.first?.body, "n50")
        // The 0th event must have been evicted; oldest remaining is n1.
        XCTAssertEqual(snap.notifications.last?.body, "n1")
    }

    func testJSONRoundTripThroughUserDefaults() async {
        let ev = NotificationEvent(body: "persistent", channel: "tts",
                                   title: "test", emoji: nil)
        await client.prependNotification(ev)

        // Re-open with a fresh client; the persisted buffer must rehydrate.
        let store2 = NotificationStore(suiteName: Self.testSuite)
        let client2 = NexusClient(store: store2)
        let snap = await client2.snapshot()
        XCTAssertEqual(snap.notifications.count, 1)
        XCTAssertEqual(snap.notifications.first?.body, "persistent")
        XCTAssertEqual(snap.notifications.first?.channel, "tts")
    }

    func testClearWipesBufferAndPersistence() async {
        for i in 0..<5 {
            await client.prependNotification(NotificationEvent(body: "n\(i)"))
        }
        await client.clearNotifications()
        let snap = await client.snapshot()
        XCTAssertTrue(snap.notifications.isEmpty)

        // And after rehydrate.
        let store2 = NotificationStore(suiteName: Self.testSuite)
        let client2 = NexusClient(store: store2)
        let snap2 = await client2.snapshot()
        XCTAssertTrue(snap2.notifications.isEmpty)
    }
}
