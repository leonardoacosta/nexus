// ProjectVoicesView — per-project ElevenLabs voice editor.
// (notifications-overhaul, task 3.11)
//
// Row per discovered project mapping: project slug, voice id text
// field, Test button (synthesises a sample line via ElevenLabsClient
// using the entered voice id), Delete icon. New project rows are
// manually addable via the "Add" affordance at the bottom.
//
// State is held locally then PUT/DELETE via NexusAggregateClient.
// Optimistic update: local map mutates first, then on server failure
// we revert and surface the error inline.

import SwiftUI
import NexusShared

@MainActor
final class ProjectVoicesViewModel: ObservableObject {
    @Published var entries: [Entry] = []
    @Published var newProject: String = ""
    @Published var newVoiceId: String = ""
    @Published var status: String?
    @Published var statusIsError: Bool = false

    let client: NexusAggregateClient
    let elevenLabs: ElevenLabsClient
    let player: MP3PlayerProtocol?

    struct Entry: Identifiable, Equatable {
        let id: String          // project slug — stable id
        var voiceId: String
    }

    init(
        client: NexusAggregateClient = NexusAggregateClient(),
        elevenLabs: ElevenLabsClient = ElevenLabsClient(),
        player: MP3PlayerProtocol? = AudioPlayer.shared
    ) {
        self.client = client
        self.elevenLabs = elevenLabs
        self.player = player
    }

    func load() async {
        let map = await client.fetchProjectVoices()
        entries = map.keys.sorted().map { Entry(id: $0, voiceId: map[$0] ?? "") }
    }

    /// PUT a row to the agent. Optimistic: caller mutates `entries` first
    /// then awaits this. On error we revert via `previousVoiceId`.
    /// Uses a fresh `NexusShared.NexusClient` pointed at the resolved
    /// endpoint so we get a typed error on non-2xx (the aggregate
    /// client's fan-out swallows per-agent errors).
    func save(entry: Entry, previousVoiceId: String?) async {
        do {
            let single = NexusShared.NexusClient(endpoint: .resolved)
            _ = try await single.putProjectVoice(
                project: entry.id,
                voiceId: entry.voiceId
            )
            status = "Saved \(entry.id)"
            statusIsError = false
        } catch {
            // Revert optimistic mutation.
            if let prev = previousVoiceId,
               let idx = entries.firstIndex(where: { $0.id == entry.id }) {
                entries[idx].voiceId = prev
            }
            status = "Save failed for \(entry.id): \(error)"
            statusIsError = true
        }
    }

    func delete(project: String) async {
        let snapshot = entries
        entries.removeAll { $0.id == project }
        do {
            let single = NexusShared.NexusClient(endpoint: .resolved)
            try await single.deleteProjectVoice(project: project)
            status = "Deleted \(project)"
            statusIsError = false
        } catch {
            entries = snapshot
            status = "Delete failed for \(project): \(error)"
            statusIsError = true
        }
    }

    func addNew() async {
        let trimmed = newProject.trimmingCharacters(in: .whitespacesAndNewlines)
        let voice = newVoiceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !voice.isEmpty else {
            status = "Project slug and voice id required"
            statusIsError = true
            return
        }
        let entry = Entry(id: trimmed, voiceId: voice)
        entries.removeAll { $0.id == trimmed }
        entries.append(entry)
        entries.sort { $0.id < $1.id }
        newProject = ""
        newVoiceId = ""
        await save(entry: entry, previousVoiceId: nil)
    }

    /// Synthesise a sample line via the entered voice id and play locally.
    /// Useful for confirming a voice id resolves before saving.
    func test(voiceId: String) async {
        do {
            let data = try await elevenLabs.synthesize(
                ElevenLabsSynthRequest(
                    text: "Per-project voice test.",
                    voiceId: voiceId
                )
            )
            let ducking = DuckingMode(
                rawValue: UserDefaults.standard.string(forKey: "elevenlabs.ducking") ?? ""
            ) ?? .mix
            try player?.play(mp3Data: data, ducking: ducking)
            status = "Test playback dispatched"
            statusIsError = false
        } catch {
            status = "Test failed: \(error)"
            statusIsError = true
        }
    }
}

struct ProjectVoicesView: View {
    @StateObject private var model = ProjectVoicesViewModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Per-project voices")
                    .font(.headline)
                Spacer()
                Text("\(model.entries.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.tertiary)
            }
            if model.entries.isEmpty {
                Text("No project overrides yet. Add one below.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach($model.entries) { $entry in
                rowView(entry: $entry)
            }
            Divider().padding(.vertical, 4)
            HStack(spacing: 6) {
                TextField("Project slug", text: $model.newProject)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 140)
                TextField("Voice id", text: $model.newVoiceId)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 220)
                Button("Add") {
                    Task { await model.addNew() }
                }
                .disabled(model.newProject.isEmpty || model.newVoiceId.isEmpty)
            }
            if let status = model.status {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(model.statusIsError ? .red : .green)
            }
        }
        .padding(.vertical, 6)
        .task {
            await model.load()
        }
    }

    @ViewBuilder
    private func rowView(entry: Binding<ProjectVoicesViewModel.Entry>) -> some View {
        let project = entry.wrappedValue.id
        HStack(spacing: 6) {
            Text(project)
                .font(.system(.body, design: .monospaced))
                .frame(width: 140, alignment: .leading)
            TextField("Voice id", text: entry.voiceId)
                .textFieldStyle(.roundedBorder)
            Button {
                let value = entry.wrappedValue.voiceId
                Task { await model.test(voiceId: value) }
            } label: {
                Image(systemName: "speaker.wave.2")
            }
            .buttonStyle(.borderless)
            .help("Synthesise a sample line with this voice id")
            Button {
                let snapshot = entry.wrappedValue
                Task {
                    await model.save(entry: snapshot, previousVoiceId: nil)
                }
            } label: {
                Image(systemName: "tray.and.arrow.down")
            }
            .buttonStyle(.borderless)
            .help("Save voice id")
            Button {
                Task { await model.delete(project: project) }
            } label: {
                Image(systemName: "trash")
            }
            .buttonStyle(.borderless)
            .help("Delete voice override")
        }
    }
}

