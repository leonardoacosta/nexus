// VerdictBox — the model-verdict panel inside a DecideCardView.
//
// Spec: openspec/changes/add-decide-flow-menubar (nexus-mac task 2.4). Renders
// the mx triage verdict's recommended action, a banded confidence pill, the
// one-line reason, and the initiative (disposition). Rendered ONLY for
// verdict-bearing cards — a verdict-less card omits the box entirely and the
// DecideCardView falls back to a skip-only bar.
//
// Uses the dark phosphor `Color.nx.*` menubar palette (Theme.swift) — this is a
// menubar popover surface, not the HIG-adaptive dashboard.
//
// ANTI-BIAS: renders the SINGLE current verdict only — no rate, streak, or tally.

import SwiftUI
import NexusShared

struct VerdictBox: View {
    let verdict: Verdict

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let action = verdict.action, !action.isEmpty {
                    Label(
                        action.capitalized,
                        systemImage: DecideAction(wire: action)?.symbol ?? "wand.and.stars"
                    )
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(Color.nx.phosphor)
                    .accessibilityIdentifier("verdict-action")
                }
                Spacer(minLength: 6)
                confidencePill
            }

            if let reason = verdict.reason, !reason.isEmpty {
                Text(reason)
                    .font(.system(size: 12))
                    .foregroundStyle(Color.nx.ink2)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("verdict-reason")
            }

            if let disposition = verdict.disposition, !disposition.isEmpty {
                (Text("Initiative  ")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(Color.nx.ink3)
                 + Text(disposition.uppercased())
                    .font(.system(size: 10))
                    .foregroundColor(Color.nx.ink2))
                    .accessibilityIdentifier("verdict-initiative")
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.nx.substrate3, in: RoundedRectangle(cornerRadius: 9))
        .overlay(
            RoundedRectangle(cornerRadius: 9).stroke(Color.nx.hairline, lineWidth: 1)
        )
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("verdict-box")
    }

    @ViewBuilder
    private var confidencePill: some View {
        if let band = verdict.confidenceBand, !band.isEmpty {
            Text(band.uppercased())
                .font(.system(size: 9.5, weight: .bold))
                .foregroundStyle(Color.nx.substrate)
                .padding(.horizontal, 7)
                .padding(.vertical, 2)
                .background(Self.bandColor(band), in: Capsule())
                .accessibilityIdentifier("verdict-confidence")
                .accessibilityLabel("confidence \(band)")
        }
    }

    static func bandColor(_ band: String) -> Color {
        switch band.lowercased() {
        case "high":   return Color.nx.phosphor
        case "medium": return Color.nx.amber
        default:       return Color.nx.ink3
        }
    }
}

#if DEBUG
#Preview("VerdictBox") {
    VerdictBox(verdict: TriageItem.sampleDecideVerdict.verdict!)
        .padding()
        .frame(width: 340)
        .background(Color.nx.substrate)
}
#endif
