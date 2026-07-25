// AudioPlayer — AVAudioPlayer wrapper that plays a notification MP3 with
// configurable ducking behavior.
//
// Spec: openspec/changes/swift-owns-elevenlabs-synth (task 1.3)
//       openspec/changes/mac-tts-runtime-wire-up (task 1.2 — conforms to
//       MP3PlayerProtocol so TTSObserver in NexusShared can drive playback
//       without importing the macOS-only AVAudioPlayer surface)
//
// Ducking modes (DuckingMode enum lives in NexusShared/Synthesis/MP3Player.swift).
// nx-lvyu9: the three modes are now genuinely audibly distinct. macOS has no
// AVAudioSession.duckOthers and no public per-application output volume, so the
// only lever that affects OTHER apps' audio is the system default-output-device
// master volume (CoreAudio kAudioHardwareServiceDeviceProperty_VirtualMainVolume).
// We save/lower/restore that volume around playback:
//   - .mix    — play over existing audio at full volume; no system change.
//   - .duck   — lower the system output to ~40% for the clip, restore after.
//               Other audio audibly dips into the background while we speak.
//   - .pause  — lower the system output to ~15% (near-silence of background
//               audio) for the clip, restore after. Distinctly quieter than .duck.
//
// Honest tradeoff: macOS lacks per-app output volume, so the system-volume dip
// also lowers OUR clip proportionally — but since the TTS clip is the focus, the
// net effect is "everything quieter," which is exactly the audible duck Leo
// wanted. The prior implementation only touched AVAudioPlayer.volume (90% on
// .duck — imperceptible) and left .pause as a dead no-op identical to .mix.
//
// Crash-safety: the saved volume is restored on natural finish AND on stop().
// If the process dies mid-clip the user's volume stays lowered — accepted as a
// rare-path cost of the cheapest feasible real ducking on macOS.

import AVFoundation
import AudioToolbox
import Combine
import CoreAudio
import Foundation
import NexusShared
import os.log

public final class AudioPlayer: NSObject, ObservableObject, AVAudioPlayerDelegate, @unchecked Sendable {
    public static let shared = AudioPlayer()

    // nx-5bqus: silent-failure diagnostics. The CoreAudio volume helpers below
    // are best-effort no-ops on failure — which previously left a silently
    // non-ducking device with no explanation. Log at .warning so an
    // uncontrollable / unsettable output device is greppable in Console.app
    // (subsystem matches TTSObserver's so the whole TTS pipeline traces together).
    private static let logger = Logger(
        subsystem: "dev.leonardoacosta.nexus.mac",
        category: "AudioPlayer"
    )
    private var player: AVAudioPlayer?
    private var onFinish: (() -> Void)?

    /// System output volume captured at the start of a ducked clip so it can be
    /// restored when the clip finishes or is cancelled. `nil` while no duck is
    /// active (i.e. `.mix` playback or idle).
    private var savedSystemVolume: Float?

    /// Fired when a clip finishes naturally (delegate didFinish), NOT on
    /// `stop()`. TTSObserver wires this to NowPlayingController.noteClipEnded().
    /// Spec: openspec/changes/airpods-tts-cancel.
    public var onPlaybackFinished: (() -> Void)?

    /// Fired when `stop()` halts a clip that was actually in flight — never on
    /// an idle stop (the replay button calls `stop()` unconditionally before
    /// starting a row, and that must not read as a cancellation). TTSObserver
    /// wires this to cancel its pending-speech queue.
    /// Spec: openspec/changes/tts-pipeline-stop-and-queue.
    public var onPlaybackStopped: (() -> Void)?

    /// The id of the notification row whose audio is currently playing, or
    /// `nil` when idle. Published so `NotificationReplayButton` can render its
    /// play/stop icon and detect a same-row re-tap. The notification-replay UI
    /// associates a row id via `setCurrentlyPlaying(id:)` right after it kicks
    /// off playback; it is cleared automatically on `stop()` and on natural
    /// finish. The TTS pipeline plays anonymous clips and never sets this.
    /// Spec: openspec/changes/fix-notification-replay-stop-button.
    @Published public private(set) var currentlyPlayingId: String?

    /// Associate `id` with the in-flight clip (or clear it with `nil`). Public
    /// because the replay button — not this player — knows which row's bytes it
    /// just handed to `play(mp3Data:ducking:)`.
    public func setCurrentlyPlaying(id: String?) {
        publishCurrentlyPlaying(id)
    }

    /// Mutate the `@Published` id on the main thread. Playback can be driven
    /// from a background `Task` (and AVAudioPlayer delegate callbacks fire on
    /// the thread that started playback), but `@Published` must publish on main.
    private func publishCurrentlyPlaying(_ id: String?) {
        if Thread.isMainThread {
            currentlyPlayingId = id
        } else {
            DispatchQueue.main.async { [weak self] in
                self?.currentlyPlayingId = id
            }
        }
    }

    public func play(
        mp3Data: Data,
        ducking: DuckingMode = .mix,
        onFinish: (() -> Void)? = nil
    ) throws {
        // A new clip supersedes any in-flight one — restore the prior duck
        // before applying this clip's mode so volume state never compounds.
        restoreSystemVolume()
        // The superseded clip's row id must go with it. A TTS clip (which never
        // sets an id) starting on top of a replayed row otherwise left the old
        // row's stop icon lit forever. The replay button re-associates its own
        // id via setCurrentlyPlaying(id:) right after this call returns.
        publishCurrentlyPlaying(nil)
        self.onFinish = onFinish
        let player = try AVAudioPlayer(data: mp3Data)
        player.delegate = self
        // Our own clip always plays at full AVAudioPlayer volume; the duck is
        // applied at the system-output level (see applyDuck) so it affects
        // OTHER apps' audio, not just our player.
        player.volume = 1.0
        applyDuck(ducking)
        player.prepareToPlay()
        player.play()
        self.player = player
    }

    /// Lower the system default-output-device volume for the given mode,
    /// stashing the prior value in `savedSystemVolume` for restore. `.mix` is a
    /// no-op. Best-effort: a CoreAudio failure (no controllable device, virtual
    /// output) leaves the volume untouched and `savedSystemVolume` nil.
    private func applyDuck(_ ducking: DuckingMode) {
        let target: Float
        switch ducking {
        case .mix:   return                 // no system change
        case .duck:  target = 0.40          // background audio dips
        case .pause: target = 0.15          // background audio near-silenced
        }
        guard let current = Self.readSystemOutputVolume() else { return }
        savedSystemVolume = current
        Self.setSystemOutputVolume(target)
    }

    /// Restore the system output volume captured by `applyDuck`. Idempotent —
    /// a no-op when no duck is active.
    private func restoreSystemVolume() {
        guard let saved = savedSystemVolume else { return }
        Self.setSystemOutputVolume(saved)
        savedSystemVolume = nil
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully _: Bool) {
        self.player = nil
        restoreSystemVolume()
        // Natural finish clears the replay-button tracking id with no stop tap.
        publishCurrentlyPlaying(nil)
        onFinish?()
        onFinish = nil
        // Natural finish — signal the Now-Playing grace window to start.
        onPlaybackFinished?()
    }

    /// Halt the current clip immediately and reset so the next `play()`
    /// constructs a fresh AVAudioPlayer. Safe no-op when nothing is playing
    /// (`player` is nil). `AVAudioPlayer.stop()` does NOT invoke the delegate
    /// `audioPlayerDidFinishPlaying(_:successfully:)`, so we clear `onFinish`
    /// here without firing it — the cancel path (NowPlayingController) drives
    /// the grace-window lifecycle directly, not via the finish callback.
    ///
    /// Spec: openspec/changes/airpods-tts-cancel (mac-tts-listener).
    public func stop() {
        // A stop tap (or cross-row switch) clears the replay-button tracking id
        // regardless of whether a clip is still mid-flight.
        publishCurrentlyPlaying(nil)
        // Always restore a ducked system volume, even if the player is already
        // nil — a cancel landing in the post-finish gap must not leave the
        // user's volume lowered.
        restoreSystemVolume()
        guard let player else { return }
        player.stop()
        self.player = nil
        onFinish = nil
        // A real in-flight halt — let the TTS pipeline drop its pending queue
        // rather than wait on a finish signal that stop() never sends.
        onPlaybackStopped?()
    }

    // MARK: - CoreAudio system-output volume (nx-lvyu9)
    //
    // macOS routes "the volume the menu-bar slider controls" through the default
    // output device's VirtualMainVolume property. Reading/writing it ducks ALL
    // app audio (there is no public per-app volume API), which is the cheapest
    // real way to make TTS playback duck other audio. Both helpers are
    // best-effort: any CoreAudio error returns nil / no-ops rather than throwing.

    /// Resolve the current default output device id, or `kAudioObjectUnknown`
    /// when none is controllable.
    private static func defaultOutputDevice() -> AudioDeviceID {
        var deviceID = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0,
            nil,
            &size,
            &deviceID
        )
        return status == noErr ? deviceID : AudioDeviceID(kAudioObjectUnknown)
    }

    /// Read the system output device's master volume scalar (0.0–1.0).
    /// Returns nil when no controllable device exposes the property.
    static func readSystemOutputVolume() -> Float? {
        let deviceID = defaultOutputDevice()
        guard deviceID != AudioDeviceID(kAudioObjectUnknown) else {
            // nx-5bqus: no controllable default output device — ducking is a
            // no-op and the clip plays at full volume without dipping others.
            logger.warning(
                "AudioPlayer: readSystemOutputVolume — no controllable default output device; ducking disabled"
            )
            return nil
        }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectHasProperty(deviceID, &address) else {
            // nx-5bqus: device exposes no master volume property (aggregate /
            // virtual output) — volume can't be read, so ducking stays off.
            logger.warning(
                "AudioPlayer: readSystemOutputVolume — device \(deviceID, privacy: .public) has no VirtualMainVolume property; ducking disabled"
            )
            return nil
        }
        var volume = Float(0)
        var size = UInt32(MemoryLayout<Float>.size)
        let status = AudioObjectGetPropertyData(
            deviceID,
            &address,
            0,
            nil,
            &size,
            &volume
        )
        guard status == noErr else {
            // nx-5bqus: the read itself failed — surface the OSStatus.
            logger.warning(
                "AudioPlayer: readSystemOutputVolume — read failed for device \(deviceID, privacy: .public) (status \(status, privacy: .public)); ducking disabled"
            )
            return nil
        }
        return volume
    }

    /// Set the system output device's master volume scalar, clamped to 0.0–1.0.
    /// Best-effort — silently no-ops when the property is unsettable.
    static func setSystemOutputVolume(_ value: Float) {
        let deviceID = defaultOutputDevice()
        guard deviceID != AudioDeviceID(kAudioObjectUnknown) else {
            // nx-5bqus: no controllable device — the duck/restore can't apply.
            logger.warning(
                "AudioPlayer: setSystemOutputVolume — no controllable default output device; volume unchanged"
            )
            return
        }
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
            mScope: kAudioDevicePropertyScopeOutput,
            mElement: kAudioObjectPropertyElementMain
        )
        var settable = DarwinBoolean(false)
        let settableStatus = AudioObjectIsPropertySettable(deviceID, &address, &settable)
        guard settableStatus == noErr, settable.boolValue else {
            // nx-5bqus: volume is not settable on this device — either the
            // query errored or the property is read-only. Duck/restore silently
            // did nothing before; now it's logged.
            logger.warning(
                "AudioPlayer: setSystemOutputVolume — device \(deviceID, privacy: .public) volume not settable (status \(settableStatus, privacy: .public), settable=\(settable.boolValue, privacy: .public)); volume unchanged"
            )
            return
        }
        var clamped = max(0.0, min(1.0, value))
        let size = UInt32(MemoryLayout<Float>.size)
        _ = AudioObjectSetPropertyData(deviceID, &address, 0, nil, size, &clamped)
    }
}

// MARK: - MP3PlayerProtocol conformance
//
// TTSObserver (in NexusShared) holds an `MP3PlayerProtocol` and stays
// platform-agnostic; this extension wires AudioPlayer.shared to the
// protocol's no-default-arg `play(mp3Data:ducking:)` signature.

extension AudioPlayer: MP3PlayerProtocol {
    public func play(mp3Data: Data, ducking: DuckingMode) throws {
        try play(mp3Data: mp3Data, ducking: ducking, onFinish: nil)
    }
}
