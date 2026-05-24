// SpeechController — on-device speech-to-text for the AirPods dictation
// command. Wraps `SFSpeechRecognizer` + `AVAudioEngine`, captures mic
// audio while recording, and finalizes a transcript on stop.
//
// Spec: openspec/changes/airpods-stt-command (capability mac-tts-listener)
//
// Why this exists
// ───────────────
// `airpods-tts-cancel` shipped `NowPlayingController`, which owns the
// system Now-Playing session during TTS playback + a 2s grace window. This
// controller is the recognition engine that an AirPods double-press starts
// during that window: `start()` begins mic capture + on-device recognition
// (partial results allowed), `stop()` ends the audio engine and finalizes
// the best transcript, delivering it via the completion callback. The
// transcript is then routed to the last-notified session by `TTSObserver`.
//
// Privacy
// ───────
// `requiresOnDeviceRecognition = true` — audio never leaves the Mac.
//
// Authorization
// ─────────────
// Both speech-recognition and microphone TCC permissions are requested
// lazily on the first `start()` (no permission prompt at app launch). On
// denial, or when the recognizer is unavailable, `start()` degrades to a
// logged no-op: no recording begins and no crash. The companion TTS-cancel
// behaviour is unaffected.
//
// Platform
// ────────
// `Speech` + `AVFoundation` capture are available on macOS + iOS but the
// `AVAudioEngine` mic-tap recognition path is gated to macOS here (the only
// consumer today is the Mac dashboard). NexusShared is also built for
// watchOS, where `Speech` is absent — the whole live body is guarded by
// `#if canImport(Speech) && os(macOS)` and an inert no-op stub satisfies
// the public surface on every other platform so callers compile unchanged.
//
// Threading
// ─────────
// The class is `@MainActor`-isolated. `SFSpeechRecognitionTask`'s result
// handler is invoked by the framework off the main thread; we hop back to
// the MainActor before mutating any controller state or invoking the
// completion callback, so downstream consumers (NowPlayingController /
// TTSObserver, both MainActor) are never touched off-main.

import Foundation
import os.log

/// Test seam: a source of transcripts that bypasses the real recognizer.
/// Production uses the live `SFSpeechRecognizer`-backed engine; tests
/// inject a stub that finalizes a known transcript on `stop()` without a
/// real mic. Conformers are `@MainActor` because `SpeechController` drives
/// them from MainActor-isolated lifecycle methods.
@MainActor
public protocol TranscriptSource {
    /// Begin capture/recognition. Throws if the engine can't start (denied
    /// auth, unavailable recognizer, audio-engine failure). On throw the
    /// controller treats it as a graceful no-op.
    func startCapture(onPartial: @escaping (String) -> Void) throws
    /// Stop capture and return the finalized transcript (best guess). An
    /// empty string means "nothing recognized".
    func stopCapture() -> String
}

@MainActor
public final class SpeechController {
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "SpeechController"
    )

    /// Invoked on the MainActor with the finalized transcript when `stop()`
    /// completes a recording. Empty transcripts are still delivered so the
    /// caller can decide (e.g. skip routing / show "nothing heard").
    public var onTranscript: ((String) -> Void)?

    /// Optional partial-result callback (live preview). Fired on the
    /// MainActor as the recognizer produces interim hypotheses.
    public var onPartialTranscript: ((String) -> Void)?

    /// True between a successful `start()` and the next `stop()`.
    private(set) public var isRecording = false

    /// The injected recognition source. Defaults to the live engine on
    /// macOS; tests pass a stub.
    private let source: TranscriptSource

    /// `nonisolated` so it can be a default-argument expression in
    /// `TTSObserver`'s (MainActor) init without an actor-hop diagnostic — the
    /// init only assigns the stored source; no recognizer surface is touched.
    public nonisolated init(source: TranscriptSource) {
        self.source = source
    }

    /// Begin recording + recognition. No-op (logged) if already recording
    /// or if the source can't start (denied auth / unavailable recognizer).
    public func start() {
        guard !isRecording else {
            Self.logger.debug("SpeechController: start() ignored — already recording")
            return
        }
        do {
            try source.startCapture { [weak self] partial in
                // Source contract guarantees MainActor delivery; assert the
                // hop for live engines whose callbacks may fire off-main.
                MainActor.assumeIsolated {
                    self?.onPartialTranscript?(partial)
                }
            }
            isRecording = true
            Self.logger.info("SpeechController: recording started")
        } catch {
            // Graceful failure — denied auth, unavailable recognizer, or
            // audio-engine start error. Stay idle; never crash.
            Self.logger.error(
                "SpeechController: start failed — \(String(describing: error), privacy: .public)"
            )
            isRecording = false
        }
    }

    /// Stop recording, finalize, and deliver the transcript via
    /// `onTranscript`. No-op if not recording.
    public func stop() {
        guard isRecording else {
            Self.logger.debug("SpeechController: stop() ignored — not recording")
            return
        }
        isRecording = false
        let transcript = source.stopCapture()
        Self.logger.info(
            "SpeechController: recording stopped (chars=\(transcript.count, privacy: .public))"
        )
        onTranscript?(transcript)
    }
}

#if canImport(Speech) && os(macOS)
import Speech
import AVFoundation

/// Live recognition engine: `SFSpeechRecognizer` + `AVAudioEngine` with
/// on-device recognition. Lazy authorization on first `startCapture`.
@MainActor
public final class LiveTranscriptSource: TranscriptSource {
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "LiveTranscriptSource"
    )

    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    /// Best transcript observed so far — updated on every (partial or final)
    /// recognition result so `stopCapture()` can return the latest even when
    /// the final callback hasn't landed by the time the engine is torn down.
    private var latestTranscript = ""

    /// `nonisolated` for the same reason as `SpeechController.init` — only
    /// stored properties are assigned; `SFSpeechRecognizer`/`AVAudioEngine`
    /// construction is safe off the main actor.
    public nonisolated init(locale: Locale = Locale(identifier: "en-US")) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    // MARK: - Authorization (lazy)

    /// Block until speech-recognition authorization resolves. Returns true
    /// only on `.authorized`. Never force-unwraps the status.
    private func ensureSpeechAuthorized() async -> Bool {
        let current = SFSpeechRecognizer.authorizationStatus()
        if current == .authorized { return true }
        if current == .denied || current == .restricted { return false }
        // .notDetermined — request once.
        return await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status == .authorized)
            }
        }
    }

    /// Block until microphone authorization resolves. Uses
    /// `AVCaptureDevice` (available on macOS) for the .audio media type.
    private func ensureMicAuthorized() async -> Bool {
        let current = AVCaptureDevice.authorizationStatus(for: .audio)
        switch current {
        case .authorized:
            return true
        case .denied, .restricted:
            return false
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }
        @unknown default:
            return false
        }
    }

    // MARK: - TranscriptSource

    public func startCapture(onPartial: @escaping (String) -> Void) throws {
        // Authorization is async; the protocol method is sync. Kick the
        // permission resolution + engine start onto a Task so a first-time
        // prompt doesn't block the AirPods press handler. If auth is already
        // granted the engine starts within this run loop turn.
        Task { @MainActor [weak self] in
            guard let self else { return }
            guard await self.ensureSpeechAuthorized() else {
                Self.logger.error("LiveTranscriptSource: speech recognition not authorized")
                return
            }
            guard await self.ensureMicAuthorized() else {
                Self.logger.error("LiveTranscriptSource: microphone not authorized")
                return
            }
            guard let recognizer = self.recognizer, recognizer.isAvailable else {
                Self.logger.error("LiveTranscriptSource: recognizer unavailable")
                return
            }
            do {
                try self.beginEngine(recognizer: recognizer, onPartial: onPartial)
            } catch {
                Self.logger.error(
                    "LiveTranscriptSource: engine start failed — \(String(describing: error), privacy: .public)"
                )
                self.teardown()
            }
        }
    }

    private func beginEngine(
        recognizer: SFSpeechRecognizer,
        onPartial: @escaping (String) -> Void
    ) throws {
        latestTranscript = ""
        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        req.requiresOnDeviceRecognition = true
        self.request = req

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            // Audio tap fires on a real-time render thread — do NOT touch
            // MainActor state here. Appending to the recognition request is
            // thread-safe per Apple's API contract.
            self?.request?.append(buffer)
        }

        task = recognizer.recognitionTask(with: req) { [weak self] result, error in
            // Recognition handler fires off-main. Hop to the MainActor
            // before mutating state or invoking callbacks.
            let transcript = result?.bestTranscription.formattedString
            Task { @MainActor in
                guard let self else { return }
                if let transcript {
                    self.latestTranscript = transcript
                    onPartial(transcript)
                }
                if error != nil || (result?.isFinal ?? false) {
                    self.teardown()
                }
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
    }

    public func stopCapture() -> String {
        teardown()
        return latestTranscript
    }

    /// Tear down the audio engine + recognition task. Safe to call multiple
    /// times (engine stop / tap removal are idempotent enough for our use).
    private func teardown() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
        request = nil
        task = nil
    }
}

#else

/// watchOS / non-Speech platforms — inert source so NexusShared compiles.
/// `SpeechController` is constructible but `start()`/`stop()` never
/// recognize anything (the AirPods STT command is a macOS-only feature).
@MainActor
public final class LiveTranscriptSource: TranscriptSource {
    public nonisolated init(locale: Locale = Locale(identifier: "en-US")) {}
    public func startCapture(onPartial: @escaping (String) -> Void) throws {}
    public func stopCapture() -> String { "" }
}

#endif
