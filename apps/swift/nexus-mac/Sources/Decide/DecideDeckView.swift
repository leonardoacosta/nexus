// DecideDeckView — the popover body for the menubar decide pilot. Renders EXACTLY
// one DecideCardView plus, depending on session.phase, the inline override picker
// or the inline thread peek; a footer with session-relative progress; and the
// session-done / queue-unavailable / paused terminal screens.
//
// Spec: openspec/changes/add-decide-flow-menubar (nexus-mac tasks 2.5 + 2.6).
//
// Interaction contract:
//   • Override → inline 2×3 grid within the popover (NO sheet inside a
//     MenuBarExtra popover), keys 1–6, optional single-line note
//     "why? (this tunes the model)", Enter confirms, Esc returns.
//   • Peek → inline thread excerpt below the card (reuses NexusClient.fetchThread).
//   • Go-to-source → opens the item URL AND pauses the session; the popover shows
//     a paused card on return with a "Resume session" button.
//   • SessionDoneView → "SESSION DONE — N decided. The rest will keep." Esc closes,
//     no remaining-count, no continue button; a new session starts by reopening.
//
// ANTI-BIAS INVARIANT (enforced here): the ONLY aggregate rendered anywhere in
// this flow is the session-relative "N of 10" progress. No override-rate,
// accept-streak, cumulative tally, backlog/total-open count, sort/filter control,
// or per-item notification is rendered.

import SwiftUI
import NexusShared

struct DecideDeckView: View {
    let session: DecideSession
    let client: NexusShared.NexusClient

    @State private var loading = false
    @State private var overrideNote = ""
    @State private var selectedOverride: DecideAction?
    @State private var statusMessage: String?
    @Environment(\.openURL) private var openURL

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
        }
        .frame(width: 360)
        .padding(14)
        .background(Color.nx.substrate)
        .accessibilityIdentifier("decide-deck-view")
        .onAppear { Task { await startIfNeeded() } }
    }

    // MARK: - Top-level content routing

    @ViewBuilder
    private var content: some View {
        if loading && session.current == nil {
            loadingState
        } else if session.paused {
            pausedCard
        } else if session.phase == .done {
            if session.sessionSize == 0 {
                queueUnavailable
            } else {
                SessionDoneView(decided: session.sessionSize)
            }
        } else if let cur = session.current {
            activeDeck(cur)
        } else {
            queueUnavailable
        }
    }

    // MARK: - Active deck (one card + inline panels + footer)

    @ViewBuilder
    private func activeDeck(_ cur: TriageItem) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            DecideCardView(
                item: cur,
                forced: session.isForced(cur),
                acceptAction: session.acceptAction,
                onAccept: accept,
                onOverride: { session.beginOverride() },
                onPeek: { session.beginPeek() },
                onSkip: { session.skip(); statusMessage = nil },
                onGoToSource: { goToSource(cur) }
            )

            if session.phase == .overriding {
                OverridePicker(
                    note: $overrideNote,
                    selected: $selectedOverride,
                    onConfirm: confirmOverride,
                    onCancel: cancelOverride
                )
            } else if session.phase == .peeking {
                PeekPanel(item: cur, client: client, onClose: { session.endPeek() })
            }

            if let msg = statusMessage {
                Text(msg)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.nx.amber)
                    .accessibilityIdentifier("decide-status-message")
            }

            footer
        }
    }

    private var footer: some View {
        HStack {
            Text(session.progressLabel)
                .font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(Color.nx.ink3)
                .accessibilityIdentifier("decide-progress")
            Spacer(minLength: 0)
            Text("A accept · O override · P peek · S skip · G open")
                .font(.system(size: 9, design: .monospaced))
                .foregroundStyle(Color.nx.ink4)
                .lineLimit(1)
        }
        .padding(.top, 2)
    }

    // MARK: - Terminal / transient states

    private var loadingState: some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text("Loading queue…")
                .font(.system(size: 12))
                .foregroundStyle(Color.nx.ink2)
        }
        .frame(maxWidth: .infinity, minHeight: 90)
        .accessibilityIdentifier("decide-loading")
    }

    private var queueUnavailable: some View {
        ContentUnavailableView {
            Label("Queue unavailable", systemImage: "tray")
        } description: {
            Text("Nothing to decide right now. Reopen to check again.")
        }
        .frame(minHeight: 120)
        .accessibilityIdentifier("decide-queue-unavailable")
    }

    private var pausedCard: some View {
        VStack(spacing: 12) {
            Image(systemName: "pause.circle")
                .font(.system(size: 28))
                .foregroundStyle(Color.nx.amber)
            Text("Session paused")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Color.nx.ink)
            Text("You stepped out to the source. Pick up where you left off.")
                .font(.system(size: 11.5))
                .foregroundStyle(Color.nx.ink3)
                .multilineTextAlignment(.center)
            Button("Resume session") { session.resume() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("decide-resume")
        }
        .frame(maxWidth: .infinity, minHeight: 130)
        .padding(.vertical, 8)
        .accessibilityIdentifier("decide-paused-card")
    }

    // MARK: - Actions

    private func startIfNeeded() async {
        guard !loading else { return }
        // Load on first appearance, and start a FRESH session whenever the popover
        // reappears after the previous one finished (no continue button by design).
        if session.sessionSize == 0 || session.phase == .done {
            loading = true
            statusMessage = nil
            await session.loadSession(using: client)
            loading = false
        }
    }

    private func accept() {
        guard let action = session.acceptAction else { return }
        Task { await post(action: action, isOverride: false, note: nil) }
    }

    private func confirmOverride() {
        guard let action = selectedOverride else { return }
        let note = overrideNote.trimmingCharacters(in: .whitespacesAndNewlines)
        Task { await post(action: action, isOverride: true, note: note.isEmpty ? nil : note) }
    }

    private func cancelOverride() {
        selectedOverride = nil
        overrideNote = ""
        session.cancelOverride()
    }

    private func goToSource(_ item: TriageItem) {
        if let raw = item.url, let url = URL(string: raw) {
            openURL(url)
        }
        session.markPaused()
    }

    private func post(action: DecideAction, isOverride: Bool, note: String?) async {
        let result = await session.submit(
            action: action, isOverride: isOverride, note: note, using: client
        )
        // Reset the override draft regardless of outcome that advanced the deck.
        selectedOverride = nil
        overrideNote = ""
        switch result {
        case nil:
            statusMessage = nil
        case .alreadyDecided:
            statusMessage = "Already decided elsewhere — refreshed."
        case .notActionable:
            statusMessage = "No verdict on this card — skip only."
        case .transport:
            statusMessage = "Couldn't reach the gateway — try again."
        case .badStatus(let code):
            statusMessage = "Gateway error (\(code)) — try again."
        }
    }
}

// MARK: - Inline override picker (2×3 grid + note; Enter confirms, Esc returns)

private struct OverridePicker: View {
    @Binding var note: String
    @Binding var selected: DecideAction?
    var onConfirm: () -> Void
    var onCancel: () -> Void

    private let columns = [GridItem(.flexible()), GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Override — pick an action")
                .font(.system(size: 10.5, weight: .semibold))
                .foregroundStyle(Color.nx.ink3)

            LazyVGrid(columns: columns, spacing: 8) {
                ForEach(Array(DecideAction.gridOrder.enumerated()), id: \.element) { index, action in
                    Button {
                        selected = action
                    } label: {
                        VStack(spacing: 3) {
                            Image(systemName: action.symbol)
                                .font(.system(size: 13))
                            Text(action.label)
                                .font(.system(size: 10.5, weight: .medium))
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .foregroundStyle(selected == action ? Color.nx.substrate : Color.nx.ink2)
                        .background(
                            selected == action
                                ? AnyShapeStyle(Color.nx.amber)
                                : AnyShapeStyle(Color.nx.substrate3),
                            in: RoundedRectangle(cornerRadius: 8)
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .stroke(Color.nx.hairline, lineWidth: selected == action ? 0 : 1)
                        )
                    }
                    .buttonStyle(.plain)
                    .keyboardShortcut(KeyEquivalent(action.keyEquivalent), modifiers: [])
                    .accessibilityIdentifier("decide-override-\(action.rawValue)")
                    .help("\(action.label) (\(index + 1))")
                }
            }

            TextField("why? (this tunes the model)", text: $note)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 11.5))
                .onSubmit(onConfirm)
                .accessibilityIdentifier("decide-override-note")

            HStack(spacing: 8) {
                Button("Confirm", action: onConfirm)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.return, modifiers: [])
                    .disabled(selected == nil)
                    .accessibilityIdentifier("decide-override-confirm")
                Button("Cancel", action: onCancel)
                    .buttonStyle(.bordered)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("decide-override-cancel")
                Spacer(minLength: 0)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nx.substrate2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.nx.amberDim, lineWidth: 1))
        .accessibilityIdentifier("decide-override-picker")
    }
}

// MARK: - Inline thread peek (reuses NexusClient.fetchThread)

private struct PeekPanel: View {
    let item: TriageItem
    let client: NexusShared.NexusClient
    var onClose: () -> Void

    @State private var messages: [CommsMessage] = []
    @State private var phase: Phase = .loading

    private enum Phase { case loading, loaded, empty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Thread peek")
                    .font(.system(size: 10.5, weight: .semibold))
                    .foregroundStyle(Color.nx.ink3)
                Spacer(minLength: 0)
                Button {
                    onClose()
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Color.nx.ink3)
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("decide-peek-close")
            }

            switch phase {
            case .loading:
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading thread…")
                        .font(.system(size: 11))
                        .foregroundStyle(Color.nx.ink3)
                }
                .accessibilityIdentifier("decide-peek-loading")
            case .empty:
                Text("No earlier messages for this item.")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.nx.ink3)
                    .accessibilityIdentifier("decide-peek-empty")
            case .loaded:
                ForEach(messages.suffix(4)) { msg in
                    VStack(alignment: .leading, spacing: 1) {
                        Text(msg.isSelf ? "You" : msg.author)
                            .font(.system(size: 9.5, weight: .semibold))
                            .foregroundStyle(Color.nx.ink3)
                        Text(msg.text)
                            .font(.system(size: 11.5))
                            .foregroundStyle(Color.nx.ink2)
                            .lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nx.substrate2, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.nx.hairline, lineWidth: 1))
        .accessibilityIdentifier("decide-peek-panel")
        .task(id: item.id) { await load() }
    }

    private func load() async {
        phase = .loading
        let result = (try? await client.fetchThread(source: item.source, id: item.id)) ?? []
        messages = result
        phase = result.isEmpty ? .empty : .loaded
    }
}

// MARK: - Session done

/// The full-stop end screen. Deliberately NO remaining-count and NO continue
/// button — a new session starts only by reopening the popover (design §nexus-mac).
struct SessionDoneView: View {
    let decided: Int

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.seal.fill")
                .font(.system(size: 30))
                .foregroundStyle(Color.nx.phosphor)
            Text("SESSION DONE — \(decided) decided.")
                .font(.system(size: 14, weight: .bold))
                .foregroundStyle(Color.nx.ink)
                .accessibilityIdentifier("decide-session-done-headline")
            Text("The rest will keep.")
                .font(.system(size: 12))
                .foregroundStyle(Color.nx.ink3)
        }
        .frame(maxWidth: .infinity, minHeight: 130)
        .padding(.vertical, 8)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("decide-session-done")
    }
}

#if DEBUG
#Preview("DecideDeck (mock)") {
    let session = DecideSession()
    session.seed(TriageItem.sampleDecideBatch)
    return DecideDeckView(session: session, client: NexusShared.NexusClient())
}

#Preview("Session done") {
    SessionDoneView(decided: 10)
        .frame(width: 360)
        .background(Color.nx.substrate)
}
#endif
