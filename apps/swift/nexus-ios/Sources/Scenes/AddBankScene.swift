// AddBankScene (mx-6s9s) — the Plaid "Add Bank" link flow, presented as a sheet
// from the Finance tab toolbar.
//
// Capability: src-finance. Backend: the mx Plaid control sidecar (port 8801),
// reached via `NexusClient.plaid*` (NexusClient+Plaid.swift, mx-dhhj).
//
// The Go sidecar drives Plaid Link server-side; this scene is a thin client-side
// state machine over three calls:
//
//   idle ──tap Add Bank──▶ linking ──open hosted_url in Safari──▶ polling
//                                                                    │
//        (poll /plaid/link/poll every 3s, ~5min timeout)            │
//                                                                    ▼
//   success(institution) ◀──exchange──── exchanging ◀──done+public_token──┘
//
// Failure paths (timeout / network / exchange failure) land in .error(message)
// with a Retry affordance. The user can also tap "I finished in Safari" to force
// an immediate poll, or "Open Safari again" if they dismissed the page.
//
// External URL on iOS uses `@Environment(\.openURL)` (the iOS pattern; the macOS
// dashboard uses NSWorkspace). Loading / error / success states are explicit,
// following the Meds scenes' state-handling conventions.

import SwiftUI
import NexusShared

struct AddBankScene: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    /// One transient client for this flow (mirrors DetailScene's `NexusClient()`
    /// thread fetch — a short-lived one-shot, not an owned observer).
    private let client = NexusClient()

    @State private var phase: Phase = .idle
    /// The active link handle (token + hosted URL + server-authoritative label),
    /// retained across poll/exchange so the label threads through unchanged.
    @State private var link: PlaidLinkStart?
    @State private var pollTask: Task<Void, Never>?

    /// Client-side poll budget: ~5 min at 3s intervals.
    private let pollInterval: Duration = .seconds(3)
    private let pollDeadline: TimeInterval = 5 * 60

    enum Phase: Equatable {
        case idle
        case linking            // requesting /plaid/link
        case polling            // hosted page opened; polling for completion
        case exchanging         // done; exchanging public_token
        case success(institution: String)
        case error(message: String)
    }

    var body: some View {
        NavigationStack {
            Form {
                content
            }
            .navigationTitle("Add Bank")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isTerminal ? "Done" : "Cancel") {
                        pollTask?.cancel()
                        dismiss()
                    }
                    .accessibilityIdentifier("add-bank-cancel")
                }
            }
            .accessibilityIdentifier("add-bank-scene")
            .onDisappear { pollTask?.cancel() }
        }
    }

    private var isTerminal: Bool {
        if case .success = phase { return true }
        return false
    }

    // MARK: - State-driven content

    @ViewBuilder private var content: some View {
        switch phase {
        case .idle:
            Section {
                Text("Connect a bank account through Plaid. You'll complete the "
                     + "secure Plaid Link flow in Safari, then return here.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            Section {
                Button {
                    startLink()
                } label: {
                    Label("Add Bank", systemImage: "building.columns")
                        .frame(maxWidth: .infinity)
                }
                .accessibilityIdentifier("add-bank-start")
            }

        case .linking:
            Section {
                statusRow("Starting Plaid Link…", systemImage: "hourglass")
            }
            .accessibilityIdentifier("add-bank-linking")

        case .polling:
            Section {
                statusRow(
                    "Complete the connection in Safari, then come back.",
                    systemImage: "safari")
            }
            Section {
                Button {
                    openHostedPage()
                } label: {
                    Label("Open Safari again", systemImage: "safari")
                }
                .accessibilityIdentifier("add-bank-reopen-safari")

                Button {
                    Task { await pollOnce() }
                } label: {
                    Label("I finished in Safari", systemImage: "checkmark.circle")
                }
                .accessibilityIdentifier("add-bank-finished")
            }
            .accessibilityIdentifier("add-bank-polling")

        case .exchanging:
            Section {
                statusRow("Linking your account…", systemImage: "arrow.triangle.2.circlepath")
            }
            .accessibilityIdentifier("add-bank-exchanging")

        case .success(let institution):
            Section {
                VStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 44)).foregroundStyle(.green)
                    Text("\(institution) added")
                        .font(.headline)
                    Text("The account is live now — no restart needed.")
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .accessibilityIdentifier("add-bank-success")
            Section {
                Button {
                    reset()
                    startLink()
                } label: {
                    Label("Add another", systemImage: "plus")
                }
                .accessibilityIdentifier("add-bank-add-another")

                Button("Done") { dismiss() }
                    .accessibilityIdentifier("add-bank-done")
            }

        case .error(let message):
            Section {
                ContentUnavailableView(
                    "Couldn't add bank",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message))
            }
            .accessibilityIdentifier("add-bank-error")
            Section {
                Button {
                    reset()
                    startLink()
                } label: {
                    Label("Try again", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier("add-bank-retry")

                Button("Cancel", role: .cancel) { dismiss() }
            }
        }
    }

    private func statusRow(_ text: String, systemImage: String) -> some View {
        HStack(spacing: 12) {
            ProgressView()
            VStack(alignment: .leading, spacing: 2) {
                Label(text, systemImage: systemImage)
                    .labelStyle(.titleOnly)
                    .font(.callout)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: - Flow

    /// Step 1: request a link token + hosted URL, open Safari, begin polling.
    private func startLink() {
        phase = .linking
        Task {
            do {
                let start = try await client.plaidStartLink(label: nil)
                await MainActor.run {
                    self.link = start
                    self.phase = .polling
                }
                openHostedPage()
                startPolling()
            } catch {
                await MainActor.run { self.phase = .error(message: describe(error)) }
            }
        }
    }

    /// Step 2: open the hosted Plaid Link page in Safari.
    private func openHostedPage() {
        guard let link, let url = URL(string: link.hostedURL) else { return }
        openURL(url)
    }

    /// Step 3: poll `/plaid/link/poll` every `pollInterval` until done (with a
    /// `public_token`), the deadline elapses, or a network error occurs.
    private func startPolling() {
        pollTask?.cancel()
        let deadline = Date().addingTimeInterval(pollDeadline)
        pollTask = Task {
            while !Task.isCancelled {
                if Date() >= deadline {
                    await MainActor.run {
                        if case .polling = self.phase {
                            self.phase = .error(message:
                                "Timed out waiting for Plaid. Tap Try again to restart.")
                        }
                    }
                    return
                }
                let finished = await pollOnce()
                if finished { return }
                try? await Task.sleep(for: pollInterval)
            }
        }
    }

    /// One poll iteration. Returns true when the flow has advanced past polling
    /// (exchange started, or an error landed) so the loop can stop.
    @discardableResult
    private func pollOnce() async -> Bool {
        guard let link else { return true }
        do {
            let poll = try await client.plaidPollLink(linkToken: link.linkToken)
            if poll.done, let publicToken = poll.publicToken, !publicToken.isEmpty {
                await exchange(publicToken: publicToken, label: link.label)
                return true
            }
            return false
        } catch {
            await MainActor.run { self.phase = .error(message: describe(error)) }
            return true
        }
    }

    /// Step 4: exchange the public token (passing the server-authoritative
    /// `label` through unchanged) and surface the institution.
    private func exchange(publicToken: String, label: String) async {
        await MainActor.run { self.phase = .exchanging }
        do {
            let result = try await client.plaidExchange(
                publicToken: publicToken, label: label)
            let name = result.institution.isEmpty ? "Bank" : result.institution
            await MainActor.run { self.phase = .success(institution: name) }
        } catch {
            await MainActor.run { self.phase = .error(message: describe(error)) }
        }
    }

    private func reset() {
        pollTask?.cancel()
        pollTask = nil
        link = nil
        phase = .idle
    }

    /// Map a NexusClientError to a user-facing message.
    private func describe(_ error: Error) -> String {
        switch error {
        case NexusClientError.badStatus(let code):
            return "The Plaid service returned an error (HTTP \(code))."
        case NexusClientError.transport:
            return "Couldn't reach the Plaid service. Check your connection."
        case NexusClientError.decoding:
            return "The Plaid service sent an unexpected response."
        default:
            return error.localizedDescription
        }
    }
}

#if DEBUG
#Preview("Add Bank (idle)") {
    AddBankScene()
}
#endif
