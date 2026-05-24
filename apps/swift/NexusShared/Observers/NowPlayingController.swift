// NowPlayingController — owns the system Now-Playing session for the
// duration of TTS playback plus a short grace window, and routes a media
// play/pause press (AirPods single-stem-press) to a cancel hook.
//
// Spec: openspec/changes/airpods-tts-cancel (capability mac-tts-listener)
//
// Why this exists
// ───────────────
// AirPods (and any media remote / Now-Playing media key) expose a
// play/pause button the OS routes to the foreground "Now Playing" app. By
// populating `MPNowPlayingInfoCenter` + registering
// `MPRemoteCommandCenter` handlers while a TTS clip plays, the Mac
// dashboard becomes that app and can intercept a single press to cancel
// the in-flight TTS immediately. When TTS finishes we hold the session for
// a 2-second grace window (so a press landing just after the clip still
// reaches us — and so the follow-up airpods-stt-command can repurpose that
// press to start dictation), then resign so media keys return to the
// user's music app.
//
// Platform
// ────────
// MediaPlayer (MPNowPlayingInfoCenter / MPRemoteCommandCenter) is
// available on macOS + iOS but NOT watchOS. NexusShared is built for all
// three (project.yml `supportedDestinations: [macOS, iOS, watchOS]`), so
// the MediaPlayer-backed body is guarded by `#if canImport(MediaPlayer)`.
// On watchOS the public surface still exists as a no-op stub so callers
// (TTSObserver) compile unchanged.
//
// Threading
// ─────────
// `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` MUST be touched on
// the main thread — mutating them off-main can raise an uncatchable ObjC
// NSException. The whole class is `@MainActor`-isolated to enforce this at
// the type system level. Remote-command handler blocks are invoked by the
// OS on the main thread already; we re-enter the MainActor via a Task to
// satisfy isolation when calling the (MainActor) cancel hook.

import Foundation

@MainActor
public final class NowPlayingController {
    /// Invoked when a play/pause / play / pause remote command fires while
    /// the session is held. Wired by `TTSObserver` to stop the MP3 player +
    /// speech-synth. Re-entrant safe: a press in the post-clip grace window
    /// (nothing playing) calls this too — the wired stops are themselves
    /// no-ops, so the press is consumed without error.
    public var cancelHandler: (() -> Void)?

    /// Invoked when an AirPods double-press (`nextTrackCommand`) fires while
    /// the session is held and NOT already recording. Wired by `TTSObserver`
    /// to start the `SpeechController`. Spec: airpods-stt-command.
    public var sttStartHandler: (() -> Void)?

    /// Invoked when ANY held remote press fires while recording is active —
    /// the deterministic stop-and-send gesture (no silence auto-stop in v1).
    /// Wired by `TTSObserver` to stop the `SpeechController` + route the
    /// transcript. Spec: airpods-stt-command.
    public var sttStopHandler: (() -> Void)?

    /// True between an `sttStartHandler` dispatch and the next press that
    /// triggers `sttStopHandler`. While recording, a play/pause press routes
    /// to stop-STT (NOT cancel-TTS) so the user's reply isn't interrupted.
    /// Set externally by the observer once the SpeechController confirms it
    /// began (and cleared on stop) so the state machine never gets stuck
    /// "recording" after a denied-auth no-op start.
    public var isRecording = false

    /// Grace window held after a clip ends before the session is resigned.
    /// Injectable so tests can use a short window instead of waiting 2s.
    private let graceDuration: TimeInterval

    /// True once `acquire()` has populated now-playing info + registered
    /// command handlers, until `resign()` tears them down. Drives idempotent
    /// re-acquire (we don't double-register handlers).
    private var isAcquired = false

    /// Pending grace-window task. Cancelled + replaced on every
    /// `noteClipEnded()` (restart grace) and cancelled on `acquire()`
    /// (a new clip started — hold the session).
    private var graceTask: Task<Void, Never>?

    /// Default production grace window is 2 seconds (spec). `nonisolated` so
    /// it can be used as a default-argument expression in TTSObserver's
    /// (also MainActor) init without an actor-hop diagnostic — the init only
    /// assigns stored properties; no MediaPlayer surface is touched here.
    public nonisolated init(graceDuration: TimeInterval = 2.0) {
        self.graceDuration = graceDuration
    }

    // MARK: - Public lifecycle

    /// Acquire (or refresh) the Now-Playing session. Call before TTS
    /// playback begins. Idempotent: if already acquired, this only resets the
    /// grace window (cancels any pending resign) — handlers stay registered,
    /// now-playing info is left intact. First acquire populates now-playing
    /// info, sets playback state `.playing`, and enables remote commands.
    public func acquire() {
        // A new clip is starting — cancel any in-flight grace teardown so we
        // retain the session (spec: "Grace window resets on a new clip").
        graceTask?.cancel()
        graceTask = nil

        guard !isAcquired else {
            // Already own the session; re-acquire just kept us alive above.
            setPlaying(true)
            return
        }
        isAcquired = true
        setNowPlayingInfo()
        setPlaying(true)
        registerCommands()
    }

    /// Note that the current clip finished playing. Starts (or restarts) the
    /// 2-second grace timer; on expiry the session is resigned. Calling this
    /// when not acquired is a safe no-op.
    public func noteClipEnded() {
        guard isAcquired else { return }
        // Mark not-actively-playing but keep the session for the grace window.
        setPlaying(false)
        // Restart the grace timer (spec: grace resets per clip end).
        graceTask?.cancel()
        let duration = graceDuration
        graceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.resign()
        }
    }

    /// Tear down the Now-Playing session: clear now-playing info, set state
    /// `.stopped`, and disable + unhook remote commands. Safe to call when
    /// not acquired. Public for test reach + explicit teardown.
    public func resign() {
        graceTask?.cancel()
        graceTask = nil
        guard isAcquired else { return }
        isAcquired = false
        unregisterCommands()
        clearNowPlayingInfo()
    }

    // MARK: - Press routing (recording-aware)

    /// Route a play/pause / play / pause press. While recording, the press
    /// is the deterministic STT stop-and-send gesture and MUST NOT also
    /// cancel TTS. Otherwise it cancels in-flight TTS (legacy behaviour).
    /// Only fires while the session is held — a press outside the
    /// Now-Playing window never reaches the OS handler (commands disabled).
    fileprivate func handlePlayPausePress() {
        guard isAcquired else { return }
        if isRecording {
            sttStopHandler?()
        } else {
            cancelHandler?()
        }
    }

    /// Route an AirPods double-press (`nextTrackCommand`). When NOT recording
    /// it starts STT. When already recording it's a redundant stop gesture —
    /// treat it like any other press and route to stop-and-send so a
    /// double-press can't strand the recorder. Only fires while held.
    fileprivate func handleNextTrackPress() {
        guard isAcquired else { return }
        if isRecording {
            sttStopHandler?()
        } else {
            sttStartHandler?()
        }
    }

    // MARK: - Test seams

    /// Whether the controller currently owns the session. `@testable` reach.
    internal var debugIsAcquired: Bool { isAcquired }

    /// Drive a play/pause remote-command press in tests without a real
    /// AirPods stem. Mirrors the production handler path (recording-aware
    /// routing). Returns false (consumed nothing) when not acquired.
    @discardableResult
    internal func debugHandleRemoteCommand() -> Bool {
        guard isAcquired else { return false }
        handlePlayPausePress()
        return true
    }

    /// Drive an AirPods double-press (`nextTrackCommand`) in tests. Returns
    /// false when not acquired (press outside the Now-Playing window) so a
    /// double-press with no recent TTS provably does NOT start recording.
    @discardableResult
    internal func debugHandleNextTrack() -> Bool {
        guard isAcquired else { return false }
        handleNextTrackPress()
        return true
    }

    // MARK: - MediaPlayer-backed implementation (macOS / iOS)
}

#if canImport(MediaPlayer)
import MediaPlayer

@MainActor
extension NowPlayingController {
    /// Minimal now-playing metadata so the OS treats us as a real source.
    fileprivate func setNowPlayingInfo() {
        var info: [String: Any] = [:]
        info[MPMediaItemPropertyTitle] = "Nexus Notification"
        info[MPMediaItemPropertyArtist] = "Nexus"
        // Indeterminate duration — a TTS clip's length is unknown up front.
        info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    fileprivate func clearNowPlayingInfo() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        MPNowPlayingInfoCenter.default().playbackState = .stopped
    }

    fileprivate func setPlaying(_ playing: Bool) {
        MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused
    }

    fileprivate func registerCommands() {
        let center = MPRemoteCommandCenter.shared()
        // Route play/pause/toggle through the recording-aware press handler
        // (cancel-TTS when idle, stop-STT when recording). We add a fresh
        // target each acquire and remove ALL targets on resign, so there's
        // no double-registration leak across acquire/resign cycles.
        for command in [
            center.togglePlayPauseCommand,
            center.playCommand,
            center.pauseCommand,
        ] {
            command.isEnabled = true
            command.addTarget { [weak self] _ in
                // Handler fires on the main thread; hop to the MainActor to
                // satisfy isolation when calling the MainActor hooks.
                Task { @MainActor in
                    self?.handlePlayPausePress()
                }
                return .success
            }
        }
        // AirPods double-press maps to nextTrackCommand — the STT start/stop
        // gesture (airpods-stt-command). Routed through the recording-aware
        // next-track handler (start STT when idle, stop when recording).
        let next = center.nextTrackCommand
        next.isEnabled = true
        next.addTarget { [weak self] _ in
            Task { @MainActor in
                self?.handleNextTrackPress()
            }
            return .success
        }
    }

    fileprivate func unregisterCommands() {
        let center = MPRemoteCommandCenter.shared()
        for command in [
            center.togglePlayPauseCommand,
            center.playCommand,
            center.pauseCommand,
            center.nextTrackCommand,
        ] {
            command.removeTarget(nil)
            command.isEnabled = false
        }
    }
}
#else

// Platforms without MediaPlayer (watchOS) — no-op shims so NexusShared
// compiles and TTSObserver wiring is platform-agnostic.
@MainActor
extension NowPlayingController {
    fileprivate func setNowPlayingInfo() {}
    fileprivate func clearNowPlayingInfo() {}
    fileprivate func setPlaying(_ playing: Bool) {}
    fileprivate func registerCommands() {}
    fileprivate func unregisterCommands() {}
}
#endif
