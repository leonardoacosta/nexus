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
    /// URL string for iOS to open in Safari on notification tap. Set by the
    /// `iopen` command; absent on all other notification types.
    public static let url = "url"
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
    /// Ordered provider chain (swift-tts-provider-chain, task 1.4): Kokoro is
    /// attempted first (when configured), then ElevenLabs. Typed as `any
    /// SpeechProvider` (not the concrete client types) so tests can inject
    /// stubs without touching real network/Keychain state.
    private let kokoro: any SpeechProvider
    private let elevenLabs: any SpeechProvider
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
        // Defaulted to nil (not `KokoroClient()`) because the real default
        // must read the SAME SettingsStore instance passed to this
        // initializer — a plain default-parameter expression can't reference
        // another parameter, so the live instance is built in the body below.
        kokoro: (any SpeechProvider)? = nil,
        elevenLabs: any SpeechProvider = ElevenLabsClient(),
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
        self.kokoro = kokoro ?? KokoroClient(settings: settings)
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

        // Side-channel subscription: a single `/events/stream` consumer that
        // dispatches on frame name. We piggy-back on the generic consumer
        // because these events fan out via the same lifecycle bus:
        //   - `VoiceOverrideChanged` -> refresh the per-project voice cache.
        //   - `SettingsChanged` -> apply the agent's post-PATCH gating state
        //     (ttsEnabled / banner / ducking / signalOnly) so a settings edit
        //     made on another machine — or on this one after an agent restart
        //     drops the local optimistic write — is picked up live, without an
        //     app relaunch (sync-notification-settings-round-trip, task 3.3).
        //     The agent broadcasts `SettingsChanged` on every successful PATCH
        //     to `/notifications/settings`
        //     (apps/agent/src/routes/notification-settings.ts).
        //
        // Reconnect (nx-gsk4h): `consumeEvents` returns when the agent
        // restarts and the SSE pipe drops. Without a loop the side-channel
        // dies silently — frames stop updating local state until app relaunch.
        // Wrap it in the same backoff loop as the notification stream below.
        let sideChannelTask = Task { [weak self] in
            guard let self else { return }
            await self.reconnectLoop(label: "events") {
                await self.client.consumeEvents { event in
                    switch event.name {
                    case "VoiceOverrideChanged":
                        guard event.decodeVoiceOverrideChange() != nil else { return }
                        await self.refreshProjectVoiceCache()
                    case "SettingsChanged":
                        await self.applySettingsChange(from: event)
                    default:
                        return
                    }
                }
            }
        }
        self.voiceEventTask = sideChannelTask

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

    // MARK: - Remote settings sync (sync-notification-settings-round-trip 3.3)

    /// Apply a remote `SettingsChanged` frame to the local gating state that
    /// `handle(event:)` / `postBanner` / `resolveDucking` read on every event.
    /// The agent broadcasts this after every successful PATCH to
    /// `/notifications/settings` with a camelCase payload
    /// (`ttsEnabled` / `bannerEnabled` / `duckingMode` / `signalOnly` / …), so
    /// a settings edit made on another machine — or on this one after an agent
    /// restart drops the local optimistic write — is reflected live.
    ///
    /// Why we write straight to the existing UserDefaults keys rather than a
    /// new SettingsStore overlay: TTSObserver's gates already read these keys
    /// directly — `settings.ttsEnabled` (SettingsStore, `nx.tts.enabled`), the
    /// raw `nx.notifications.bannerEnabled` in `postBanner`, and the raw
    /// `elevenlabs.ducking` in `resolveDucking`. Writing the server value back
    /// into the SAME key is the whole update: the next event reads it with no
    /// extra plumbing, and a parallel typed cache would be read by nobody
    /// (Reader Gate). `signalOnly` shares `nx.notifications.signalOnly` with the
    /// Settings panes. Each field is optional in the frame and applied only when
    /// present, so a partial PATCH broadcast never blanks an unrelated toggle.
    internal func applySettingsChange(from event: SSEEvent) async {
        guard let bytes = event.data.data(using: .utf8),
              let env = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any]
        else {
            Self.logger.debug("TTSObserver: SettingsChanged frame unparseable — ignoring")
            return
        }
        // Envelope tolerance: same `payload`-or-flat handling as the other
        // SSE decoders (SSEDecoder.swift).
        let payload = (env["payload"] as? [String: Any]) ?? env
        let defaults = UserDefaults.standard

        if let ttsEnabled = payload["ttsEnabled"] as? Bool {
            settings.ttsEnabled = ttsEnabled
        }
        if let bannerEnabled = payload["bannerEnabled"] as? Bool {
            defaults.set(bannerEnabled, forKey: "nx.notifications.bannerEnabled")
        }
        // Only accept a ducking value the Swift player understands
        // (duck|mix|pause). An undecodable string is left untouched rather than
        // clobbering `resolveDucking()`'s local value with something it would
        // silently coerce back to `.mix`.
        if let ducking = payload["duckingMode"] as? String,
           DuckingMode(rawValue: ducking) != nil {
            defaults.set(ducking, forKey: "elevenlabs.ducking")
        }
        if let signalOnly = payload["signalOnly"] as? Bool {
            defaults.set(signalOnly, forKey: "nx.notifications.signalOnly")
        }

        Self.logger.info(
            "TTSObserver: applied SettingsChanged (ttsEnabled=\(self.settings.ttsEnabled, privacy: .public))"
        )
    }

    // MARK: - Per-event handler

    /// `internal` (not `private`) so nexus-mac-Tests can drive the per-event
    /// pipeline directly and assert the behavioural contracts (channel filter,
    /// ttsEnabled gate, banner-vs-synth split). See TTSObserverTests header.
    func handle(event: NotificationEvent) async {
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

        // nx-azr0t: gate the spoken-audio path on the user's ttsEnabled
        // preference. The banner (Stage 2) is intentionally NOT gated — the
        // Stage-1 comment documents that both tts/desktop channels reach the
        // banner pipeline and only the audio path is internally gated. Mirrors
        // postBanner()'s bannerEnabled early-return: log at .info, then return.
        // Before this guard, toggling "TTS enabled" off in SettingsTtsView had
        // zero effect — audio played on every event.
        guard settings.ttsEnabled else {
            Self.logger.info(
                "TTSObserver: synth suppressed (nx.tts.enabled=false) id=\(event.id.uuidString, privacy: .public)"
            )
            return
        }
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
        // notification-fidelity (task 2.3): banner gate. Early-return when the
        // user toggled banners off. Read raw UserDefaults with the
        // .object(forKey:) as? Bool ?? true precedent (NOT .bool(forKey:),
        // which defaults absent -> false and would suppress on fresh install).
        // Mirrors resolveDucking()'s raw-UserDefaults read below. The audio /
        // TTS stage is NOT gated — only the visual banner.
        guard UserDefaults.standard.object(forKey: "nx.notifications.bannerEnabled") as? Bool ?? true else {
            Self.logger.info(
                "TTSObserver: banner suppressed (nx.notifications.bannerEnabled=false) id=\(event.id.uuidString, privacy: .public)"
            )
            return
        }
        let content = UNMutableNotificationContent()
        // notification-fidelity (task 2.2): title from displayTitle
        // (project · session ladder) instead of the bare event.title.
        content.title = event.displayTitle
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
        if let url = event.url, !url.isEmpty {
            content.userInfo[NotificationUserInfoKeys.url] = url
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

    /// A single provider-chain attempt: a human-readable name for logging, the
    /// conformer to call, and the resolved voice to pass it. `internal` (not
    /// `private`) — see `buildAttempts`/`walkProviderChain` below for why.
    internal struct SynthAttempt {
        let name: String
        let provider: any SpeechProvider
        let voice: String
    }

    /// Outcome of walking the provider chain: either a provider won (with its
    /// name + MP3 bytes for logging/playback), or every attempt failed/was
    /// undersized and the caller must fall back to system speech.
    internal enum ChainResult: Equatable {
        case played(providerName: String, data: Data)
        case exhausted
    }

    /// Undersized-payload guard shared by every provider attempt (swift-tts-
    /// provider-chain, task 1.4). A suspiciously small mp3 is almost always
    /// an error envelope the server returned with a 200 (observed against
    /// ElevenLabs; the same guard now applies uniformly to Kokoro).
    private static let minimumPayloadBytes = 1024

    /// Result of parsing a project voice-override id via `parseQualifiedVoice`.
    /// Mirrors `QualifiedVoice` (`packages/core/src/types/integrations.ts`).
    internal struct QualifiedVoice: Equatable {
        let provider: String
        let voice: String
    }

    /// Providers valid as the prefix of a qualified `provider:voice` project
    /// voice override. Mirrors `TTS_VOICE_PROVIDERS`
    /// (`packages/core/src/types/integrations.ts`).
    internal static let ttsVoiceProviders: Set<String> = ["elevenlabs", "kokoro"]

    /// Parse a project voice-override id into its provider + voice
    /// components. Splits on the FIRST `:` only, so a voice id may itself
    /// contain colons downstream without ambiguity. No separator (the
    /// pre-qualification bare format, e.g. an ElevenLabs UUID) defaults to
    /// `provider: "elevenlabs"` for backward compat — existing
    /// `project_voice_overrides` rows need no migration or re-save.
    ///
    /// Mirrors `parseQualifiedVoice` (`packages/core/src/types/integrations.ts`
    /// — API phase, `provider-qualified-project-voices` task 2.1). Pure and
    /// `nonisolated static` for the same testability reason as
    /// `buildAttempts` below.
    internal nonisolated static func parseQualifiedVoice(_ id: String) -> QualifiedVoice {
        guard let colonIndex = id.firstIndex(of: ":") else {
            return QualifiedVoice(provider: "elevenlabs", voice: id)
        }
        let provider = String(id[id.startIndex..<colonIndex])
        let voice = String(id[id.index(after: colonIndex)...])
        return QualifiedVoice(provider: provider, voice: voice)
    }

    /// Build the ordered provider-chain attempts from configuration —
    /// Kokoro (when a base URL is configured), then ElevenLabs (when a
    /// Keychain key + resolved voice are present). Pure and `nonisolated
    /// static` (no TTSObserver instance state) so NexusSharedTests — which
    /// cannot construct a full TTSObserver, since its `notificationCenter`
    /// default touches `UNUserNotificationCenter.current()` and that crashes
    /// outside a hosted TEST_HOST bundle (see TTSObserverTests.swift header
    /// in nexus-mac/Tests) — can drive the gating contract directly via
    /// `@testable import NexusShared`.
    ///
    /// (mac-tts-listener spec, "Kokoro is the preferred synthesis provider
    /// when configured" / "TTS synthesis falls back to AVSpeechSynthesizer"
    /// — swift-tts-provider-chain.)
    internal nonisolated static func buildAttempts(
        kokoro: any SpeechProvider,
        elevenLabs: any SpeechProvider,
        kokoroBaseUrl: String?,
        kokoroVoice: String?,
        elevenLabsApiKeyPresent: Bool,
        elevenLabsVoiceId: String?
    ) -> [SynthAttempt] {
        var attempts: [SynthAttempt] = []

        if let kokoroBaseUrl, !kokoroBaseUrl.isEmpty {
            let voice = kokoroVoice.flatMap { $0.isEmpty ? nil : $0 } ?? "af_heart"
            attempts.append(SynthAttempt(name: "kokoro", provider: kokoro, voice: voice))
        }

        // ElevenLabs voice id resolution (notifications-overhaul, task 3.3)
        // is unchanged by the provider chain — resolved by the caller and
        // passed in via `elevenLabsVoiceId`:
        //   1. project override — projectVoiceCache[event.project]
        //   2. Keychain global override (per-user)
        //   3. SettingsStore persisted preference
        if elevenLabsApiKeyPresent, let voice = elevenLabsVoiceId, !voice.isEmpty {
            attempts.append(SynthAttempt(name: "elevenlabs", provider: elevenLabs, voice: voice))
        }

        return attempts
    }

    /// Walk `attempts` in order, applying the shared undersized-payload
    /// guard, and return the first success or `.exhausted`. `nonisolated
    /// static` for the same testability reason as `buildAttempts` above.
    internal nonisolated static func walkProviderChain(
        text: String,
        attempts: [SynthAttempt]
    ) async -> ChainResult {
        for attempt in attempts {
            logger.info("TTSObserver: synth start (\(attempt.name, privacy: .public))")
            do {
                let data = try await attempt.provider.synthesize(text: text, voice: attempt.voice)
                if data.count < minimumPayloadBytes {
                    logger.error(
                        "TTSObserver: \(attempt.name, privacy: .public) returned undersized payload bytes=\(data.count, privacy: .public) — advancing"
                    )
                    continue
                }
                logger.info(
                    "TTSObserver: \(attempt.name, privacy: .public) returned \(data.count, privacy: .public) bytes"
                )
                return .played(providerName: attempt.name, data: data)
            } catch {
                logger.error(
                    "TTSObserver: \(attempt.name, privacy: .public) failed (\(String(describing: error), privacy: .public)) — advancing"
                )
            }
        }
        return .exhausted
    }

    private func synthesise(event: NotificationEvent) async {
        let body = event.body

        // Acquire (or refresh) the Now-Playing session BEFORE playback so an
        // AirPods press lands on us the instant audio begins. Idempotent —
        // a back-to-back notification just resets the grace window. Spec:
        // airpods-tts-cancel.
        nowPlaying.acquire()

        let projectVoice: String? = {
            guard let p = event.project, !p.isEmpty else { return nil }
            return projectVoiceCache[p]
        }()

        // provider-qualified-project-voices (task 3.1): a project override may
        // now be a qualified `provider:voice` id. Parse it and route the
        // parsed voice to the matching provider attempt below — `kokoro:`
        // overrides the Kokoro attempt's voice (leaving the ElevenLabs
        // resolution on its pre-override fallback chain); `elevenlabs:` or a
        // bare id (defaults to `elevenlabs` — see `parseQualifiedVoice`)
        // resolves exactly as before; an unknown prefix logs and is treated
        // as no override at all (falls through to the Keychain/Settings
        // default, same as no project voice being configured).
        var kokoroVoiceOverride: String?
        var elevenLabsVoiceId = keychain.voiceId() ?? settings.elevenLabsVoiceId
        if let projectVoice, !projectVoice.isEmpty {
            let qualified = Self.parseQualifiedVoice(projectVoice)
            switch qualified.provider {
            case "kokoro":
                kokoroVoiceOverride = qualified.voice
            case "elevenlabs":
                elevenLabsVoiceId = qualified.voice
            default:
                Self.logger.debug(
                    "TTSObserver: project voice has unknown provider prefix (\(qualified.provider, privacy: .public)) — ignoring override"
                )
            }
        }

        let attempts = Self.buildAttempts(
            kokoro: kokoro,
            elevenLabs: elevenLabs,
            kokoroBaseUrl: settings.kokoroBaseUrl,
            kokoroVoice: kokoroVoiceOverride ?? settings.kokoroVoice,
            elevenLabsApiKeyPresent: keychain.apiKey() != nil,
            elevenLabsVoiceId: elevenLabsVoiceId
        )

        guard !attempts.isEmpty else {
            Self.logger.info(
                "TTSObserver: synth start (system-speech) — no providers configured"
            )
            await speakSystem(body: body)
            return
        }

        switch await Self.walkProviderChain(text: body, attempts: attempts) {
        case .played(_, let data):
            playMP3(data: data)
        case .exhausted:
            Self.logger.error(
                "TTSObserver: provider chain exhausted — falling back to AVSpeechSynthesizer"
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
