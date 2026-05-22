// SettingsAgentsView — editable list driven by AgentsConfigStore.
//
// Spec: openspec/changes/settings-tab-redesign (tasks 2.5 + 2.6,
// bd:nx-xbz6e, bd:nx-ugvr4)
//
// Two modes:
//   1. Structured editor — one row per [[agents]] entry with name/host/port
//      text fields, inline validation captions, delete button, "Add agent"
//      footer, and a read-only "interim seed" row that surfaces the legacy
//      SettingsStore.dashboardEndpoint (nx-4ohfs workaround).
//   2. Raw TOML editor — engaged when AgentsConfigStore.read() throws a
//      parse error. A TextEditor bound to the raw file contents lets the
//      operator fix malformed TOML by hand; Save Raw writes verbatim and
//      the next render reattempts the structured parse.
//
// Save → AgentsConfigStore.write → NotificationCenter post
// (.agentsConfigChanged) → NexusAggregateClient debounces 200ms and
// rebootstraps.

import SwiftUI
import NexusShared

@MainActor
final class SettingsAgentsViewModel: ObservableObject {
    @Published var entries: [AgentEntry] = []
    @Published var rawText: String = ""
    @Published var inRawMode: Bool = false
    @Published var status: String?
    @Published var statusIsError: Bool = false
    @Published var interimSeed: String?

    let path: URL

    init(path: URL = AgentsConfigStore.defaultPath) {
        self.path = path
        load()
        interimSeed = SettingsStore.shared.dashboardEndpoint
    }

    func load() {
        do {
            entries = try AgentsConfigStore.read(path: path)
            inRawMode = false
            rawText = ""
            status = nil
        } catch AgentsConfigError.parseFailure(let msg) {
            entries = []
            rawText = AgentsConfigStore.readRaw(path: path)
            inRawMode = true
            status = "Parse error — switched to raw editor (\(msg))"
            statusIsError = true
        } catch {
            entries = []
            rawText = AgentsConfigStore.readRaw(path: path)
            inRawMode = true
            status = "Load failed: \(error) — raw editor engaged"
            statusIsError = true
        }
    }

    func validate(_ entry: AgentEntry) -> [AgentValidationError] {
        AgentsConfigStore.validate(entry)
    }

    func addRow() {
        entries.append(AgentEntry(name: "", host: "", port: 7400, user: nil))
    }

    func deleteRow(id: UUID) {
        entries.removeAll { $0.id == id }
    }

    var allValid: Bool {
        entries.allSatisfy { validate($0).isEmpty }
    }

    func save() {
        do {
            try AgentsConfigStore.write(entries, path: path)
            NotificationCenter.default.post(
                name: .agentsConfigChanged,
                object: nil
            )
            status = "Saved \(entries.count) agent(s); reloading peers…"
            statusIsError = false
        } catch {
            status = "Save failed: \(error)"
            statusIsError = true
        }
    }

    func saveRaw() {
        do {
            try AgentsConfigStore.writeRaw(rawText, path: path)
            NotificationCenter.default.post(
                name: .agentsConfigChanged,
                object: nil
            )
            // Reattempt the structured parse — if it succeeds, we leave
            // raw mode automatically.
            load()
            if !inRawMode {
                status = "Saved raw TOML; structured parse succeeded."
                statusIsError = false
            }
        } catch {
            status = "Raw save failed: \(error)"
            statusIsError = true
        }
    }
}

struct SettingsAgentsView: View {
    @StateObject private var model = SettingsAgentsViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Agents").font(.title3).bold()
                if model.inRawMode {
                    rawEditor
                } else {
                    structuredEditor
                }
                if let interim = model.interimSeed, !interim.isEmpty {
                    interimSeedRow(interim)
                }
                if let status = model.status {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(model.statusIsError ? .red : .green)
                }
                Spacer(minLength: 12)
            }
            .padding(20)
        }
    }

    @ViewBuilder
    private var structuredEditor: some View {
        VStack(alignment: .leading, spacing: 12) {
            if model.entries.isEmpty {
                Text("No agents configured. Click 'Add agent' to register a peer.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach($model.entries) { $entry in
                agentRow(entry: $entry)
                Divider()
            }
            HStack {
                Button("Add agent") {
                    model.addRow()
                }
                Spacer()
                Button("Save") {
                    model.save()
                }
                .disabled(!model.allValid)
                .keyboardShortcut(.defaultAction)
            }
        }
    }

    @ViewBuilder
    private func agentRow(entry: Binding<AgentEntry>) -> some View {
        let errors = model.validate(entry.wrappedValue)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                TextField("name", text: entry.name)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 130)
                TextField("host", text: entry.host)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 220)
                TextField("port", value: entry.port, format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 80)
                Button {
                    model.deleteRow(id: entry.wrappedValue.id)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
                .help("Delete agent")
            }
            ForEach(errors, id: \.field) { err in
                Text("\(err.field.rawValue): \(err.message)")
                    .font(.caption2)
                    .foregroundStyle(.red)
            }
            Text(entry.wrappedValue.endpoint)
                .font(.caption.monospaced())
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private var rawEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Raw TOML editor (file is invalid)")
                .font(.headline)
                .foregroundStyle(.red)
            Text("The structured parser failed. Fix the TOML below by hand, then click Save Raw. The next render will reattempt the structured parse.")
                .font(.caption)
                .foregroundStyle(.secondary)
            TextEditor(text: $model.rawText)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 180)
                .overlay(
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Color.secondary.opacity(0.3))
                )
            HStack {
                Button("Save Raw") {
                    model.saveRaw()
                }
                Button("Reload") {
                    model.load()
                }
            }
        }
    }

    @ViewBuilder
    private func interimSeedRow(_ endpoint: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider()
            HStack {
                Image(systemName: "exclamationmark.circle")
                    .foregroundStyle(.orange)
                Text("Interim dashboard endpoint (nx-4ohfs seed)")
                    .font(.caption.weight(.semibold))
            }
            Text(endpoint)
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.secondary)
            Text("This is a legacy single-endpoint pin. Add this agent to the list above, then clear the seed to switch to agents.toml-driven aggregation.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
            Button("Clear interim seed") {
                SettingsStore.shared.dashboardEndpoint = nil
                model.interimSeed = nil
                NotificationCenter.default.post(
                    name: .agentsConfigChanged,
                    object: nil
                )
            }
            .buttonStyle(.borderless)
            .font(.caption)
        }
    }
}
