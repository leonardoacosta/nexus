// SettingsRoutingView — presence-aware notification routing pane.
//
// Spec: openspec/changes/context-aware-routing (task nx-tis8m)
// Wireframe: docs/diagrams/presence-routing-research.html §4.
//
// Four blocks (in render order), matching the wireframe:
//   1. PRESENCE SOURCES        — per-source enable toggles (UI sugar).
//   2. WHEN PRESENCE IS UNKNOWN — non-critical + critical fail-mode pickers.
//   3. ROUTING RULES           — reorderable (drag) / deletable rule list.
//   4. SIMULATOR               — pick a presence vector, see which rule wins.
//
// Persistence: local UI state lives in SettingsStore (UserDefaults); each
// edit PATCHes the agent (`/notifications/settings` for the fail modes +
// master switch) and PUTs `/notifications/routing-rules` for the rule order,
// reusing the EXISTING NexusClient seam (no new transport). The agent
// broadcasts `SettingsChanged` over SSE; the pane re-reads on appear so a
// fleet-peer edit is reflected. The simulator mirrors the agent's
// first-match-wins evaluation — Rule 1 (active Mac, not in meeting) outranks
// any bedtime rule (decision Q1).

import SwiftUI
import NexusShared

// MARK: - Simulator inputs + engine (pure, headless-testable)

/// A presence vector the user pins in the simulator. `unknown` = the field is
/// stale / unreported, which the engine treats as "predicate not satisfiable".
enum SimPresence: String, CaseIterable, Identifiable {
    case unknown
    case yes
    case no

    var id: String { rawValue }
    var label: String {
        switch self {
        case .unknown: return "unknown"
        case .yes:     return "yes"
        case .no:      return "no"
        }
    }

    /// A concrete bool, or nil when unknown.
    var boolValue: Bool? {
        switch self {
        case .unknown: return nil
        case .yes:     return true
        case .no:      return false
        }
    }
}

/// The simulator's input vector — the three Phase-1 presence fields the seed
/// rules predicate on.
struct SimVector {
    var macActive: SimPresence = .unknown
    var inMeeting: SimPresence = .unknown
    var bedtime: SimPresence = .unknown
}

/// Pure first-match-wins evaluator. Mirrors `rules-engine.ts`: walk the
/// enabled rules in priority order; the first whose every non-nil predicate
/// is satisfied by a KNOWN matching vector field wins. An `unknown` field
/// never satisfies a predicate (fail-safe: the engine cannot confirm it), so a
/// rule that requires `macActive == true` does NOT fire when macActive is
/// unknown. Falls through to the terminal rule (or nil if none).
enum RoutingSimulator {
    /// Returns the winning rule, or nil when no rule matches AND no terminal
    /// fallback exists in the set.
    static func winner(for vector: SimVector, rules: [RoutingRule]) -> RoutingRule? {
        for rule in rules where rule.enabled {
            if satisfies(rule, vector) { return rule }
        }
        return nil
    }

    /// A predicate field matches when the rule does not constrain it (nil) OR
    /// the vector reports a KNOWN value equal to the requirement. A terminal
    /// rule (all predicates nil) always matches.
    private static func satisfies(_ rule: RoutingRule, _ v: SimVector) -> Bool {
        func ok(_ require: Bool?, _ actual: Bool?) -> Bool {
            guard let require else { return true }   // wildcard
            return actual == require                  // unknown (nil) != true/false
        }
        return ok(rule.requireMacActive, v.macActive.boolValue)
            && ok(rule.requireInMeeting, v.inMeeting.boolValue)
            && ok(rule.requireBedtime, v.bedtime.boolValue)
    }
}

// MARK: - View model

@MainActor
final class SettingsRoutingViewModel: ObservableObject {
    @Published var presenceAware: Bool
    @Published var noncriticalMode: PresenceFailMode
    @Published var criticalMode: PresenceFailMode
    @Published var enabledSources: Set<PresenceSource>
    @Published var rules: [RoutingRule]
    @Published var sim = SimVector()
    @Published var status: String?

    private let store: SettingsStore
    private let client: NexusClient

    init(store: SettingsStore = .shared, client: NexusClient = NexusClient()) {
        self.store = store
        self.client = client
        self.presenceAware = store.presenceAwareRouting
        self.noncriticalMode = store.unknownNoncriticalMode
        self.criticalMode = store.unknownCriticalMode
        self.enabledSources = store.enabledPresenceSources
        self.rules = store.routingRules
    }

    /// The simulator's current winner (nil = no rule matched).
    var simWinner: RoutingRule? {
        RoutingSimulator.winner(for: sim, rules: rules)
    }

    // MARK: Source toggles (local-only UI sugar; persisted to SettingsStore)

    func isSourceEnabled(_ source: PresenceSource) -> Bool {
        enabledSources.contains(source)
    }

    func toggleSource(_ source: PresenceSource, on: Bool) {
        if on { enabledSources.insert(source) } else { enabledSources.remove(source) }
        store.enabledPresenceSources = enabledSources
    }

    // MARK: Settings (PATCH /notifications/settings)

    func persistSettings() {
        store.presenceAwareRouting = presenceAware
        store.unknownNoncriticalMode = noncriticalMode
        store.unknownCriticalMode = criticalMode
        let body: [String: Any] = [
            "presence_aware_routing": presenceAware,
            "unknown_noncritical_mode": noncriticalMode.rawValue,
            "unknown_critical_mode": criticalMode.rawValue,
        ]
        Task {
            _ = await client.patchNotificationSettings(body)
            await MainActor.run { self.flash("Routing settings saved") }
        }
    }

    // MARK: Rules (PUT /notifications/routing-rules)

    func moveRule(from offsets: IndexSet, to destination: Int) {
        rules.move(fromOffsets: offsets, toOffset: destination)
        persistRules()
    }

    func deleteRule(at offsets: IndexSet) {
        rules.remove(atOffsets: offsets)
        persistRules()
    }

    private func persistRules() {
        store.routingRules = rules          // re-stamps priority = index
        rules = store.routingRules          // read back the reindexed copy
        let wire = rules.map { rule in
            NexusClient.RoutingRuleWire(
                id: rule.id,
                priority: rule.priority,
                condition: conditionMap(rule),
                action: ["kind": rule.action.rawValue],
                enabled: rule.enabled
            )
        }
        Task {
            _ = await client.putRoutingRules(wire)
            await MainActor.run { self.flash("Rule order saved") }
        }
    }

    private func conditionMap(_ rule: RoutingRule) -> [String: Bool] {
        var c: [String: Bool] = [:]
        if let v = rule.requireMacActive { c["macActive"] = v }
        if let v = rule.requireInMeeting { c["inMeeting"] = v }
        if let v = rule.requireBedtime { c["isBedtime"] = v }
        return c
    }

    // MARK: Re-read on appear (reflect SettingsChanged broadcast)

    func refreshFromAgent() {
        Task {
            if let settings = await client.fetchNotificationSettings() {
                await MainActor.run {
                    self.presenceAware = settings.presenceAwareRouting
                    self.noncriticalMode = settings.unknownNoncriticalMode
                    self.criticalMode = settings.unknownCriticalMode
                    self.store.presenceAwareRouting = settings.presenceAwareRouting
                    self.store.unknownNoncriticalMode = settings.unknownNoncriticalMode
                    self.store.unknownCriticalMode = settings.unknownCriticalMode
                }
            }
        }
    }

    private func flash(_ msg: String) {
        status = msg
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_800_000_000)
            status = nil
        }
    }
}

// MARK: - View

struct SettingsRoutingView: View {
    @StateObject private var model = SettingsRoutingViewModel()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Notification Routing & Presence").font(.title3).bold()

                masterToggle
                Divider()
                presenceSources
                Divider()
                unknownPresenceModes
                Divider()
                rulesList
                Divider()
                simulator

                if let status = model.status {
                    Text(status).font(.caption).foregroundStyle(.green)
                }
                Spacer(minLength: 12)
            }
            .padding(20)
        }
        .onAppear { model.refreshFromAgent() }
        .accessibilityIdentifier("settings.routing.pane")
    }

    private var masterToggle: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle("Presence-aware routing", isOn: $model.presenceAware)
                .onChange(of: model.presenceAware) { _, _ in model.persistSettings() }
                .accessibilityIdentifier("settings.routing.presenceAware")
            Text("When off, notifications route by project + meeting toggle (today's behaviour).")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var presenceSources: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PRESENCE SOURCES").font(.caption).bold().foregroundStyle(.secondary)
            ForEach(PresenceSource.allCases) { source in
                Toggle(source.label, isOn: Binding(
                    get: { model.isSourceEnabled(source) },
                    set: { model.toggleSource(source, on: $0) }
                ))
                .accessibilityIdentifier("settings.routing.source.\(source.rawValue)")
            }
        }
    }

    private var unknownPresenceModes: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("WHEN PRESENCE IS UNKNOWN").font(.caption).bold().foregroundStyle(.secondary)
            Picker("Non-critical", selection: $model.noncriticalMode) {
                ForEach(PresenceFailMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .onChange(of: model.noncriticalMode) { _, _ in model.persistSettings() }
            .accessibilityIdentifier("settings.routing.noncriticalMode")

            Picker("Critical", selection: $model.criticalMode) {
                ForEach(PresenceFailMode.allCases) { mode in
                    Text(mode.label).tag(mode)
                }
            }
            .onChange(of: model.criticalMode) { _, _ in model.persistSettings() }
            .accessibilityIdentifier("settings.routing.criticalMode")
        }
    }

    private var rulesList: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ROUTING RULES  (drag to reorder)")
                .font(.caption).bold().foregroundStyle(.secondary)
            if model.rules.isEmpty {
                ContentUnavailableView(
                    "No routing rules",
                    systemImage: "arrow.triangle.branch",
                    description: Text("Presence-aware routing falls back to the terminal digest.")
                )
            } else {
                List {
                    ForEach(model.rules) { rule in
                        HStack(spacing: 8) {
                            Text("\(rule.priority)")
                                .font(.system(.caption, design: .monospaced))
                                .foregroundStyle(.secondary)
                            Text(rule.label).font(.callout)
                            Spacer()
                            Image(systemName: "line.3.horizontal")
                                .foregroundStyle(.tertiary)
                        }
                        .accessibilityIdentifier("settings.routing.rule.\(rule.id)")
                    }
                    .onMove { model.moveRule(from: $0, to: $1) }
                    .onDelete { model.deleteRule(at: $0) }
                }
                .frame(minHeight: 140, maxHeight: 220)
                .accessibilityIdentifier("settings.routing.rulesList")
            }
        }
    }

    private var simulator: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("SIMULATOR  (which rule wins?)")
                .font(.caption).bold().foregroundStyle(.secondary)
            HStack(spacing: 12) {
                simPicker("mac active", selection: $model.sim.macActive)
                simPicker("meeting", selection: $model.sim.inMeeting)
                simPicker("bedtime", selection: $model.sim.bedtime)
            }
            Group {
                if let winner = model.simWinner {
                    Text("-> Rule \(winner.priority): \(winner.action.summary)")
                        .foregroundStyle(.blue)
                } else {
                    Text("-> no rule matches (notification still reaches the dashboard)")
                        .foregroundStyle(.orange)
                }
            }
            .font(.callout)
            .accessibilityIdentifier("settings.routing.simResult")
        }
    }

    private func simPicker(_ title: String, selection: Binding<SimPresence>) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.caption2).foregroundStyle(.secondary)
            Picker(title, selection: selection) {
                ForEach(SimPresence.allCases) { p in Text(p.label).tag(p) }
            }
            .labelsHidden()
            .accessibilityIdentifier("settings.routing.sim.\(title.replacingOccurrences(of: " ", with: ""))")
        }
    }
}

#if DEBUG
#Preview {
    SettingsRoutingView()
        .frame(width: 560, height: 600)
}
#endif
