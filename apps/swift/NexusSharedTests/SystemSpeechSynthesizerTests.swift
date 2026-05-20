// SystemSpeechSynthesizerTests — pin the serial-queue contract from
// dashboard-ui-pass-v1 (task 3.1).
//
// Audio-test strategy: we DO NOT spawn `/usr/bin/say` in tests — doing so
// would produce audible playback during local + CI runs and stall the
// agent fleet for the full wall-clock of the synthesized speech. Instead,
// we inject a stub `Spawner` that returns a short-lived Process. The
// `/bin/sleep` binary is a tiny, universally-available program that exits
// after the requested duration; pairing it with `terminationHandler`
// gives us a Foundation-correct way to assert sequencing without audio.
//
// Three tests pin the contract:
//   1. testSequentialUtterancesDoNotOverlap — three rapid speak() calls
//      produce three sequential Process exits (start[N] >= end[N-1]).
//   2. testSpeakReturnsImmediately — speak() returns quickly even when the
//      subprocess will take seconds (queue submission is decoupled from
//      audio completion).
//   3. testSubprocessFailureDoesNotJamQueue — a spawn throw on call #2
//      does NOT prevent call #3 from running.

import XCTest
@testable import NexusShared

final class SystemSpeechSynthesizerTests: XCTestCase {

    // MARK: - Fixtures

    /// Build a Spawner that launches `/bin/sleep <duration>` so we can
    /// drive Process timing deterministically. Records each spawn in
    /// `spawns` (timestamp + text) for assertions.
    private actor SpawnRecorder {
        struct Record: Sendable {
            let text: String
            let spawnedAt: Date
            var exitedAt: Date?
        }
        private(set) var records: [Record] = []

        func recordSpawn(text: String) -> Int {
            records.append(Record(text: text, spawnedAt: Date(), exitedAt: nil))
            return records.count - 1
        }

        func recordExit(index: Int) {
            guard index < records.count else { return }
            records[index].exitedAt = Date()
        }

        func snapshot() -> [Record] { records }
    }

    private func makeSleepSpawner(
        recorder: SpawnRecorder,
        durationSeconds: Double = 0.05
    ) -> SystemSpeechSynthesizer.Spawner {
        return { _, text in
            let task = Process()
            task.launchPath = "/bin/sleep"
            task.arguments = [String(durationSeconds)]
            // Capture spawn pre-launch so the order is correct even if the
            // recorder hop runs after waitUntilExit observes termination.
            let recordIndex = await recorder.recordSpawn(text: text)
            // Foundation routes terminationHandler off the global queue;
            // chain our exit hook there.
            task.terminationHandler = { _ in
                Task { await recorder.recordExit(index: recordIndex) }
            }
            try task.run()
            return task
        }
    }

    // MARK: - 1. Sequential

    func testSequentialUtterancesDoNotOverlap() async throws {
        let recorder = SpawnRecorder()
        let synth = SystemSpeechSynthesizer(
            spawner: makeSleepSpawner(recorder: recorder, durationSeconds: 0.08)
        )

        // Fire three speak() calls within ~10ms. Each must run sequentially:
        // spawn[N] MUST happen at or after exit[N-1].
        await synth.speak("alpha")
        await synth.speak("bravo")
        await synth.speak("charlie")

        // Drain the queue so all three have spawned + exited.
        await synth.waitForIdle()
        // Give terminationHandler hops a moment to complete on the global
        // queue. waitForIdle returns when our continuation fires; the
        // recorder.recordExit hop is itself an async task that may not have
        // landed yet. A short yield-poll keeps the test fast and reliable.
        try await waitForExitCount(recorder: recorder, expected: 3)

        let records = await recorder.records
        XCTAssertEqual(records.count, 3, "should have three spawn records")
        XCTAssertEqual(records.map(\.text), ["alpha", "bravo", "charlie"])

        // Sequencing invariant: each spawn happens AFTER the previous exit.
        for i in 1..<records.count {
            guard let prevExit = records[i - 1].exitedAt else {
                XCTFail("record[\(i - 1)] never recorded exit")
                continue
            }
            let thisSpawn = records[i].spawnedAt
            XCTAssertGreaterThanOrEqual(
                thisSpawn,
                prevExit,
                "spawn #\(i) at \(thisSpawn) overlapped prior exit at \(prevExit)"
            )
        }
    }

    // MARK: - 2. Returns immediately

    func testSpeakReturnsImmediately() async throws {
        let recorder = SpawnRecorder()
        // Use a longer-running stub so we can detect blocking. If speak()
        // blocked on audio completion the elapsed time would approach 0.5s;
        // it should instead return in single-digit ms.
        let synth = SystemSpeechSynthesizer(
            spawner: makeSleepSpawner(recorder: recorder, durationSeconds: 0.5)
        )

        let start = Date()
        await synth.speak("hello")
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertLessThan(
            elapsed,
            0.05,
            "speak() returned in \(elapsed)s; should be <50ms — work is queued not awaited"
        )

        // Cleanly drain so the test doesn't leak a running /bin/sleep.
        await synth.waitForIdle()
    }

    // MARK: - 3. Failure does not jam queue

    func testSubprocessFailureDoesNotJamQueue() async throws {
        let recorder = SpawnRecorder()
        // Spawner that throws on the 2nd call only — the 1st and 3rd must
        // still complete normally.
        actor CallCounter {
            private(set) var count = 0
            func tick() -> Int { count += 1; return count }
        }
        let counter = CallCounter()
        let sleepSpawner = makeSleepSpawner(recorder: recorder, durationSeconds: 0.04)

        struct FailedToLaunch: Error {}
        let flakyspawner: SystemSpeechSynthesizer.Spawner = { rate, text in
            let n = await counter.tick()
            if n == 2 { throw FailedToLaunch() }
            return try await sleepSpawner(rate, text)
        }

        let synth = SystemSpeechSynthesizer(spawner: flakyspawner)
        await synth.speak("first")
        await synth.speak("doomed")
        await synth.speak("third")

        await synth.waitForIdle()
        try await waitForExitCount(recorder: recorder, expected: 2)

        let records = await recorder.records
        // We only spawn for #1 and #3; #2 threw before recordSpawn was
        // called, so it is absent from the recorder. The queue MUST have
        // advanced past the failure.
        XCTAssertEqual(records.map(\.text), ["first", "third"])
        XCTAssertNotNil(records[0].exitedAt)
        XCTAssertNotNil(records[1].exitedAt)
        let total = await counter.count
        XCTAssertEqual(total, 3, "spawner should have been invoked 3 times")
    }

    // MARK: - Helpers

    /// Poll the recorder until `expected` exits have landed or `timeout`
    /// elapses. Keeps tests fast on green paths while giving the
    /// terminationHandler hop room to complete.
    private func waitForExitCount(
        recorder: SpawnRecorder,
        expected: Int,
        timeout: TimeInterval = 2.0
    ) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            let exits = await recorder.records.filter { $0.exitedAt != nil }.count
            if exits >= expected { return }
            try await Task.sleep(nanoseconds: 5_000_000) // 5ms
        }
        let exits = await recorder.records.filter { $0.exitedAt != nil }.count
        XCTFail("only \(exits) exits recorded; expected \(expected)")
    }
}
