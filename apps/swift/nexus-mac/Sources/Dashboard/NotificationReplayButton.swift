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

    @State private var isPlaying: Bool = false
    @State private var error: String?

    var body: some View {
        if !audioAvailable {
            EmptyView()
        } else {
            Button {
                Task {
                    await play()
                }
            } label: {
                Image(systemName: isPlaying ? "stop.circle" : "play.circle")
                    .imageScale(.medium)
            }
            .buttonStyle(.borderless)
            .disabled(isPlaying)
            .help(error.map { "Replay failed: \($0)" } ?? "Replay")
        }
    }

    private func play() async {
        guard let player else {
            error = "no audio player configured"
            return
        }
        isPlaying = true
        defer { isPlaying = false }
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
            error = nil
        } catch {
            self.error = String(describing: error)
        }
    }
}
