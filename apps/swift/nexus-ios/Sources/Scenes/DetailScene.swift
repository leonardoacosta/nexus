// DetailScene (mx-gojn) — the universal item detail. Renders the Core spine
// (identical for every kind) then switches over `TriagePayload` to render the
// matching family body. Reachable from every archetype list row tap.
//
// Spec: mx-gojn [nx-ui]. Design: ~/dev/mx/docs/nx-ui/nx-wireframe-detail-universal.html
// READ-ONLY: the only action is the Core.url "Open in <source>" deep-link.

import SwiftUI
import UIKit
import NexusShared

struct DetailScene: View {
    let item: TriageItem

    // Viewer triage-ledger overlay (mx-dmj1). Seeded from `item.triage`, updated
    // optimistically from the POST response so the banner/pill reflect a
    // done/snooze without waiting for the next `/triage` poll.
    @State private var triage: LedgerEntry?
    @State private var posting = false
    @State private var actionError: String?

    init(item: TriageItem) {
        self.item = item
        _triage = State(initialValue: item.triage)
    }

    /// Whether to show the conversation thread (comms families only).
    private var isComms: Bool {
        switch item.kind {
        case .email, .chatMessage, .ticket, .workItem, .codeReview: return true
        default: return false
        }
    }

    // Aligned to docs/nx-ui/nx-detail-redesign.html: STATUS BANNER → IDENTITY
    // HEADER → CONVERSATION THREAD → "WHY IT'S HERE" → COMPACT META → ACTIONS.
    // Non-comms payloads keep their structured per-family body.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                CommsStatusBanner(item: item)

                if let triage {
                    LedgerOverlayStrip(triage: triage)
                        .padding(.horizontal, 16).padding(.top, 8)
                }

                identityHeader
                    .padding(.horizontal, 16).padding(.top, 14).padding(.bottom, 4)

                if isComms {
                    CommsConversationThread(item: item)
                        .padding(.horizontal, 16).padding(.top, 12)
                    whyCallout
                        .padding(.horizontal, 16).padding(.top, 14)
                } else {
                    payloadBody
                        .padding(.horizontal, 16).padding(.top, 12)
                }

                compactMetadata
                    .padding(.horizontal, 16).padding(.top, 14)
            }
            .padding(.bottom, 8)
        }
        .safeAreaInset(edge: .bottom) { actionsBar }
        .navigationTitle("Detail")
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("detail-scene")
    }

    // MARK: - Identity header (one line)

    private var identityHeader: some View {
        HStack(alignment: .top, spacing: 12) {
            Avatar(name: item.author?.displayName ?? item.source, size: 38)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title.isEmpty ? "(untitled)" : item.title)
                    .font(.system(size: 18, weight: .bold))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    Image(systemName: KindGlyph.symbol(for: item.kind))
                        .font(.caption2).foregroundStyle(.secondary)
                    Text(item.source.capitalized).foregroundStyle(.secondary)
                    if let who = item.author?.displayName, !who.isEmpty {
                        Text("· \(who)").foregroundStyle(.secondary)
                    }
                    if let ts = item.lastActivityAt ?? item.createdAt {
                        Text("· \(TriageFormat.ago(ts))").foregroundStyle(.secondary)
                    }
                }
                .font(.system(size: 12)).lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("detail-identity-header")
    }

    // MARK: - "Why it's here" callout

    @ViewBuilder
    private var whyCallout: some View {
        if let why = item.payload.comms?.dispositionEvidence ?? item.payload.comms?.summary,
           !why.isEmpty {
            HStack(alignment: .top, spacing: 0) {
                Rectangle().fill(Color.gray.opacity(0.6)).frame(width: 3)
                (Text("Why it's here:  ").font(.system(size: 13, weight: .semibold))
                    + Text(why).font(.system(size: 13).italic()))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12).padding(.vertical, 10)
            }
            .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 8))
            .accessibilityIdentifier("detail-why-callout")
        }
    }

    // MARK: - Compact metadata (only non-empty values)

    private var compactMetadata: some View {
        VStack(alignment: .leading, spacing: 6) {
            Divider().padding(.bottom, 4)
            if !item.participants.isEmpty {
                metaLine("Participants", item.participants.map(\.displayName).joined(separator: ", "))
            }
            if let created = item.createdAt { metaLine("Started", TriageFormat.ago(created)) }
            if let last = item.lastActivityAt { metaLine("Last activity", TriageFormat.ago(last)) }
            if !item.stillPresentUpstream {
                metaLine("Upstream", "may be resolved · last seen \(TriageFormat.ago(item.lastSeenAt))")
            }
        }
        .accessibilityIdentifier("detail-meta-row")
    }

    private func metaLine(_ label: String, _ value: String) -> some View {
        (Text("\(label)  ").font(.system(size: 12)).foregroundStyle(.tertiary)
            + Text(value).font(.system(size: 12)).foregroundStyle(.secondary))
            .lineLimit(2)
    }

    // MARK: - Actions bar

    private var actionsBar: some View {
        VStack(spacing: 6) {
            if let actionError {
                Text(actionError)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("detail-triage-error")
            }
            HStack(spacing: 10) {
                if let url = item.url, let link = URL(string: url) {
                    Link(destination: link) {
                        Label("Open in \(item.source.capitalized)", systemImage: "arrow.up.right.square")
                            .font(.system(size: 13, weight: .semibold))
                            .padding(.horizontal, 14).padding(.vertical, 9)
                            .background(Color.blue, in: RoundedRectangle(cornerRadius: 8))
                            .foregroundStyle(.white)
                    }
                    .accessibilityIdentifier("detail-open-in-source")
                }
                Button {
                    UIPasteboard.general.string = copyableText
                } label: {
                    Label("Copy text", systemImage: "doc.on.doc").font(.system(size: 13))
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("detail-copy-text")

                Spacer(minLength: 0)

                if posting { ProgressView().controlSize(.small) }
                snoozeMenu
                doneButton
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.bar)
        .overlay(Divider(), alignment: .top)
    }

    // MARK: - Triage actions (mx-dmj1)

    private var isResolved: Bool { triage?.statusUpper == "RESOLVED" }

    private var doneButton: some View {
        Button {
            performStatus("RESOLVED")
        } label: {
            Label("Done", systemImage: "checkmark.circle.fill").font(.system(size: 13, weight: .semibold))
        }
        .buttonStyle(.borderedProminent)
        .tint(.green)
        .disabled(posting || isResolved)
        .accessibilityIdentifier("detail-triage-done")
    }

    private var snoozeMenu: some View {
        Menu {
            Button("1 hour")    { performSnooze(interval: 3600) }
            Button("Tomorrow")  { performSnooze(interval: 86_400) }
            Button("Next week") { performSnooze(interval: 7 * 86_400) }
        } label: {
            Label("Snooze", systemImage: "moon.zzz").font(.system(size: 13))
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Color.secondary.opacity(0.15), in: RoundedRectangle(cornerRadius: 8))
        }
        .disabled(posting)
        .accessibilityIdentifier("detail-triage-snooze")
    }

    private func performStatus(_ status: String) {
        guard !posting else { return }
        posting = true
        actionError = nil
        Task {
            do {
                let updated = try await NexusClient().postTriageStatus(id: item.id, status: status)
                await MainActor.run { triage = updated; posting = false }
            } catch {
                await MainActor.run { actionError = "Couldn't update — try again"; posting = false }
            }
        }
    }

    private func performSnooze(interval: TimeInterval) {
        guard !posting else { return }
        posting = true
        actionError = nil
        let until = Date().addingTimeInterval(interval)
        Task {
            do {
                let updated = try await NexusClient().postTriageSnooze(id: item.id, until: until)
                await MainActor.run { triage = updated; posting = false }
            } catch {
                await MainActor.run { actionError = "Couldn't snooze — try again"; posting = false }
            }
        }
    }

    private var copyableText: String {
        [item.title, item.payload.comms?.summary, item.payload.comms?.body]
            .compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: "\n\n")
    }

    // MARK: - Non-comms payload body

    @ViewBuilder
    private var payloadBody: some View {
        List {
            switch item.payload {
            case .calendar(let b): calendarBody(b)
            case .finance(let b): financeBody(b)
            case .health(let b): healthBody(b)
            case .session(let b): sessionBody(b)
            // src-meds: MEDICATION items render in the dedicated Meds tab
            // (MedicationGroupScene / History), not the generic DetailScene.
            case .comms, .medication, .unknown: EmptyView()
            }
        }
        .listStyle(.insetGrouped)
        .frame(minHeight: 320)
        .scrollDisabled(true)
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

// MARK: - Status banner (disposition-driven)

/// iOS twin of the macOS StatusBanner — color + label by the comms disposition
/// / ball-in-court, per docs/nx-ui/nx-detail-redesign.html.
private struct CommsStatusBanner: View {
    let item: TriageItem

    var body: some View {
        HStack(spacing: 9) {
            Image(systemName: spec.symbol).font(.system(size: 13, weight: .bold))
            Text(spec.label).font(.system(size: 13, weight: .semibold))
            Spacer(minLength: 0)
        }
        .foregroundStyle(spec.tint)
        .padding(.horizontal, 16).padding(.vertical, 11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(spec.tint.opacity(0.14))
        .accessibilityIdentifier("detail-status-banner")
        .accessibilityLabel(spec.label)
    }

    private struct Spec { let label: String; let symbol: String; let tint: Color }

    private var spec: Spec {
        if let d = item.payload.comms?.suggestedDisposition {
            switch d {
            case .resolved: return Spec(label: "Likely resolved — no action needed", symbol: "checkmark", tint: .green)
            case .waiting:  return Spec(label: "Waiting on them", symbol: "hourglass", tint: .gray)
            case .inbox, .open:
                return item.ballInCourt == .mine
                    ? Spec(label: "Your move", symbol: "arrow.turn.up.right", tint: .blue)
                    : Spec(label: "Open", symbol: "tray", tint: .blue)
            }
        }
        switch item.ballInCourt {
        case .mine:    return Spec(label: "Your move", symbol: "arrow.turn.up.right", tint: .blue)
        case .theirs:  return Spec(label: "Waiting on them", symbol: "hourglass", tint: .gray)
        case .unclear: return Spec(label: "Needs a look", symbol: "questionmark.circle", tint: .blue)
        }
    }
}

// MARK: - Triage-ledger overlay (viewer decision, mx-dmj1)

/// The overlaid viewer decision: a status pill + a "snoozed until" indicator
/// when a future snooze is set. Rendered under the disposition banner when the
/// item carries a ledger row (`item.triage != nil`).
private struct LedgerOverlayStrip: View {
    let triage: LedgerEntry

    var body: some View {
        HStack(spacing: 8) {
            let s = LedgerStatusStyle.from(triage.statusUpper)
            Label(s.label, systemImage: s.symbol)
                .font(.system(size: 11, weight: .semibold))
                .padding(.horizontal, 9).padding(.vertical, 4)
                .background(s.tint.opacity(0.16), in: Capsule())
                .foregroundStyle(s.tint)
                .accessibilityIdentifier("detail-ledger-status")

            if triage.isSnoozeActive, let until = triage.snoozedUntil {
                Label(
                    "Snoozed until \(until.formatted(.dateTime.month().day().hour().minute()))",
                    systemImage: "moon.zzz.fill"
                )
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.orange)
                .accessibilityIdentifier("detail-ledger-snooze")
            }
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("detail-ledger-overlay")
    }
}

/// Label + SF Symbol + tint for a ledger status token
/// (INBOX | OPEN | WAITING | RESOLVED | ARCHIVED). Colors mirror the
/// disposition banner's semantics (green resolved, gray waiting, blue open).
private struct LedgerStatusStyle {
    let label: String
    let symbol: String
    let tint: Color

    static func from(_ statusUpper: String) -> LedgerStatusStyle {
        switch statusUpper {
        case "RESOLVED": return .init(label: "Resolved", symbol: "checkmark.circle.fill", tint: .green)
        case "WAITING":  return .init(label: "Waiting", symbol: "hourglass", tint: .gray)
        case "ARCHIVED": return .init(label: "Archived", symbol: "archivebox.fill", tint: Color.secondary)
        case "OPEN":     return .init(label: "Open", symbol: "tray.full.fill", tint: .blue)
        default:         return .init(label: statusUpper.capitalized, symbol: "tray.fill", tint: .blue)
        }
    }
}

// MARK: - Conversation thread (on-demand /thread fetch)

/// iOS twin of the macOS ConversationThread — fetches `NexusClient.fetchThread`
/// on appear and renders message bubbles (in = gray leading, out = blue
/// trailing). Loading + empty states; "View earlier in <source>" deep-link.
private struct CommsConversationThread: View {
    let item: TriageItem

    @State private var messages: [CommsMessage] = []
    @State private var phase: Phase = .loading

    private enum Phase: Equatable { case loading, loaded, empty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Conversation")
                .font(.system(size: 10.5, weight: .semibold))
                .kerning(0.6).textCase(.uppercase).foregroundStyle(.tertiary)
            switch phase {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading conversation…").font(.caption).foregroundStyle(.secondary)
                }
                .accessibilityIdentifier("detail-thread-loading")
            case .empty:
                Text("No earlier messages available for this item.")
                    .font(.caption).foregroundStyle(.secondary)
                    .accessibilityIdentifier("detail-thread-empty")
            case .loaded:
                if let url = item.url, let link = URL(string: url) {
                    Link(destination: link) {
                        Text("View earlier in \(item.source.capitalized) →")
                            .font(.system(size: 12)).foregroundStyle(.blue)
                    }
                    .frame(maxWidth: .infinity)
                    .accessibilityIdentifier("detail-thread-earlier-link")
                }
                ForEach(messages) { CommsMessageBubble(message: $0) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("detail-conversation-thread")
        .task(id: item.id) { await load() }
    }

    private func load() async {
        phase = .loading
        let result = (try? await NexusClient().fetchThread(source: item.source, id: item.id)) ?? []
        messages = result
        phase = result.isEmpty ? .empty : .loaded
    }
}

private struct CommsMessageBubble: View {
    let message: CommsMessage

    var body: some View {
        HStack {
            if message.isSelf { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 2) {
                Text(message.isSelf ? "You" : message.author)
                    .font(.system(size: 10.5))
                    .foregroundStyle(message.isSelf ? Color.white.opacity(0.75) : .secondary)
                Text(message.text)
                    .font(.system(size: 14))
                    .foregroundStyle(message.isSelf ? .white : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                if let ts = message.ts {
                    Text(TriageFormat.ago(ts))
                        .font(.system(size: 9.5))
                        .foregroundStyle(message.isSelf ? Color.white.opacity(0.55) : .secondary)
                        .frame(maxWidth: .infinity, alignment: message.isSelf ? .trailing : .leading)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            .background(
                message.isSelf ? Color.blue : Color.secondary.opacity(0.16),
                in: RoundedRectangle(cornerRadius: 14)
            )
            .frame(maxWidth: 300, alignment: message.isSelf ? .trailing : .leading)
            if !message.isSelf { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(message.isSelf ? "You" : message.author): \(message.text)")
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
#Preview("Detail (triaged + snoozed)") {
    var item = TriageItem.sampleComms[0]
    item.triage = LedgerEntry(
        id: item.id,
        source: item.source,
        status: "WAITING",
        manual: true,
        statusSetAt: Date(),
        snoozedUntil: Date().addingTimeInterval(7200)
    )
    return NavigationStack { DetailScene(item: item) }
}
#endif
