// ElevenLabsSettingsView — SwiftUI view for managing the user's ElevenLabs
// API key, voice id, and ducking mode. Stores all three in the local
// Keychain via the NexusShared.Keychain helper.
//
// Spec: openspec/changes/swift-owns-elevenlabs-synth (task 1.4)

import SwiftUI

struct ElevenLabsSettingsView: View {
    @State private var apiKey: String = ""
    @State private var voiceId: String = ""
    @State private var ducking: DuckingMode = .mix
    @State private var statusMessage: String?
    @State private var statusIsError: Bool = false

    private let duckingKey = "elevenlabs.ducking"

    var body: some View {
        Form {
            Section("ElevenLabs") {
                SecureField("API Key", text: $apiKey)
                TextField("Voice ID", text: $voiceId)
                Picker("Ducking", selection: $ducking) {
                    Text("Mix").tag(DuckingMode.mix)
                    Text("Duck").tag(DuckingMode.duck)
                    Text("Pause others").tag(DuckingMode.pause)
                }
                HStack {
                    Button("Save", action: save)
                    Button("Test", action: test).disabled(apiKey.isEmpty || voiceId.isEmpty)
                }
                if let status = statusMessage {
                    Text(status).foregroundColor(statusIsError ? .red : .green).font(.caption)
                }
            }
        }
        .padding()
        .onAppear(perform: load)
    }

    private func load() {
        apiKey = (try? Keychain.get(KeychainAccount.elevenLabsApiKey)) ?? ""
        voiceId = (try? Keychain.get(KeychainAccount.elevenLabsVoiceId)) ?? ""
        if let raw = UserDefaults.standard.string(forKey: duckingKey),
           let mode = DuckingMode(rawValue: raw) {
            ducking = mode
        }
    }

    private func save() {
        do {
            if apiKey.isEmpty {
                try Keychain.delete(KeychainAccount.elevenLabsApiKey)
            } else {
                try Keychain.set(apiKey, for: KeychainAccount.elevenLabsApiKey)
            }
            if voiceId.isEmpty {
                try Keychain.delete(KeychainAccount.elevenLabsVoiceId)
            } else {
                try Keychain.set(voiceId, for: KeychainAccount.elevenLabsVoiceId)
            }
            UserDefaults.standard.set(ducking.rawValue, forKey: duckingKey)
            statusMessage = "Saved"
            statusIsError = false
        } catch {
            statusMessage = "Save failed: \(error)"
            statusIsError = true
        }
    }

    private func test() {
        Task {
            do {
                let client = ElevenLabsClient()
                let data = try await client.synthesize(
                    ElevenLabsSynthRequest(
                        text: "Nexus configuration test.",
                        voiceId: voiceId
                    )
                )
                try AudioPlayer.shared.play(mp3Data: data, ducking: ducking)
                statusMessage = "Test playback dispatched"
                statusIsError = false
            } catch {
                statusMessage = "Test failed: \(error)"
                statusIsError = true
            }
        }
    }
}
