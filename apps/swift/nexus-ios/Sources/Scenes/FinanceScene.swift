// FinanceScene (mx-tx7j) — FINANCE_TXN surface (plaid). Standalone (not in the
// work-triage aggregate). Renders FinanceBody over the Core spine. READ-ONLY.
//
// Design: ~/dev/mx/docs/nx-ui/nx-wireframe-finance.html (iOS compact, inset).
// Account-balance header; txns grouped by date — merchant, category pill,
// amount right-aligned mono (outflow / inflow green), pending badge.
// Tap -> DetailScene.

import SwiftUI
import NexusShared

struct FinanceScene: View {
    @ObservedObject var observer: TriageObserver

    var body: some View {
        List {
            if observer.isSampleData {
                Section { SampleCaptionRow(id: "finance-sample-caption") }
            }
            if let acct = primaryAccount {
                Section { AccountHeader(body: acct) }
            }
            ForEach(grouped, id: \.key) { group in
                Section(group.key) {
                    ForEach(group.items) { item in
                        NavigationLink(value: item) { FinanceRow(item: item) }
                    }
                }
            }
            if observer.finance.isEmpty {
                Section { ContentUnavailableView("No transactions", systemImage: "creditcard") }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Finance")
        .navigationDestination(for: TriageItem.self) { DetailScene(item: $0) }
        .accessibilityIdentifier("finance-scene")
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
    }

    /// First txn carrying balances stands in for the account header.
    private var primaryAccount: FinanceBody? {
        observer.finance.compactMap { $0.payload.finance }
            .first { $0.balanceCurrent != nil }
    }

    /// Transactions grouped by date(created_at) — newest group first.
    private var grouped: [(key: String, items: [TriageItem])] {
        let fmt = DateFormatter(); fmt.dateFormat = "EEE, MMM d"
        let cal = Calendar.current
        let buckets = Dictionary(grouping: observer.finance) { item -> String in
            guard let d = item.createdAt ?? item.lastActivityAt else { return "Earlier" }
            if cal.isDateInToday(d) { return "Today" }
            if cal.isDateInYesterday(d) { return "Yesterday" }
            return fmt.string(from: d)
        }
        let order = ["Today", "Yesterday"]
        return buckets.sorted { a, b in
            let ai = order.firstIndex(of: a.key) ?? Int.max
            let bi = order.firstIndex(of: b.key) ?? Int.max
            if ai != bi { return ai < bi }
            return a.key > b.key
        }.map { ($0.key, $0.value) }
    }
}

private struct AccountHeader: View {
    let body0: FinanceBody
    init(body: FinanceBody) { self.body0 = body }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "building.columns")
                .font(.title2).foregroundStyle(.blue)
                .frame(width: 40, height: 40)
                .background(Color.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 9))
            VStack(alignment: .leading, spacing: 2) {
                Text(body0.accountName ?? "Account").font(.subheadline.weight(.semibold))
                Text("\(body0.institution ?? "") ••••\(body0.accountMask ?? "")")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            Spacer(minLength: 4)
            VStack(alignment: .trailing, spacing: 1) {
                Text(money(body0.balanceCurrent))
                    .font(.title3.monospacedDigit().weight(.semibold))
                if let avail = body0.balanceAvailable {
                    Text("\(money(avail)) available")
                        .font(.caption2).foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityIdentifier("finance-account-header")
    }

    private func money(_ v: Double?) -> String {
        guard let v else { return "—" }
        return String(format: "$%.2f", v)
    }
}

private struct FinanceRow: View {
    let item: TriageItem
    private var b: FinanceBody? { item.payload.finance }

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(b?.merchantName ?? item.title).font(.body).lineLimit(1)
                HStack(spacing: 6) {
                    if let cat = b?.categoryPrimary { OutlinePill(text: cat) }
                    if b?.pending == true { OutlinePill(text: "pending", tint: .orange) }
                    if let ch = b?.paymentChannel {
                        Text(ch).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 4)
            if let b {
                Text(FinanceFormat.amount(b))
                    .font(.body.monospacedDigit())
                    .foregroundStyle(b.isInflow ? .green : .primary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("finance-row-\(item.id)")
    }
}

#if DEBUG
#Preview("Finance (sample)") {
    NavigationStack {
        FinanceScene(observer: {
            let o = TriageObserver(); o.setItemsForPreview(.sampleData, isSample: true); return o
        }())
    }
}
#endif
