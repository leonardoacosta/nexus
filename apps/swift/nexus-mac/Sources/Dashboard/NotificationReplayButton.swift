// NotificationReplayButton — row-level mp3 replay for cached
// notifications (notifications-overhaul, task 3.7).
//
// Tap streams `GET /notifications/<id>/audio` into the injected
// `MP3PlayerProtocol`. The fetch is on-the-fly (no eager download
// across the history list); cancellation on disappear is via the
// surrounding `.task` modifier inside SwiftUI.

import SwiftUI
import NexusShared

struct NotificationReplayButton: View {
    let notificationId: String
    let audioAvailable: Bool
    let player: MP3PlayerProtocol?
    /// Aggregate client used to stream the mp3 bytes from whichever agent
    /// produced the notification. Defaulted to a fresh aggregate so the
    /// row component stays self-contained.
    var client: NexusAggregateClient = NexusAggregateClient()

    /// Single-channel playback state lives on the shared player, not locally:
    /// the icon and the same-row/cross-row tap logic both derive from
    /// `currentlyPlayingId`, which only clears on a real stop or natural finish.
    @ObservedObject private var audioPlayer = AudioPlayer.shared
    @State private var error: String?

    /// True while THIS row's audio is the clip the shared player is playing.
    private var isPlaying: Bool {
        audioPlayer.currentlyPlayingId == notificationId
    }

    var body: some View {
        if !audioAvailable {
            EmptyView()
        } else {
            Button {
                Task { await handleTap() }
            } label: {
                Image(systemName: isPlaying ? "stop.circle" : "play.circle")
                    .imageScale(.medium)
            }
            .buttonStyle(.borderless)
            .help(error.map { "Replay failed: \($0)" } ?? "Replay")
        }
    }

    /// Toggle playback for this row. A tap on the currently-playing row stops
    /// it. A tap on any other row stops whatever is playing first (single
    /// channel — `AudioPlayer.shared` singleton) and then starts this row.
    /// `AudioPlayer.shared.stop()` / `setCurrentlyPlaying(id:)` publish their
    /// `@Published` mutation on the main thread themselves, so this stays
    /// non-isolated to keep the cross-actor `streamNotificationAudio` call legal.
    private func handleTap() async {
        let wasPlayingThisRow = audioPlayer.currentlyPlayingId == notificationId
        AudioPlayer.shared.stop()
        guard !wasPlayingThisRow else { return }
        await play()
    }

    private func play() async {
        guard let player else {
            error = "no audio player configured"
            return
        }
        var bytes = Data()
        do {
            for try await chunk in client.streamNotificationAudio(id: notificationId) {
                bytes.append(chunk)
            }
            if bytes.isEmpty {
                error = "empty audio response"
                return
            }
            let ducking = DuckingMode(
                rawValue: UserDefaults.standard.string(forKey: "elevenlabs.ducking") ?? ""
            ) ?? .mix
            try player.play(mp3Data: bytes, ducking: ducking)
            // Track this row as the playing clip; the icon derives from it and
            // it clears on the next stop() or the natural-finish delegate.
            AudioPlayer.shared.setCurrentlyPlaying(id: notificationId)
            error = nil
        } catch {
            self.error = String(describing: error)
        }
    }
}
