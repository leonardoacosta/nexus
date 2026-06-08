// DetailScene (mx-gojn) — the universal item detail. Renders the Core spine
// (identical for every kind) then switches over `TriagePayload` to render the
// matching family body. Reachable from every archetype list row tap.
//
// Spec: mx-gojn [nx-ui]. Design: ~/dev/mx/docs/nx-ui/nx-wireframe-detail-universal.html
// READ-ONLY: the only action is the Core.url "Open in <source>" deep-link.

import SwiftUI
import NexusShared

struct DetailScene: View {
    let item: TriageItem

    var body: some View {
        List {
            coreSection
            payloadSection
            if let url = item.url, let link = URL(string: url) {
                Section {
                    Link(destination: link) {
                        Label("Open in \(item.source)", systemImage: "arrow.up.right.square")
                    }
                    .accessibilityIdentifier("detail-open-in-source")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Detail")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("detail-scene")
    }

    // MARK: - Core spine (always)

    private var coreSection: some View {
        Section {
            HStack(spacing: 8) {
                Image(systemName: KindGlyph.symbol(for: item.kind))
                    .foregroundStyle(.blue)
                Text("\(item.source.uppercased()) · \(item.kind.rawValue)")
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            Text(item.title)
                .font(.headline)

            HStack {
                Text("Ball in court")
                    .foregroundStyle(.secondary)
                Spacer()
                BallChip(ball: item.ballInCourt)
            }

            if let author = item.author {
                LabeledContent("Author") {
                    HStack(spacing: 6) {
                        Avatar(name: author.displayName, size: 22)
                        VStack(alignment: .trailing, spacing: 0) {
                            Text(author.displayName)
                            if let h = author.handle {
                                Text(h).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if !item.participants.isEmpty {
                LabeledContent("Participants",
                               value: item.participants.map(\.displayName).joined(separator: ", "))
                    .lineLimit(2)
            }
            if let created = item.createdAt {
                LabeledContent("Created", value: TriageFormat.ago(created))
            }
            if let last = item.lastActivityAt {
                LabeledContent("Last activity", value: TriageFormat.ago(last))
            }
            if !item.stillPresentUpstream {
                Label(
                    "May have been resolved upstream — last seen \(TriageFormat.ago(item.lastSeenAt))",
                    systemImage: "clock.arrow.circlepath"
                )
                .font(.caption)
                .foregroundStyle(.orange)
            }
        } header: {
            Text("Core")
        }
    }

    // MARK: - Payload body (varies by case)

    @ViewBuilder
    private var payloadSection: some View {
        switch item.payload {
        case .comms(let b): commsBody(b)
        case .calendar(let b): calendarBody(b)
        case .finance(let b): financeBody(b)
        case .health(let b): healthBody(b)
        case .session(let b): sessionBody(b)
        case .unknown: EmptyView()
        }
    }

    @ViewBuilder
    private func commsBody(_ b: CommsBody) -> some View {
        Section("Message") {
            if let s = b.summary { Text(s) }
            if let body = b.body, body != b.summary {
                Text(body).font(.callout).foregroundStyle(.secondary)
            }
            HStack {
                PriorityChip(priority: b.priority)
                OutlinePill(text: b.suggestedDisposition.label, tint: .blue)
                if let up = b.upstreamState { OutlinePill(text: up) }
            }
            if let ev = b.dispositionEvidence {
                Label(ev, systemImage: "lightbulb")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private func calendarBody(_ b: CalendarBody) -> some View {
        Section("Event") {
            if b.allDay {
                LabeledContent("When", value: "All-day · \(b.startDate ?? "")")
            } else {
                LabeledContent("When", value: TriageFormat.timeRange(b.startTime, b.endTime))
            }
            if let loc = b.location { LabeledContent("Location", value: loc) }
            if let rsvp = b.selfResponseStatus { LabeledContent("Your RSVP", value: rsvp) }
            if let status = b.eventStatus, status.lowercased() == "cancelled" {
                Label("Cancelled", systemImage: "xmark.circle").foregroundStyle(.red)
            }
            if !b.recurrenceRules.isEmpty {
                Label("Recurring", systemImage: "repeat").font(.caption).foregroundStyle(.secondary)
            }
            if let url = b.conferenceUrl, let link = URL(string: url) {
                Link(destination: link) { Label("Join", systemImage: "video") }
            }
        }
        if !b.attendees.isEmpty {
            Section("Attendees") {
                ForEach(b.attendees) { a in
                    HStack {
                        Text(a.displayName ?? a.email)
                        if a.isSelf { OutlinePill(text: "you", tint: .blue) }
                        if a.organizer { OutlinePill(text: "organizer") }
                        Spacer()
                        Text(a.responseStatus ?? "—").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func financeBody(_ b: FinanceBody) -> some View {
        Section("Transaction") {
            LabeledContent("Amount") {
                Text(FinanceFormat.amount(b))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(b.isInflow ? .green : .primary)
            }
            if let m = b.merchantName { LabeledContent("Merchant", value: m) }
            if let c = b.categoryPrimary { LabeledContent("Category", value: c) }
            if b.pending { OutlinePill(text: "pending", tint: .orange) }
            if let acct = b.accountName {
                LabeledContent("Account", value: "\(acct) ••••\(b.accountMask ?? "")")
            }
            if let inst = b.institution { LabeledContent("Institution", value: inst) }
        }
    }

    @ViewBuilder
    private func healthBody(_ b: HealthBody) -> some View {
        Section("Metric") {
            LabeledContent("Value") {
                Text("\(FinanceFormat.trim(b.value)) \(b.unit)")
                    .font(.body.monospacedDigit())
            }
            if let mn = b.min, let avg = b.avg, let mx = b.max {
                LabeledContent("min / avg / max",
                               value: "\(FinanceFormat.trim(mn)) / \(FinanceFormat.trim(avg)) / \(FinanceFormat.trim(mx))")
            }
            if let dev = b.sourceDevice { LabeledContent("Device", value: dev) }
            if let s = b.periodStart, let e = b.periodEnd {
                LabeledContent("Window", value: "\(TriageFormat.ago(s)) … \(TriageFormat.ago(e))")
            }
            if let reason = b.anomalyReason {
                Label(reason, systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.red)
            }
        }
    }

    @ViewBuilder
    private func sessionBody(_ b: SessionBody) -> some View {
        Section("Session") {
            LabeledContent("Status", value: b.status)
            if let st = b.agentState { LabeledContent("Agent state", value: st) }
            if let m = b.machine { LabeledContent("Machine", value: m) }
            if let model = b.model { LabeledContent("Model", value: model) }
            if let br = b.branch { LabeledContent("Branch", value: br) }
            if let cost = b.totalCostUsd {
                LabeledContent("Cost") {
                    Text(String(format: "$%.2f", cost)).font(.body.monospacedDigit())
                }
            }
            if let spec = b.spec { LabeledContent("Spec", value: spec) }
        }
    }
}

// MARK: - Shared finance/number formatting

enum FinanceFormat {
    static func amount(_ b: FinanceBody) -> String {
        let mag = abs(b.amount)
        let sign = b.isInflow ? "+" : "−"
        return String(format: "%@$%.2f", sign, mag)
    }

    /// Trim a Double to a compact display string (no trailing .0).
    static func trim(_ v: Double) -> String {
        if v == v.rounded() { return String(Int(v)) }
        return String(format: "%.1f", v)
    }
}

#if DEBUG
#Preview("Detail (comms)") {
    NavigationStack { DetailScene(item: TriageItem.sampleComms[0]) }
}
#Preview("Detail (finance)") {
    NavigationStack { DetailScene(item: TriageItem.sampleFinance[2]) }
}
#endif
