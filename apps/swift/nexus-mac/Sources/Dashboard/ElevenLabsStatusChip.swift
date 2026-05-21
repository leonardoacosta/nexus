// ElevenLabsStatusChip — header chip + popover that surfaces the
// current ElevenLabs key state without sending users to the Settings
// tab. (notifications-overhaul, task 3.9)
//
// Three states:
//   - keySet:      the Keychain holds a key (no liveness check)
//   - noKey:       Keychain is empty / Keychain access failed
//   - keyInvalid:  TTSObserver flipped state after a 401 from ElevenLabs
//
// The popover is owned by NotificationsViewModel so taps on the chip
// can be modeled as a single source of truth in the parent view.

import SwiftUI
import NexusShared

/// Externally visible state — assertable from tests and shared with
/// `TTSObserver` (which flips to `.keyInvalid` on a 401 synth response
/// once the upstream wiring lands).
public enum ElevenLabsKeyState: Equatable, Sendable {
    case unknown
    case noKey
    case keySet
    case keyInvalid
}

struct ElevenLabsStatusChip: View {
    let state: ElevenLabsKeyState

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .imageScale(.small)
                .foregroundStyle(tint)
            Text(label)
                .font(.caption2.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(.regularMaterial, in: Capsule())
        .help("ElevenLabs key state — tap to manage")
    }

    private var icon: String {
        switch state {
        case .unknown:     return "questionmark.circle"
        case .noKey:       return "key.slash"
        case .keySet:      return "key.fill"
        case .keyInvalid:  return "exclamationmark.triangle"
        }
    }

    private var tint: Color {
        switch state {
        case .unknown:     return .secondary
        case .noKey:       return .secondary
        case .keySet:      return .green
        case .keyInvalid:  return .red
        }
    }

    private var label: String {
        switch state {
        case .unknown:     return "ElevenLabs"
        case .noKey:       return "no key"
        case .keySet:      return "key set"
        case .keyInvalid:  return "key invalid"
        }
    }
}

/// Popover content — masked-show of current Keychain key, paste field,
/// Test button (synthesises a sample using global voice), Save button.
struct ElevenLabsStatusPopover: View {
    @ObservedObject var model: NotificationsViewModel
    @State private var apiKey: String = ""
    @State private var showKey: Bool = false
    @State private var statusMessage: String?
    @State private var statusIsError: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ElevenLabs key")
                .font(.headline)

            HStack(spacing: 6) {
                if showKey {
                    TextField("xi-…", text: $apiKey)
                        .textFieldStyle(.roundedBorder)
                } else {
                    SecureField("xi-…", text: $apiKey)
                        .textFieldStyle(.roundedBorder)
                }
                Button {
                    showKey.toggle()
                } label: {
                    Image(systemName: showKey ? "eye.slash" : "eye")
                }
                .buttonStyle(.borderless)
            }

            HStack {
                Button("Save", action: save)
                    .keyboardShortcut(.defaultAction)
                Button("Test", action: test)
                    .disabled(apiKey.isEmpty)
                Spacer()
                Button("Close") { model.elevenLabsPopover = false }
            }

            if let status = statusMessage {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(statusIsError ? .red : .green)
            }
        }
        .padding(14)
        .frame(width: 320)
        .onAppear { load() }
    }

    private func load() {
        apiKey = (try? Keychain.get(KeychainAccount.elevenLabsApiKey)) ?? ""
    }

    private func save() {
        do {
            if apiKey.isEmpty {
                try Keychain.delete(KeychainAccount.elevenLabsApiKey)
                model.elevenLabsKeyState = .noKey
            } else {
                try Keychain.set(apiKey, for: KeychainAccount.elevenLabsApiKey)
                model.elevenLabsKeyState = .keySet
            }
            statusMessage = "Saved"
            statusIsError = false
        } catch {
            statusMessage = "Save failed: \(error)"
            statusIsError = true
        }
    }

    private func test() {
        let key = apiKey
        let voiceId = (try? Keychain.get(KeychainAccount.elevenLabsVoiceId)) ?? ""
        guard !voiceId.isEmpty else {
            statusMessage = "No voice id configured"
            statusIsError = true
            return
        }
        Task {
            do {
                try Keychain.set(key, for: KeychainAccount.elevenLabsApiKey)
                let client = ElevenLabsClient()
                let data = try await client.synthesize(
                    ElevenLabsSynthRequest(
                        text: "Nexus key check.",
                        voiceId: voiceId
                    )
                )
                let ducking = DuckingMode(
                    rawValue: UserDefaults.standard.string(forKey: "elevenlabs.ducking") ?? ""
                ) ?? .mix
                try AudioPlayer.shared.play(mp3Data: data, ducking: ducking)
                statusMessage = "Test playback dispatched"
                statusIsError = false
                model.elevenLabsKeyState = .keySet
            } catch {
                statusMessage = "Test failed: \(error)"
                statusIsError = true
                model.elevenLabsKeyState = .keyInvalid
            }
        }
    }
}
