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
#if os(macOS)
import CoreAudio
#endif

/// Read-side seam for the user's ElevenLabs API key + voice id. Production
/// code uses `LiveKeychainStore` which delegates to the static `Keychain`
/// enum; tests inject a stub.
public protocol KeychainStore: Sendable {
    func apiKey() -> String?
    func voiceId() -> String?
}

/// Stable string keys for fields the notification renderer stashes on
/// `UNNotificationContent.userInfo`. Centralised so the renderer (write
/// side, `TTSObserver.postBanner`) and the click handler (read side,
/// `NotificationActivationHandler`) agree on the spelling.
///
/// Spec: openspec/changes/adopt-reaper-into-nx-cron (task 3.3 — the
/// raw-osascript click-attribution fix path).
public enum NotificationUserInfoKeys {
    /// File path to open via `NSWorkspace.shared.open(_:)` when the user
    /// clicks the banner. Set only when the originating
    /// `NotificationEvent.logPath` is non-empty; absent keys mean "fall
    /// back to default activation".
    public static let logPath = "nexus.logPath"
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

    /// Owns the system Now-Playing session during TTS playback + a 2s grace
    /// window, and routes an AirPods play/pause press to TTS cancellation.
    /// Spec: openspec/changes/airpods-tts-cancel.
    private let nowPlaying: NowPlayingController

    /// On-device speech recognizer driven by the AirPods double-press STT
    /// gesture. Spec: airpods-stt-command.
    private let speech: SpeechController

    /// Project slug of the most recent `NotificationFired` — the routing
    /// target's project for a dictated reply. Captured on every handled
    /// event. `nil` until the first notification arrives.
    private var lastNotifiedProject: String?

    private var subscriptionTask: Task<Void, Never>?
    private var voiceEventTask: Task<Void, Never>?

    /// Cached per-project voice id map (notifications-overhaul, task 3.3).
    /// Populated on `start()` via `client.fetchProjectVoices()` and
    /// refreshed when a `VoiceOverrideChanged` SSE frame arrives. Reads
    /// happen on the MainActor (TTSObserver isolation) — the cache
    /// itself needs no extra synchronisation.
    private var projectVoiceCache: [String: String] = [:]

    public init(
        client: NexusAggregateClient,
        keychain: KeychainStore = LiveKeychainStore(),
        audioPlayer: MP3PlayerProtocol? = nil,
        // dashboard-ui-pass-v1 (task 2.6): SystemSpeechSynthesizer is now
        // an `actor`. Actor types initialize freely from any isolation
        // context, so the optional-defaulted-nil dance is no longer
        // necessary — non-optional default works directly.
        systemSpeech: SystemSpeechSynthesizer = SystemSpeechSynthesizer(),
        elevenLabs: ElevenLabsClient = ElevenLabsClient(),
        settings: SettingsStore = .shared,
        notificationCenter: UNUserNotificationCenter = .current(),
        nowPlaying: NowPlayingController = NowPlayingController(),
        // airpods-stt-command: the recognizer. Defaulted to the live
        // on-device engine; tests inject a stub TranscriptSource.
        speech: SpeechController = SpeechController(source: LiveTranscriptSource())
    ) {
        self.client = client
        self.keychain = keychain
        self.audioPlayer = audioPlayer
        self.systemSpeech = systemSpeech
        self.elevenLabs = elevenLabs
        self.settings = settings
        self.notificationCenter = notificationCenter
        self.nowPlaying = nowPlaying
        self.speech = speech

        // Route an AirPods play/pause press (while the Now-Playing session is
        // held) to TTS cancellation: stop the MP3 player, stop the system
        // speech fallback, and start the grace window. Both stops are no-ops
        // when their surface is idle, so a press during the post-clip grace
        // window is consumed harmlessly. Spec: airpods-tts-cancel.
        let player = audioPlayer
        let speech = systemSpeech
        let controller = nowPlaying
        nowPlaying.cancelHandler = { [weak self] in
            player?.stop()
            Task { await speech.stop() }
            controller.noteClipEnded()
            Self.logger.info("TTSObserver: AirPods play/pause cancelled in-flight TTS")
            _ = self
        }

        // Bridge the MP3 player's natural-finish callback to the grace window
        // so the session resigns ~2s after a clip ends with no further
        // activity. Idle conformers (test spies) leave this no-op.
        self.audioPlayer?.onPlaybackFinished = { [weak nowPlaying] in
            Task { @MainActor in nowPlaying?.noteClipEnded() }
        }

        // airpods-stt-command: wire the double-press STT gesture.
        // ── start: a double-press while the session is held starts the
        //    on-device recognizer. Mark the controller `isRecording` so the
        //    NEXT press routes to stop-and-send instead of cancel-TTS. Also
        //    hold the session open (cancel any pending grace teardown) so the
        //    user can speak past the 2s grace window.
        // `speech` is shadowed above by `let speech = systemSpeech` (the
        // cancel-handler captures the system synth). Bind the STT recognizer
        // under a distinct name from the parameter.
        let recognizer = self.speech
        nowPlaying.sttStartHandler = { [weak nowPlaying] in
            guard let nowPlaying else { return }
            nowPlaying.acquire()       // keep the session alive while dictating
            recognizer.start()
            nowPlaying.isRecording = recognizer.isRecording
            Self.logger.info(
                "TTSObserver: STT start (recording=\(recognizer.isRecording, privacy: .public))"
            )
        }
        // ── stop: the next press finalizes the transcript and routes it.
        nowPlaying.sttStopHandler = { [weak nowPlaying] in
            nowPlaying?.isRecording = false
            recognizer.stop()          // delivers via onTranscript below
            // Recording done — restart the grace window so the session
            // resigns shortly if nothing else happens.
            nowPlaying?.noteClipEnded()
            Self.logger.info("TTSObserver: STT stop — finalizing transcript")
        }
        // ── route: SpeechController hands back the finalized transcript on
        //    the MainActor. Forward it to the last-notified session, or fall
        //    back to a banner when no session resolves.
        recognizer.onTranscript = { [weak self] transcript in
            guard let self else { return }
            Task { @MainActor in
                await self.routeTranscript(transcript)
            }
        }
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

        // Startup mute check (bd:nx-8a4z3): a muted Mac makes every TTS clip
        // inaudible with no on-screen explanation — the user hears nothing and
        // assumes TTS is broken. Reading the system output mute state on
        // startup lets us log a clear, greppable warning so silent TTS is
        // explained, not mysterious. Best-effort: never blocks startup.
        Self.warnIfSystemOutputMuted()

        // Bootstrap the project voice cache before the SSE pipe goes
        // live. Best-effort — empty map on transport failure keeps the
        // global Keychain voice as the fallback.
        await refreshProjectVoiceCache()

        // Side-channel subscription: refresh the cache when the agent
        // publishes a `VoiceOverrideChanged` SSE frame. We piggy-back on
        // the generic `/events/stream` consumer because the dispatch
        // happens via the same lifecycle bus.
        //
        // Reconnect (nx-gsk4h): `consumeEvents` returns when the agent
        // restarts and the SSE pipe drops. Without a loop the side-channel
        // dies silently — VoiceOverrideChanged frames stop refreshing the
        // cache until app relaunch. Wrap it in the same backoff loop as the
        // notification stream below.
        let voiceTask = Task { [weak self] in
            guard let self else { return }
            await self.reconnectLoop(label: "voice") {
                await self.client.consumeEvents { event in
                    guard event.name == "VoiceOverrideChanged" else { return }
                    guard event.decodeVoiceOverrideChange() != nil else { return }
                    await self.refreshProjectVoiceCache()
                }
            }
        }
        self.voiceEventTask = voiceTask

        // Reconnect (nx-gsk4h): previously `consumeNotifications` was called
        // ONCE — on agent restart the SSE `/events` connection drops, the
        // consume call returns, the Task completes, and TTS was dead until
        // app relaunch. Wrap in an exponential-backoff reconnect loop so the
        // subscription survives agent restarts.
        let task = Task { [weak self] in
            guard let self else { return }
            await self.reconnectLoop(label: "notifications") {
                await self.client.consumeNotifications { event in
                    await self.handle(event: event)
                }
            }
        }
        self.subscriptionTask = task
        // Returns when the task completes (i.e. stop() was called). Block
        // here so callers can `await observer.start()` and treat it like a
        // long-running daemon.
        _ = await task.value
    }

    /// Drive a streaming subscription with exponential backoff so it
    /// survives agent restarts (nx-gsk4h). `consume` is expected to return
    /// when the underlying SSE pipe drops (clean disconnect) or to keep
    /// running until this Task is cancelled.
    ///
    /// Backoff: starts at 1s, doubles per consecutive short-lived return,
    /// capped at 30s. Resets to 1s after a connection that lasted longer
    /// than `longLivedThreshold` — so a flapping agent never pins us at the
    /// 30s ceiling while a hard-down agent still backs off. The loop exits
    /// promptly on cancellation (top-of-loop check + cancellation-aware
    /// sleep), preserving `stop()` semantics.
    private func reconnectLoop(
        label: String,
        consume: @escaping () async -> Void
    ) async {
        let baseBackoff: UInt64 = 1_000_000_000          // 1s
        let maxBackoff: UInt64 = 30 * 1_000_000_000      // 30s
        let longLivedThreshold: TimeInterval = 10        // 10s = "real" connection
        var backoff = baseBackoff
        var attempt = 0

        while !Task.isCancelled {
            let startedAt = Date()
            await consume()
            if Task.isCancelled { return }

            let elapsed = Date().timeIntervalSince(startedAt)
            if elapsed >= longLivedThreshold {
                // The connection lived long enough to count as healthy —
                // treat the drop as a one-off and reset the backoff so the
                // next reconnect is immediate-ish (1s), not punished.
                backoff = baseBackoff
            }

            attempt += 1
            let backoffSeconds = backoff / 1_000_000_000
            Self.logger.info(
                "TTSObserver: reconnecting \(label, privacy: .public) stream (attempt \(attempt, privacy: .public), backoff \(backoffSeconds, privacy: .public)s)"
            )

            // Cancellation-aware sleep — `stop()` cancels this Task and the
            // throw breaks the wait so we re-check `Task.isCancelled` and exit.
            try? await Task.sleep(nanoseconds: backoff)
            if Task.isCancelled { return }

            backoff = min(maxBackoff, backoff * 2)
        }
    }

    /// Cancel the subscription. Idempotent — second call is a no-op.
    public func stop() {
        if let task = subscriptionTask {
            Self.logger.info("TTSObserver: stop() cancelling subscription")
            task.cancel()
            subscriptionTask = nil
        }
        if let voiceTask = voiceEventTask {
            voiceTask.cancel()
            voiceEventTask = nil
        }
    }

    // MARK: - Startup mute check (bd:nx-8a4z3)

    /// Read the macOS system default-output-device mute state and log a clear
    /// warning when the system is muted, so silent TTS has a logged
    /// explanation instead of looking broken. Best-effort and `nonisolated
    /// static` (pure CoreAudio reads, no shared mutable state) so it can run
    /// from `start()` without main-actor hops.
    ///
    /// On any failure path — no default device, mute property unsupported,
    /// CoreAudio error — we log `debug` and return. Never blocks startup.
    ///
    /// macOS-only: NexusShared also builds for iOS/watchOS where the
    /// CoreAudio default-output-device mute property does not apply, so the
    /// whole body is gated behind `#if os(macOS)`. On other platforms this is
    /// a no-op.
    nonisolated static func warnIfSystemOutputMuted() {
        #if os(macOS)
        switch systemOutputMuted() {
        case .muted:
            logger.warning(
                "TTSObserver: system output is muted — TTS will be inaudible until unmuted (System Settings -> Sound, or the menu-bar volume control)"
            )
        case .unmuted:
            logger.debug("TTSObserver: system output mute check — not muted")
        case .unknown(let reason):
            logger.debug(
                "TTSObserver: system output mute state unavailable (\(reason, privacy: .public)) — continuing"
            )
        }
        #endif
    }

    #if os(macOS)
    /// Result of a system-output mute probe. `unknown` carries a short reason
    /// for the debug log so a query failure is diagnosable without being
    /// noisy at warn level.
    private enum OutputMuteState {
        case muted
        case unmuted
        case unknown(reason: String)
    }

    /// Query the default output device's `kAudioDevicePropertyMute` via
    /// CoreAudio. Returns `.unknown` (with a reason) on any error so the
    /// caller degrades to a debug log rather than crashing or warning falsely.
    /// `nonisolated` (pure CoreAudio reads, no shared mutable state) so the
    /// nonisolated `warnIfSystemOutputMuted()` can call it without a hop.
    private nonisolated static func systemOutputMuted() -> OutputMuteState {
        // 1. Resolve the default output device id.
        var deviceID = AudioDeviceID(0)
        var deviceIDSize = UInt32(MemoryLayout<AudioDeviceID>.size)
        var defaultDeviceAddress = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let deviceStatus = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &defaultDeviceAddress,
            0,
            nil,
            &deviceIDSize,
            &deviceID
        )
        guard deviceStatus == noErr, deviceID != kAudioObjectUnknown else {
            return .unknown(reason: "no default output device (status \(deviceStatus))")
        }

        // 2. Read the device's mute property on the output scope.
        var muteAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyMute,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectHasProperty(deviceID, &muteAddress) else {
            // Some devices (e.g. aggregate/virtual outputs) don't expose a
            // master mute property — not an error, just unknowable here.
            return .unknown(reason: "device has no mute property")
        }
        var muted = UInt32(0)
        var mutedSize = UInt32(MemoryLayout<UInt32>.size)
        let muteStatus = AudioObjectGetPropertyData(
            deviceID,
            &muteAddress,
            0,
            nil,
            &mutedSize,
            &muted
        )
        guard muteStatus == noErr else {
            return .unknown(reason: "mute read failed (status \(muteStatus))")
        }
        return muted != 0 ? .muted : .unmuted
    }
    #endif

    /// Pull the current per-project voice id map from the agent fleet.
    /// Falls back to an empty map on transport failure; the synth path
    /// then uses the Keychain global as the sole resolution source.
    /// (notifications-overhaul, task 3.3)
    private func refreshProjectVoiceCache() async {
        let map = await client.fetchProjectVoices()
        projectVoiceCache = map
        Self.logger.info(
            "TTSObserver: projectVoiceCache refreshed (count=\(map.count, privacy: .public))"
        )
    }

    /// Test seam: synchronously read the cache for assertions.
    /// (`@testable import` reach.)
    internal var debugProjectVoiceCache: [String: String] {
        projectVoiceCache
    }

    // MARK: - Per-event handler

    private func handle(event: NotificationEvent) async {
        let channel = event.channel ?? "<nil>"
        Self.logger.info(
            "TTSObserver: received id=\(event.id.uuidString, privacy: .public) channel=\(channel, privacy: .public)"
        )

        // airpods-stt-command: remember the routing target. The wire shape
        // (NotificationEvent / packages/core) carries `project` but NOT a
        // session id, so we capture the project here and resolve the active
        // session id at dictation time via GET /sessions (see
        // resolveSessionId). Capture for every reached event (tts + desktop)
        // so a desktop-only notification still primes a reply target.
        if let project = event.project, !project.isEmpty {
            lastNotifiedProject = project
        }

        // Stage 1 — filter. Both "tts" and "desktop" channels reach the
        // banner pipeline; the audio path below is internally gated to
        // "tts" only. Pre-2026-05-24 the filter was tts-only, which silently
        // dropped every banner because the agent's DEFAULT_RULES route to
        // "desktop" (see apps/agent/src/notifications/router.ts).
        guard event.channel == "tts" || event.channel == "desktop" else {
            Self.logger.debug(
                "TTSObserver: dropped non-tts/desktop event id=\(event.id.uuidString, privacy: .public) channel=\(channel, privacy: .public)"
            )
            return
        }

        // Stage 2 — banner. Posted BEFORE synth so the user sees the alert
        // immediately even when the network is slow or ElevenLabs times
        // out. Fire-and-forget; the OS handles authorisation gating.
        await postBanner(for: event)

        // Stage 3 — synth + playback (TTS channel only). ElevenLabs first,
        // system speech on any failure (missing key, network error, HTTP
        // non-2xx, tiny body). Desktop channel skips audio entirely.
        guard event.channel == "tts" else { return }
        await synthesise(event: event)
    }

    // MARK: - Body renderer (public for test reach)

    /// Format the banner body. When `event.items` is non-empty, render
    /// the body as `event.body` followed by a `• item` bullet list (one
    /// item per line) so users can scan multi-finding notifications
    /// without the previous run-on single-line collapse. When `items` is
    /// nil or empty, fall back to the raw `event.body` — preserving the
    /// pre-reaper behaviour for every other channel.
    ///
    /// Spec: openspec/changes/adopt-reaper-into-nx-cron (task 3.2).
    ///
    /// Whitespace policy: empty / whitespace-only entries are dropped so
    /// stray trailing newlines from the agent's bullet generator don't
    /// produce orphan `• ` lines. If filtering leaves no items, the body
    /// degrades cleanly to `event.body` alone.
    ///
    /// `nonisolated` because the function is pure-string and tests need
    /// to call it from non-main contexts. The enclosing class is
    /// `@MainActor`-isolated for the SSE pipeline, but rendering body
    /// text does not touch shared mutable state.
    public nonisolated static func renderBody(for event: NotificationEvent) -> String {
        let items = (event.items ?? []).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        if items.isEmpty {
            return event.body
        }
        let bullets = items.map { "• \($0)" }.joined(separator: "\n")
        // Two-part body: the existing summary line, blank line, then the
        // bullet block. Apple's banner truncates long bodies but the
        // full text is visible in Notification Center.
        if event.body.isEmpty {
            return bullets
        }
        return "\(event.body)\n\n\(bullets)"
    }

    // MARK: - Stage helpers

    private func postBanner(for event: NotificationEvent) async {
        let content = UNMutableNotificationContent()
        content.title = event.title ?? "Nexus"
        // nx-20caf: when the custom session name is present, surface it as
        // the banner subtitle (UNNotification supports a dedicated subtitle
        // line on macOS) so the banner reads title / session name / body —
        // without polluting the body text. Nil/empty -> no subtitle (no
        // change for older agents that omit the field).
        if let sessionName = event.sessionName, !sessionName.isEmpty {
            content.subtitle = sessionName
        }
        content.body = TTSObserver.renderBody(for: event)
        content.sound = .default
        // adopt-reaper-into-nx-cron task 3.3: stash the optional log path
        // on the request's userInfo so the UNUserNotificationCenterDelegate
        // can open it on click without re-resolving the original event.
        // Empty/whitespace logPath is treated as "no path" — fall through
        // to default activation. userInfo MUST be plist-serializable, so
        // we only forward the raw string.
        if let logPath = event.logPath, !logPath.isEmpty {
            content.userInfo[NotificationUserInfoKeys.logPath] = logPath
        }

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

        // Acquire (or refresh) the Now-Playing session BEFORE playback so an
        // AirPods press lands on us the instant audio begins. Idempotent —
        // a back-to-back notification just resets the grace window. Spec:
        // airpods-tts-cancel.
        nowPlaying.acquire()
        // Voice id resolution chain (notifications-overhaul, task 3.3):
        //   1. project override — projectVoiceCache[event.project]
        //   2. Keychain global override (per-user)
        //   3. SettingsStore persisted preference
        // If none yield a non-empty value we still attempt
        // SystemSpeechSynthesizer below.
        let projectVoice: String? = {
            guard let p = event.project, !p.isEmpty else { return nil }
            return projectVoiceCache[p]
        }()
        let voiceId = projectVoice ?? keychain.voiceId() ?? settings.elevenLabsVoiceId

        // Short-circuit when the key is missing — no point hitting the API
        // just to throw `missingKey`.
        guard keychain.apiKey() != nil, let voice = voiceId, !voice.isEmpty else {
            Self.logger.info(
                "TTSObserver: synth start (system-speech) — elevenlabs creds absent"
            )
            await speakSystem(body: body)
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
                await speakSystem(body: body)
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
            await speakSystem(body: body)
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

    private func speakSystem(body: String) async {
        Self.logger.info("TTSObserver: fallback to AVSpeechSynthesizer")
        await systemSpeech.speak(body)
        // The system-speech surface has no delegate-style finish callback, so
        // we await its FIFO drain and start the Now-Playing grace window when
        // the utterance completes. Spec: airpods-tts-cancel.
        await systemSpeech.waitForIdle()
        nowPlaying.noteClipEnded()
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

    // MARK: - STT transcript routing (airpods-stt-command)

    /// Route a finalized dictation transcript to the last-notified session.
    /// Resolves the session id from `lastNotifiedProject` via GET /sessions,
    /// then `POST /commands/send-text`. On an empty transcript, or when no
    /// session resolves, or when the send fails, the transcript is surfaced
    /// in a banner — never silently dropped.
    internal func routeTranscript(_ transcript: String) async {
        let text = transcript.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            Self.logger.info("TTSObserver: STT transcript empty — nothing to route")
            return
        }

        guard let resolved = await resolveSessionTarget() else {
            Self.logger.info(
                "TTSObserver: STT no session resolved — surfacing transcript in banner"
            )
            await postTranscriptBanner(text)
            return
        }

        do {
            try await client.sendText(
                sessionId: resolved.sessionId,
                text: text,
                originAgent: resolved.originAgent
            )
            Self.logger.info(
                "TTSObserver: STT transcript routed to session=\(resolved.sessionId, privacy: .public)"
            )
        } catch {
            Self.logger.error(
                "TTSObserver: STT sendText failed (\(String(describing: error), privacy: .public)) — banner fallback"
            )
            await postTranscriptBanner(text)
        }
    }

    /// Resolved routing target — session id plus the agent that owns it so
    /// `NexusAggregateClient.sendText` hits the right peer.
    private struct SessionTarget {
        let sessionId: String
        let originAgent: String?
    }

    /// Resolve the active session for `lastNotifiedProject`. The wire shape
    /// of `NotificationFired` (NexusShared `NotificationEvent` / packages/core)
    /// carries only `project`, NOT a session id — so we query
    /// `GET /sessions?withFingerprint=true` and pick the project's
    /// most-recent (`lastHeartbeat`) active session. Returns nil when no
    /// project was notified or no matching active session exists.
    private func resolveSessionTarget() async -> SessionTarget? {
        guard let project = lastNotifiedProject, !project.isEmpty else {
            return nil
        }
        let sessions = await client.fetchSessions(withFingerprint: true)
        guard let session = Self.pickActiveSession(in: sessions, project: project) else {
            return nil
        }
        return SessionTarget(
            sessionId: session.id,
            originAgent: session.agent ?? session.machine
        )
    }

    /// Pure selection: the most-recent (`lastHeartbeat`) active session for
    /// `project`. Extracted + `nonisolated static` so unit tests can prove
    /// the routing-target logic without standing up a network client.
    /// Returns nil when no active session matches the project.
    nonisolated static func pickActiveSession(
        in sessions: [Session],
        project: String
    ) -> Session? {
        sessions
            .filter { $0.project == project && $0.status == "active" }
            .max(by: { $0.lastHeartbeat < $1.lastHeartbeat })
    }

    /// Surface a dictated transcript that couldn't be routed as a banner so
    /// the user's words are never lost. Reuses the same
    /// `UNUserNotificationCenter` add path as the notification banner.
    private func postTranscriptBanner(_ transcript: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Nexus — undelivered reply"
        content.body = transcript
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: "nexus.stt.\(UUID().uuidString)",
            content: content,
            trigger: nil
        )
        do {
            try await notificationCenter.add(request)
            Self.logger.info("TTSObserver: STT transcript banner posted")
        } catch {
            Self.logger.error(
                "TTSObserver: STT transcript banner failed (\(String(describing: error), privacy: .public))"
            )
        }
    }

    // MARK: - Test seams (airpods-stt-command)

    /// Synchronously read the last-notified project for assertions.
    internal var debugLastNotifiedProject: String? { lastNotifiedProject }

    /// Set the last-notified project directly so routing tests don't need to
    /// drive a full SSE event through the private handler.
    internal func debugSetLastNotifiedProject(_ project: String?) {
        lastNotifiedProject = project
    }
}
