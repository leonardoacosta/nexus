// TTSObserver — subscribes to NotificationFired events and drives the
// macOS TTS pipeline (banner + ElevenLabs synth -> AVSpeechSynthesizer
// fallback).
//
// Spec: openspec/changes/mac-tts-runtime-wire-up (tasks 1.2 / 1.3 / 1.4 / 1.5)
//
// Why it lives here (NexusShared, not nexus-mac):
//   - The notification SSE stream lands in NexusAggregateClient, which is
//     cross-platform. Centralising the observer here lets future iOS /
//     watchOS clients reuse the dispatch surface.
//   - MP3 playback is per-platform; TTSObserver depends on the
//     `MP3PlayerProtocol` from NexusShared/Synthesis/MP3Player.swift, and
//     each app target supplies its concrete player at construction time.
//
// Fix story (nx-smger, P0):
// Previously the Mac listener wired through a view-attached `.task`
// modifier in NotificationsView. Under LSUIElement the app launches with
// no visible window, the view never mounts, and the subscription never
// starts — TTS was silently dead since 2026-05-16. This observer is
// mounted from `@main App.init()` so the subscription is window-
// independent. See design.md "@main App Init Wiring".

import Foundation
import os.log
import UserNotifications

/// Read-side seam for the user's ElevenLabs API key + voice id. Production
/// code uses `LiveKeychainStore` which delegates to the static `Keychain`
/// enum; tests inject a stub.
public protocol KeychainStore: Sendable {
    func apiKey() -> String?
    func voiceId() -> String?
}

/// Default Keychain-backed store. Reads on every call (Keychain has its
/// own cache; we don't want a stale snapshot if the user pastes a new key
/// while the observer is running).
public struct LiveKeychainStore: KeychainStore {
    public init() {}

    public func apiKey() -> String? {
        try? Keychain.get(KeychainAccount.elevenLabsApiKey)
    }

    public func voiceId() -> String? {
        try? Keychain.get(KeychainAccount.elevenLabsVoiceId)
    }
}

@MainActor
public final class TTSObserver: ObservableObject {
    // Pipeline-stage logger — `process:nexus` filter in Console.app reveals
    // the full chronological trace (received -> banner -> synth -> playback).
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "TTSObserver"
    )

    // Injected dependencies — defaulted so production wiring is one line
    // (`TTSObserver(client: aggregate, audioPlayer: AudioPlayer.shared)`).
    private let client: NexusAggregateClient
    private let keychain: KeychainStore
    private let audioPlayer: MP3PlayerProtocol?
    private let systemSpeech: SystemSpeechSynthesizer
    private let elevenLabs: ElevenLabsClient
    private let settings: SettingsStore
    private let notificationCenter: UNUserNotificationCenter

    private var subscriptionTask: Task<Void, Never>?

    public init(
        client: NexusAggregateClient,
        keychain: KeychainStore = LiveKeychainStore(),
        audioPlayer: MP3PlayerProtocol? = nil,
        systemSpeech: SystemSpeechSynthesizer? = nil,
        elevenLabs: ElevenLabsClient = ElevenLabsClient(),
        settings: SettingsStore = .shared,
        notificationCenter: UNUserNotificationCenter = .current()
    ) {
        self.client = client
        self.keychain = keychain
        self.audioPlayer = audioPlayer
        // `SystemSpeechSynthesizer.init` is @MainActor; the enclosing init
        // is @MainActor too so it's safe to build a default here. The
        // optional parameter form keeps the call site terse while
        // sidestepping Swift 5.10's "main-actor default in nonisolated
        // context" diagnostic when this initializer is referenced from a
        // type-only context (e.g. type checker).
        self.systemSpeech = systemSpeech ?? SystemSpeechSynthesizer()
        self.elevenLabs = elevenLabs
        self.settings = settings
        self.notificationCenter = notificationCenter
    }

    // MARK: - Lifecycle

    /// Subscribe to `NotificationFired` frames on every reachable agent.
    /// Returns only when `stop()` cancels the underlying task. Safe to
    /// call multiple times — second call is a no-op while a subscription
    /// is live.
    public func start() async {
        if subscriptionTask != nil {
            Self.logger.debug("TTSObserver: start() ignored — already subscribed")
            return
        }
        Self.logger.info("TTSObserver: starting NotificationFired subscription")
        let task = Task { [client] in
            await client.consumeNotifications { event in
                await self.handle(event: event)
            }
        }
        self.subscriptionTask = task
        // Returns when the task completes (i.e. stop() was called). Block
        // here so callers can `await observer.start()` and treat it like a
        // long-running daemon.
        _ = await task.value
    }

    /// Cancel the subscription. Idempotent — second call is a no-op.
    public func stop() {
        guard let task = subscriptionTask else { return }
        Self.logger.info("TTSObserver: stop() cancelling subscription")
        task.cancel()
        subscriptionTask = nil
    }

    // MARK: - Per-event handler

    private func handle(event: NotificationEvent) async {
        let channel = event.channel ?? "<nil>"
        Self.logger.info(
            "TTSObserver: received id=\(event.id.uuidString, privacy: .public) channel=\(channel, privacy: .public)"
        )

        // Stage 1 — filter. Only the "tts" channel triggers the audio +
        // banner pipeline. Other channels (desktop, slack, etc.) are
        // handled by SessionObserver's notification list.
        guard event.channel == "tts" else {
            Self.logger.debug(
                "TTSObserver: dropped non-tts event id=\(event.id.uuidString, privacy: .public)"
            )
            return
        }

        // Stage 2 — banner. Posted BEFORE synth so the user sees the alert
        // immediately even when the network is slow or ElevenLabs times
        // out. Fire-and-forget; the OS handles authorisation gating.
        await postBanner(for: event)

        // Stage 3 — synth + playback. ElevenLabs first, system speech on
        // any failure (missing key, network error, HTTP non-2xx, tiny body).
        await synthesise(event: event)
    }

    // MARK: - Stage helpers

    private func postBanner(for event: NotificationEvent) async {
        let content = UNMutableNotificationContent()
        content.title = event.title ?? "Nexus"
        content.body = event.body
        content.sound = .default

        let request = UNNotificationRequest(
            identifier: event.id.uuidString,
            content: content,
            trigger: nil
        )
        do {
            try await notificationCenter.add(request)
            Self.logger.info(
                "TTSObserver: banner posted id=\(event.id.uuidString, privacy: .public)"
            )
        } catch {
            // Authorisation denial or scheduling failure — log and continue.
            // The audio path still delivers the message; the user can
            // re-enable banners via System Settings.
            Self.logger.error(
                "TTSObserver: banner post failed id=\(event.id.uuidString, privacy: .public) error=\(String(describing: error), privacy: .public)"
            )
        }
    }

    private func synthesise(event: NotificationEvent) async {
        let body = event.body
        // Voice id resolution: Keychain wins (per-user override), fall back
        // to SettingsStore's persisted preference. If both are absent we
        // still attempt SystemSpeechSynthesizer below.
        let voiceId = keychain.voiceId() ?? settings.elevenLabsVoiceId

        // Short-circuit when the key is missing — no point hitting the API
        // just to throw `missingKey`.
        guard keychain.apiKey() != nil, let voice = voiceId, !voice.isEmpty else {
            Self.logger.info(
                "TTSObserver: synth start (system-speech) — elevenlabs creds absent"
            )
            speakSystem(body: body)
            return
        }

        Self.logger.info("TTSObserver: synth start (elevenlabs)")
        do {
            let request = ElevenLabsSynthRequest(text: body, voiceId: voice)
            let data = try await elevenLabs.synthesize(request)
            if data.count < 1024 {
                // Suspiciously small mp3 — almost always an error envelope
                // ElevenLabs returned with a 200 (rare but observed). Treat
                // as failure and fall through.
                Self.logger.error(
                    "TTSObserver: elevenlabs returned undersized payload bytes=\(data.count, privacy: .public) — falling back"
                )
                speakSystem(body: body)
                return
            }
            Self.logger.info(
                "TTSObserver: elevenlabs returned \(data.count, privacy: .public) bytes"
            )
            playMP3(data: data)
        } catch {
            Self.logger.error(
                "TTSObserver: elevenlabs failed (\(String(describing: error), privacy: .public)) — falling back to AVSpeechSynthesizer"
            )
            speakSystem(body: body)
        }
    }

    private func playMP3(data: Data) {
        guard let player = audioPlayer else {
            // No platform player wired (e.g. running in NexusSharedTests
            // host with no AudioPlayer extension). Fall back to system
            // speech so the message still surfaces.
            Self.logger.error(
                "TTSObserver: audioPlayer not configured — falling back to system speech"
            )
            return
        }
        let ducking = resolveDucking()
        do {
            try player.play(mp3Data: data, ducking: ducking)
            Self.logger.info("TTSObserver: audioPlayer.play succeeded")
        } catch {
            Self.logger.error(
                "TTSObserver: audioPlayer.play failed (\(String(describing: error), privacy: .public))"
            )
        }
    }

    private func speakSystem(body: String) {
        Self.logger.info("TTSObserver: fallback to AVSpeechSynthesizer")
        systemSpeech.speak(body)
    }

    /// Ducking lives in UserDefaults under the key SettingsView writes
    /// (`"elevenlabs.ducking"`). SettingsStore doesn't expose it yet, so we
    /// read raw UserDefaults here — same source of truth, no double-write.
    private func resolveDucking() -> DuckingMode {
        if let raw = UserDefaults.standard.string(forKey: "elevenlabs.ducking"),
           let mode = DuckingMode(rawValue: raw) {
            return mode
        }
        return .mix
    }
}
