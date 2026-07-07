// DecideCardView — one decide card: header (ball / source / requester / age),
// why-now line, title, VerdictBox, and the keyboard-shortcut action bar.
//
// Spec: openspec/changes/add-decide-flow-menubar (nexus-mac task 2.4 + 2.5).
//
// Defensive verdict-less rendering (design §Risks): an item with no verdict (or
// no verdictId) renders WITHOUT a VerdictBox as a SKIP-ONLY card — no accept, no
// override — and is excluded from forced-decision upstream (DecideSession.isForced).
//
// Action bar keys: A accept · O override · P peek · S skip · G go-to-source. The
// bar reshapes by card state:
//   • verdict-less  → Skip · Peek · Open  (skip-only)
//   • forced (3rd skip on a verdict card) → Override · Peek · Open (accept + skip removed;
//     the override picker's snooze is the sanctioned "not now")
//   • normal        → Accept · Override · Peek · Skip · Open
//
// ANTI-BIAS: no counts, rates, streaks, or backlog totals anywhere on the card.

import SwiftUI
import NexusShared

struct DecideCardView: View {
    let item: TriageItem
    /// Card is at forced-decision (verdict-bearing + skipped 3×): accept + skip
    /// are removed; only Override / Peek / Open remain.
    let forced: Bool
    /// The verdict's action mapped to an accept target, when available.
    let acceptAction: DecideAction?

    var onAccept: () -> Void
    var onOverride: () -> Void
    var onPeek: () -> Void
    var onSkip: () -> Void
    var onGoToSource: () -> Void

    /// Verdict-bearing AND actionable (has a verdictId).
    private var hasVerdict: Bool { item.verdict?.isActionable == true }
    private var acceptAvailable: Bool { hasVerdict && !forced && acceptAction != nil }
    private var overrideAvailable: Bool { hasVerdict }
    private var skipAvailable: Bool { !forced }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            title
            if hasVerdict, let verdict = item.verdict {
                VerdictBox(verdict: verdict)
            } else {
                skipOnlyNote
            }
            actionBar
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nx.substrate2, in: RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12).stroke(Color.nx.hairline, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("decide-card")
    }

    // MARK: - Header (ball / source / requester / age)

    private var header: some View {
        HStack(spacing: 8) {
            ballGlyph
            Text(item.source.uppercased())
                .font(.system(size: 10.5, weight: .bold))
                .foregroundStyle(Color.nx.ink3)
            if let who = item.author?.displayName, !who.isEmpty {
                Text("· \(who)")
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.nx.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 6)
            if let ts = item.lastActivityAt ?? item.createdAt {
                Text(Self.relative.localizedString(for: ts, relativeTo: Date()))
                    .font(.system(size: 10.5))
                    .foregroundStyle(Color.nx.ink4)
            }
        }
        .accessibilityIdentifier("decide-card-header")
    }

    private var ballGlyph: some View {
        Circle()
            .fill(ballColor)
            .frame(width: 8, height: 8)
            .accessibilityLabel(ballLabel)
    }

    private var ballColor: Color {
        switch item.ballInCourt {
        case .mine:    return Color.nx.phosphor
        case .theirs:  return Color.nx.ink3
        case .unclear: return Color.nx.amber
        }
    }

    private var ballLabel: String {
        switch item.ballInCourt {
        case .mine:    return "ball in your court"
        case .theirs:  return "ball in their court"
        case .unclear: return "ball unclear"
        }
    }

    // MARK: - Why-now + title

    private var title: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let why = whyNow, !why.isEmpty {
                Text(why)
                    .font(.system(size: 11))
                    .foregroundStyle(Color.nx.ink3)
                    .lineLimit(2)
                    .accessibilityIdentifier("decide-card-why")
            }
            Text(item.title.isEmpty ? "(untitled)" : item.title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Color.nx.ink)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityIdentifier("decide-card-title")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The "why now" line — the verdict reason is shown in the VerdictBox, so the
    /// header why-line prefers the comms disposition evidence / summary.
    private var whyNow: String? {
        item.payload.comms?.dispositionEvidence ?? item.payload.comms?.summary
    }

    private var skipOnlyNote: some View {
        HStack(spacing: 6) {
            Image(systemName: "questionmark.circle")
                .foregroundStyle(Color.nx.ink3)
            Text("No verdict yet — skip-only.")
                .font(.system(size: 11.5))
                .foregroundStyle(Color.nx.ink3)
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nx.substrate3, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("decide-card-skip-only")
    }

    // MARK: - Action bar (A/O/P/S/G keyboard equivalents)

    private var actionBar: some View {
        HStack(spacing: 8) {
            if acceptAvailable, let accept = acceptAction {
                barButton(
                    title: "Accept: \(accept.label)",
                    key: "a", tint: Color.nx.phosphor, filled: true,
                    id: "decide-accept", action: onAccept
                )
            }
            if overrideAvailable {
                barButton(
                    title: forced ? "Decide" : "Override",
                    key: "o", tint: Color.nx.amber, filled: forced,
                    id: "decide-override", action: onOverride
                )
            }
            barButton(
                title: "Peek", key: "p", tint: Color.nx.ink2, filled: false,
                id: "decide-peek", action: onPeek
            )
            if skipAvailable {
                barButton(
                    title: "Skip", key: "s", tint: Color.nx.ink2, filled: false,
                    id: "decide-skip", action: onSkip
                )
            }
            barButton(
                title: "Open", key: "g", tint: Color.nx.ink2, filled: false,
                id: "decide-open", action: onGoToSource
            )
        }
        .accessibilityIdentifier("decide-action-bar")
    }

    private func barButton(
        title: String,
        key: Character,
        tint: Color,
        filled: Bool,
        id: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(filled ? Color.nx.substrate : tint)
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(
                    filled
                        ? AnyShapeStyle(tint)
                        : AnyShapeStyle(Color.nx.substrate3),
                    in: RoundedRectangle(cornerRadius: 7)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .stroke(filled ? Color.clear : tint.opacity(0.4), lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
        .keyboardShortcut(KeyEquivalent(key), modifiers: [])
        .accessibilityIdentifier(id)
    }

    private static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()
}

#if DEBUG
#Preview("DecideCard — verdict") {
    DecideCardView(
        item: TriageItem.sampleDecideVerdict,
        forced: false,
        acceptAction: DecideAction(wire: TriageItem.sampleDecideVerdict.verdict?.action),
        onAccept: {}, onOverride: {}, onPeek: {}, onSkip: {}, onGoToSource: {}
    )
    .padding()
    .frame(width: 360)
    .background(Color.nx.substrate)
}

#Preview("DecideCard — verdict-less (skip-only)") {
    DecideCardView(
        item: TriageItem.sampleDecideNoVerdict,
        forced: false,
        acceptAction: nil,
        onAccept: {}, onOverride: {}, onPeek: {}, onSkip: {}, onGoToSource: {}
    )
    .padding()
    .frame(width: 360)
    .background(Color.nx.substrate)
}
#endif
