// SystemSpeechSynthesizer — serial `/usr/bin/say` queue used as the fallback
// synthesis path when ElevenLabs is unavailable.
//
// Spec: openspec/changes/dashboard-ui-pass-v1 (task 2.5)
// Previous: mac-tts-runtime-wire-up (archived 2026-05-20) swapped
// AVSpeechSynthesizer for `/usr/bin/say`. That removed AVSpeechSynthesizer's
// internal utterance queue and produced overlapping audio when several
// notifications arrived in a burst.
//
// THIS REVISION: convert from `@MainActor final class` (fire-and-forget) to
// `actor` with a strict FIFO queue. Each `speak()` call awaits the previous
// Process's exit before spawning a new one. Three rapid speak() calls now
// produce three sequential utterances over 3-5 seconds — no overlap.
//
// Subprocess failure is logged via os_log and does NOT stall the queue.
//
// Platform: `/usr/bin/say` is macOS-only. TTSObserver only invokes this on
// macOS, so cross-platform support is intentionally dropped.

import Foundation
import os.log

#if os(macOS)

public actor SystemSpeechSynthesizer {
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "SystemSpeechSynthesizer"
    )

    /// Process spawn closure — overridable in tests so we can verify queue
    /// mechanics (sequencing, failure tolerance) without invoking the real
    /// `/usr/bin/say` binary (which would produce audible playback during
    /// CI runs). Production wiring passes nil and we use the canonical
    /// `/usr/bin/say` spawner.
    ///
    /// Closure contract: given (rate, text), launch a process and return it
    /// already-running. Throw to signal launch failure (will be logged + the
    /// queue advances to the next utterance). Async-allowed so test spawners
    /// can record state on an actor before launch.
    public typealias Spawner = @Sendable (Int, String) async throws -> Process

    private let spawner: Spawner

    /// Tail of the pending-utterance chain. Each new speak() call links its
    /// own Task into the chain by awaiting `pending` before doing its work,
    /// then assigns itself as the new `pending`. This is the classic
    /// "serial executor via chained Tasks" pattern — strict FIFO, no
    /// external lock needed because actor isolation already serializes
    /// reads/writes of `pending`.
    private var pending: Task<Void, Never>?

    /// The `/usr/bin/say` process currently producing audio (if any). Tracked
    /// so `stop()` can terminate mid-utterance — the subprocess analogue of
    /// AVSpeechSynthesizer's `stopSpeaking(at: .immediate)`. Cleared when the
    /// process exits or when `stop()` terminates it.
    ///
    /// Spec: openspec/changes/airpods-tts-cancel (mac-tts-listener,
    /// "Stop cancels the speech-synth fallback").
    private var current: Process?

    /// Default spawner — launches `/usr/bin/say -r <rate> <text>`.
    private static let defaultSpawner: Spawner = { rate, text in
        let task = Process()
        task.launchPath = "/usr/bin/say"
        task.arguments = ["-r", String(rate), text]
        try task.run()
        return task
    }

    public init() {
        self.spawner = Self.defaultSpawner
    }

    /// Test seam — inject a custom spawner. Production code should call
    /// `init()`.
    public init(spawner: @escaping Spawner) {
        self.spawner = spawner
    }

    /// Queue `text` for sequential utterance. Returns as soon as the call
    /// has been queued — the caller does NOT wait for audio completion.
    /// Concurrent callers are serialized via the internal pending-Task
    /// chain.
    ///
    /// Rate is words-per-minute (170-200 sounds natural; macOS default
    /// ~175).
    public func speak(_ text: String, rate: Int = 175) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Capture the prior tail BEFORE creating our task so we serialize
        // strictly. If `pending` is nil we still want a Task wrapper so
        // callers can await on completion via spy hooks in tests.
        let priorTask = pending
        let spawner = self.spawner

        let task = Task { [priorTask] in
            // 1. Wait for the previous utterance (if any) to finish.
            await priorTask?.value

            // 2. Spawn the subprocess. Failure is logged + the queue moves on.
            let process: Process
            do {
                process = try await spawner(rate, trimmed)
            } catch {
                Self.logger.error(
                    "SystemSpeechSynthesizer: say failed error=\(error.localizedDescription, privacy: .public)"
                )
                return
            }

            Self.logger.info(
                "SystemSpeechSynthesizer: say invoked rate=\(rate) text_len=\(trimmed.count)"
            )

            // Record the live process so stop() can terminate it mid-clip.
            // Hopping back onto the actor to mutate isolated state.
            await self.setCurrent(process)

            // 3. Wait for the subprocess to exit. waitUntilExit is blocking
            // so we use terminationHandler + a continuation. Foundation does
            // NOT retroactively invoke a handler set after termination, so
            // we double-check isRunning right after wiring it to close the
            // race window.
            await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
                // Resume only ONCE — terminationHandler vs the post-wire
                // isRunning check could both fire on a fast process.
                let didResume = ResumeOnce(cont: cont)
                // Preserve a pre-existing terminationHandler set by the
                // spawner (tests use it for sequencing assertions). Our
                // resume hook runs after the spawner's handler.
                let priorHandler = process.terminationHandler
                process.terminationHandler = { p in
                    priorHandler?(p)
                    didResume.resumeIfNeeded()
                }
                if !process.isRunning {
                    didResume.resumeIfNeeded()
                }
            }

            // Utterance done (natural exit or stop()-terminated) — release
            // the tracked handle so a stale Process isn't terminated later.
            await self.clearCurrent(process)
        }

        pending = task
    }

    /// Record the currently-speaking process (actor-isolated mutation hop
    /// from the detached speak Task).
    private func setCurrent(_ process: Process) {
        current = process
    }

    /// Clear the tracked process only if it's still the one we recorded —
    /// guards against a fast follow-up clip overwriting `current` before the
    /// prior Task's cleanup runs.
    private func clearCurrent(_ process: Process) {
        if current === process {
            current = nil
        }
    }

    /// Cancel any in-flight utterance immediately. Terminates the live
    /// `/usr/bin/say` subprocess (the subprocess analogue of
    /// `AVSpeechSynthesizer.stopSpeaking(at: .immediate)`). Safe no-op when
    /// nothing is speaking. The terminated process's exit fires the
    /// continuation in `speak()`, so the FIFO queue advances normally.
    ///
    /// Spec: openspec/changes/airpods-tts-cancel (mac-tts-listener).
    public func stop() {
        guard let process = current, process.isRunning else { return }
        Self.logger.info("SystemSpeechSynthesizer: stop() terminating in-flight say process")
        process.terminate()
        current = nil
    }

    /// Drain the queue — await pending utterance completion. Test-only.
    /// Production callers don't need this; the queue self-drains via the
    /// chained Tasks.
    public func waitForIdle() async {
        await pending?.value
    }
}

/// Single-shot continuation resumer. Foundation's terminationHandler can
/// race with our post-wire `isRunning` check on fast processes; we'd
/// otherwise resume the continuation twice and trip the CheckedContinuation
/// runtime assertion.
private final class ResumeOnce: @unchecked Sendable {
    private let cont: CheckedContinuation<Void, Never>
    private let lock = NSLock()
    private var resumed = false

    init(cont: CheckedContinuation<Void, Never>) { self.cont = cont }

    func resumeIfNeeded() {
        lock.lock()
        let shouldResume = !resumed
        resumed = true
        lock.unlock()
        if shouldResume { cont.resume() }
    }
}

#else

// iOS / non-macOS: `/usr/bin/say` and `Process` do not exist. iOS TTS is out
// of scope here, so this is a compiling no-op stub that preserves the public
// API surface (init, speak, stop, waitForIdle) callers depend on. TTSObserver
// only routes to the speech-synth fallback on macOS, so on iOS these calls are
// never reached in practice.
public actor SystemSpeechSynthesizer {
    public init() {}

    /// No-op on iOS — there is no system `say` binary to drive.
    public func speak(_ text: String, rate: Int = 175) {}

    /// No-op on iOS — nothing is ever speaking.
    public func stop() {}

    /// No-op on iOS — the queue is always idle.
    public func waitForIdle() async {}
}

#endif
