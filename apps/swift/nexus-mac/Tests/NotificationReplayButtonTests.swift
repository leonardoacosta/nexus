// NotificationReplayButtonTests — unit coverage for the notification-drawer
// replay button's play/stop toggle state machine.
//
// Spec: openspec/changes/fix-notification-replay-stop-button (task 1.2)
//
// Target placement
// ────────────────
// Lives in nexus-mac-Tests (TEST_HOST = nexus.app per project.yml), matching
// AudioControlTests: the concrete AudioPlayer surface is macOS-app-context
// sensitive and the pre-push integration gate runs nexus-mac-Tests via the
// consolidated nexus-mac scheme.
//
// What we test
// ────────────
// The button's tap logic is a thin orchestration over AudioPlayer's
// `currentlyPlayingId` state machine (set on start, cleared on stop() and on
// the natural-finish delegate). SwiftUI button interaction + real audio
// playback are NOT exercisable headlessly from Linux — the on-device tap/audio
// behaviour is the [user:post] gate (task 2.1). Here we assert the observable
// contract the button renders from:
//   (a) a same-row re-tap routes through stop() and clears currentlyPlayingId;
//   (b) a cross-row switch stops the current row first, then the id reflects
//       the newly-started row;
//   (c) currentlyPlayingId clears automatically when the finish delegate fires
//       with no explicit stop tap.

import AVFoundation
import XCTest
@testable import NexusShared
// Concrete AudioPlayer lives in the nexus-mac app target (PRODUCT_NAME = nexus).
@testable import nexus

@MainActor
final class NotificationReplayButtonTests: XCTestCase {
    /// (a) Tapping a row while it is the currently-playing row stops playback —
    /// the button's same-row branch calls `stop()`, which clears the id.
    func testSameRowRetapStopsAndClearsCurrentlyPlayingId() {
        let player = AudioPlayer()
        player.setCurrentlyPlaying(id: "row-A")
        XCTAssertEqual(player.currentlyPlayingId, "row-A", "row A is the playing clip")

        // Same-row tap -> the button calls AudioPlayer.stop().
        player.stop()

        XCTAssertNil(player.currentlyPlayingId,
                     "a same-row re-tap stops playback and clears the tracking id")
    }

    /// (b) Tapping a different row while another is playing stops the current
    /// one first, then starts the new row — the id ends on the new row.
    func testCrossRowSwitchStopsCurrentThenTracksNewRow() {
        let player = AudioPlayer()
        player.setCurrentlyPlaying(id: "row-A")
        XCTAssertEqual(player.currentlyPlayingId, "row-A")

        // Button's cross-row branch: stop() the current row BEFORE the new one
        // starts (single-channel player).
        player.stop()
        XCTAssertNil(player.currentlyPlayingId, "current row is stopped before the new row starts")

        // ...then the new row's playback is kicked off and tracked.
        player.setCurrentlyPlaying(id: "row-B")
        XCTAssertEqual(player.currentlyPlayingId, "row-B",
                       "id reflects the newly-started row after the switch")
    }

    /// (c) A clip finishing on its own clears currentlyPlayingId via the
    /// AVAudioPlayer finish delegate — no stop tap required.
    func testNaturalFinishClearsCurrentlyPlayingId() throws {
        let player = AudioPlayer()
        player.setCurrentlyPlaying(id: "row-A")
        XCTAssertEqual(player.currentlyPlayingId, "row-A")

        // Drive the natural-finish path directly (a real AVAudioPlayer instance
        // is required as the delegate argument; a silent PCM WAV constructs one
        // without shipping a binary fixture).
        let finished = try AVAudioPlayer(data: Self.silentWav())
        player.audioPlayerDidFinishPlaying(finished, successfully: true)

        XCTAssertNil(player.currentlyPlayingId,
                     "natural finish clears the tracking id with no stop tap")
    }

    // MARK: - Fixtures

    /// Minimal valid 16-bit PCM mono WAV of silence — just enough for
    /// `AVAudioPlayer(data:)` to construct a delegate argument headlessly.
    private static func silentWav(frames: Int = 16, sampleRate: Int = 8000) -> Data {
        let channels = 1
        let bitsPerSample = 16
        let blockAlign = channels * bitsPerSample / 8
        let byteRate = sampleRate * blockAlign
        let dataSize = frames * blockAlign
        var d = Data()
        func u32(_ v: Int) {
            var x = UInt32(v).littleEndian
            withUnsafeBytes(of: &x) { d.append(contentsOf: $0) }
        }
        func u16(_ v: Int) {
            var x = UInt16(v).littleEndian
            withUnsafeBytes(of: &x) { d.append(contentsOf: $0) }
        }
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + dataSize); d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(channels)
        u32(sampleRate); u32(byteRate); u16(blockAlign); u16(bitsPerSample)
        d.append(contentsOf: Array("data".utf8)); u32(dataSize); d.append(Data(count: dataSize))
        return d
    }
}
