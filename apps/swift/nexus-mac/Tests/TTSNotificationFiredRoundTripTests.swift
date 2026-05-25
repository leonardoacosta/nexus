// TTSNotificationFiredRoundTripTests — deterministic integration harness for
// the mac-tts delivery path.
//
// Spec: openspec/changes/mac-tts-integration-test (tasks 1.1 + 1.2)
//
// What this proves
// ────────────────
// The full round-trip `agent NotificationFired SSE -> TTSObserver consumes it
// -> the audio/synthesis path is invoked`. Unlike TTSObserverTests.swift
// (which is structural because handle(event:) is private), this test drives a
// REAL SSE `NotificationFired` frame through the observer's actual
// `consumeNotifications` pipeline and asserts the synth path runs.
//
// Determinism + no real audio
// ───────────────────────────
//   - A minimal in-process loopback HTTP server (NWListener) emits exactly one
//     `event: NotificationFired\ndata: {...}\n\n` frame — the same wire shape
//     the agent's stub-agent.ts harness emits (see
//     apps/agent/src/testing/stub-agent.ts encodeNotificationFiredFrame, and
//     its TS coverage in stub-agent-notification-sse.test.ts).
//   - The injected StubKeychainStore has NO ElevenLabs api key, so the
//     observer takes the deterministic SYSTEM-SPEECH branch (no network round
//     trip to ElevenLabs).
//   - SystemSpeechSynthesizer's Spawner seam is mocked to record the spoken
//     text and return a fast-exiting `/usr/bin/true` process — NO audible
//     `say` playback. The recorded text IS the assertion that the audio/synth
//     path was reached for the emitted notification body.
//   - A SpyMP3Player asserts the ElevenLabs MP3 branch is NOT taken (no creds).
//
// Clean env-gated skip
// ────────────────────
// If the loopback listener cannot bind / come ready (no networking in the
// test env, sandbox denial, etc.), the test XCTSkips with a clear reason
// rather than failing or silently passing.

import XCTest
import Network
import UserNotifications
@testable import NexusShared

// MARK: - Test doubles

/// Keychain stub with no ElevenLabs creds — forces the system-speech branch.
private final class NoCredsKeychain: KeychainStore, @unchecked Sendable {
    func apiKey() -> String? { nil }
    func voiceId() -> String? { nil }
}

/// MP3 playback spy — proves the ElevenLabs branch was NOT taken.
private final class SpyMP3Player: MP3PlayerProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var _playCount = 0
    var playCount: Int { lock.lock(); defer { lock.unlock() }; return _playCount }
    func play(mp3Data: Data, ducking: DuckingMode) throws {
        lock.lock(); defer { lock.unlock() }; _playCount += 1
    }
    func stop() {}
    var onPlaybackFinished: (() -> Void)?
}

/// Thread-safe recorder for the text handed to the mocked `say` spawner.
private final class SpokenTextRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _texts: [String] = []
    func record(_ s: String) { lock.lock(); defer { lock.unlock() }; _texts.append(s) }
    var texts: [String] { lock.lock(); defer { lock.unlock() }; return _texts }
}

// MARK: - Minimal loopback SSE server

/// A throwaway HTTP server that answers `GET /events/stream` with a single
/// `NotificationFired` SSE frame, then holds the connection open (a real SSE
/// stream is long-lived; the client closes it). Bound to 127.0.0.1 on an
/// OS-assigned port.
private final class LoopbackSSEServer: @unchecked Sendable {
    private let listener: NWListener
    private let frame: String
    private(set) var port: UInt16 = 0
    private let queue = DispatchQueue(label: "dev.leonardoacosta.nexus.test.sse")

    init(frame: String) throws {
        self.frame = frame
        let params = NWParameters.tcp
        // Force IPv4 loopback so the URL host (127.0.0.1) matches the bind.
        params.requiredInterfaceType = .loopback
        self.listener = try NWListener(using: params, on: .any)
    }

    /// Start listening; resolves the bound port. Throws if it never comes up.
    func start(timeout: TimeInterval = 5.0) throws {
        let ready = DispatchSemaphore(value: 0)
        var startError: Error?

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                self?.port = self?.listener.port?.rawValue ?? 0
                ready.signal()
            case .failed(let err):
                startError = err
                ready.signal()
            default:
                break
            }
        }

        listener.newConnectionHandler = { [weak self] conn in
            self?.handle(conn)
        }

        listener.start(queue: queue)

        if ready.wait(timeout: .now() + timeout) == .timedOut {
            throw NSError(
                domain: "LoopbackSSEServer", code: 1,
                userInfo: [NSLocalizedDescriptionKey: "listener did not become ready"]
            )
        }
        if let startError { throw startError }
        if port == 0 {
            throw NSError(
                domain: "LoopbackSSEServer", code: 2,
                userInfo: [NSLocalizedDescriptionKey: "listener bound port 0"]
            )
        }
    }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: queue)
        // Read the HTTP request line, then route by path. The observer's
        // start() opens MORE than the notification stream — it also calls
        // fetchProjectVoices() (GET /notifications/voices) before the SSE pipe
        // goes live. If every path got the open-ended SSE stream, that JSON
        // fetch would hang and stall start(), delaying the NotificationFired
        // delivery. So: SSE only for /events/stream; a fast empty JSON for
        // everything else.
        conn.receive(minimumIncompleteLength: 1, maximumLength: 8192) { [weak self] data, _, _, _ in
            guard let self else { return }
            let requestText = data.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            let firstLine = requestText.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
            let isEventsStream = firstLine.contains(" /events/stream")

            if isEventsStream {
                // CHUNKED transfer encoding is required: without a
                // Content-Length and without chunked framing, URLSession
                // cannot tell where the (open-ended SSE) response body ends
                // and BUFFERS it until the connection closes — so
                // `didReceive data:` never fires and the observer's handler
                // never runs (the nx-60zzf class of bug). Emitting the SSE
                // frame as one HTTP chunk forces immediate per-chunk delivery.
                let headers = [
                    "HTTP/1.1 200 OK",
                    "Content-Type: text/event-stream",
                    "Cache-Control: no-cache",
                    "Transfer-Encoding: chunked",
                    "Connection: keep-alive",
                    "", "",
                ].joined(separator: "\r\n")

                let frameBytes = Data(self.frame.utf8)
                // chunk = <hex length>\r\n<bytes>\r\n
                let chunk =
                    Data(String(format: "%X\r\n", frameBytes.count).utf8)
                    + frameBytes
                    + Data("\r\n".utf8)

                conn.send(content: Data(headers.utf8), completion: .contentProcessed { _ in
                    conn.send(content: chunk, completion: .contentProcessed { _ in
                        // Hold the connection open (do NOT send the terminating
                        // `0\r\n\r\n` chunk) — a real SSE stream stays live and
                        // the client closes it on Task cancellation.
                    })
                })
            } else {
                // Fast, fully-terminated empty-JSON response for any other path
                // (e.g. /notifications/voices). `{}` parses to an empty voice
                // map; the observer falls back to the Keychain global (nil here).
                let body = "{}"
                let bodyBytes = Data(body.utf8)
                let headers = [
                    "HTTP/1.1 200 OK",
                    "Content-Type: application/json",
                    "Content-Length: \(bodyBytes.count)",
                    "Connection: close",
                    "", "",
                ].joined(separator: "\r\n")
                conn.send(
                    content: Data(headers.utf8) + bodyBytes,
                    completion: .contentProcessed { _ in conn.cancel() }
                )
            }
        }
    }

    func stop() {
        listener.cancel()
    }
}

// MARK: - Tests

@MainActor
final class TTSNotificationFiredRoundTripTests: XCTestCase {

    /// The canonical `NotificationFired` SSE frame — same shape as the agent's
    /// stub-agent.ts `encodeNotificationFiredFrame` output.
    private func notificationFrame(body: String) -> String {
        let json = """
        {"id":"stub-notif-1","body":"\(body)","channel":"tts","title":"Nexus","project":"nx","created_at":"2026-05-25T00:00:00.000Z"}
        """
        return "event: NotificationFired\ndata: \(json)\n\n"
    }

    func testNotificationFiredDrivesSystemSpeechSynthPath() async throws {
        let body = "wave one regression build complete"

        // ── Stand up the loopback SSE server (env-gated skip on failure) ─────
        let server: LoopbackSSEServer
        do {
            server = try LoopbackSSEServer(frame: notificationFrame(body: body))
            try server.start()
        } catch {
            throw XCTSkip(
                "loopback SSE server unavailable in this test env (\(error.localizedDescription)) "
                + "— skipping the NotificationFired round-trip; the agent-side frame shape is "
                + "covered by apps/agent/src/testing/stub-agent-notification-sse.test.ts"
            )
        }
        defer { server.stop() }

        // ── Mocked synth path: record spoken text, no audio ─────────────────
        let recorder = SpokenTextRecorder()
        let spoke = expectation(description: "system-speech spawner invoked with notification body")
        let spawner: SystemSpeechSynthesizer.Spawner = { _, text in
            recorder.record(text)
            spoke.fulfill()
            // Fast-exiting process — no audible `say`, satisfies the FIFO
            // queue's wait-for-exit contract immediately.
            let p = Process()
            p.executableURL = URL(fileURLWithPath: "/usr/bin/true")
            try p.run()
            return p
        }

        let spyPlayer = SpyMP3Player()

        // ── Build the observer pointed at the loopback stub ─────────────────
        let endpoint = NexusEndpoint(
            baseURL: URL(string: "http://127.0.0.1:\(server.port)/")!
        )
        let client = NexusClient(endpoint: endpoint)
        let aggregate = NexusAggregateClient(client: client, name: "test-mac-tts")

        let observer = TTSObserver(
            client: aggregate,
            keychain: NoCredsKeychain(),          // no ElevenLabs → system speech
            audioPlayer: spyPlayer,               // proves MP3 branch not taken
            systemSpeech: SystemSpeechSynthesizer(spawner: spawner),
            elevenLabs: ElevenLabsClient(),
            settings: SettingsStore(defaults: UserDefaults(
                suiteName: "mac-tts-roundtrip-\(UUID().uuidString)"
            )!),
            notificationCenter: .current()
        )

        // start() blocks on the consume loop until stop() — run it detached.
        let runTask = Task { @MainActor in await observer.start() }

        // ── Assert: the synth path ran with the emitted notification body ───
        await fulfillment(of: [spoke], timeout: 20.0)

        observer.stop()
        runTask.cancel()

        // The system-speech (audio/synthesis) path was invoked with the exact
        // body of the NotificationFired event — the round-trip completed.
        XCTAssertTrue(
            recorder.texts.contains(body),
            "synth path must receive the NotificationFired body; got \(recorder.texts)"
        )
        // The ElevenLabs MP3 branch must NOT have been taken (no creds present).
        XCTAssertEqual(
            spyPlayer.playCount, 0,
            "no ElevenLabs creds → MP3 player must not be invoked (system-speech path only)"
        )
    }
}
