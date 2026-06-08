// TriageShared — small reusable chrome shared by the six archetype scenes
// (comms / calendar / finance / health / sessions / detail). Pills, the
// ball-in-court chip, the avatar monogram, the kind glyph, and the "Sample
// data — live feed pending" caption row all live here so each scene composes
// rather than re-declares.
//
// Spec: mx-1ezh / mx-0rxv / mx-tx7j / mx-rtfe / mx-i3fx / mx-gojn [nx-ui].
// iOS scenes use standard SwiftUI semantic colors (Color.nx is macOS-only,
// in nexus/nexus/Theme.swift), matching SourcesScene.

import SwiftUI
import NexusShared

// MARK: - Relative-time formatter (shared)

enum TriageFormat {
    static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .abbreviated
        return f
    }()

    static func ago(_ date: Date?) -> String {
        guard let date else { return "—" }
        return relative.localizedString(for: date, relativeTo: Date())
    }

    static func timeRange(_ start: Date?, _ end: Date?) -> String {
        let f = DateFormatter()
        f.dateFormat = "h:mm a"
        switch (start, end) {
        case let (s?, e?): return "\(f.string(from: s))–\(f.string(from: e))"
        case let (s?, nil): return f.string(from: s)
        default: return ""
        }
    }
}

// MARK: - Ball-in-court chip (blue MINE / gray THEIRS / orange UNCLEAR)

struct BallChip: View {
    let ball: BallInCourt

    var body: some View {
        Text(label)
            .font(.system(size: 10, weight: .bold))
            .foregroundStyle(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color, in: Capsule())
            .accessibilityLabel("ball in court \(label)")
    }

    private var label: String {
        switch ball {
        case .mine: return "MINE"
        case .theirs: return "THEIRS"
        case .unclear: return "UNCLEAR"
        }
    }

    private var color: Color {
        switch ball {
        case .mine: return .blue
        case .theirs: return .gray
        case .unclear: return .orange
        }
    }
}

// MARK: - Generic outline pill (disposition, category, upstream state, badges)

struct OutlinePill: View {
    let text: String
    var tint: Color = .secondary

    var body: some View {
        Text(text.uppercased())
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(tint)
            .padding(.horizontal, 5)
            .padding(.vertical, 1.5)
            .overlay(
                RoundedRectangle(cornerRadius: 4)
                    .stroke(tint.opacity(0.5), lineWidth: 1)
            )
    }
}

// MARK: - Priority chip (urgent=red, high=orange, normal/low=secondary)

struct PriorityChip: View {
    let priority: CommsPriority

    var body: some View {
        if priority == .normal || priority == .low {
            EmptyView()
        } else {
            Text(priority.label)
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(.white)
                .padding(.horizontal, 5)
                .padding(.vertical, 1.5)
                .background(color, in: RoundedRectangle(cornerRadius: 4))
        }
    }

    private var color: Color {
        switch priority {
        case .urgent: return .red
        case .high: return .orange
        default: return .secondary
        }
    }
}

// MARK: - Author monogram avatar

struct Avatar: View {
    let name: String
    var size: CGFloat = 30

    var body: some View {
        Text(monogram)
            .font(.system(size: size * 0.42, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: size, height: size)
            .background(tint, in: Circle())
            .accessibilityHidden(true)
    }

    private var monogram: String {
        let parts = name.split(separator: " ").prefix(2)
        let letters = parts.compactMap { $0.first.map(String.init) }
        return letters.joined().uppercased().isEmpty ? "?" : letters.joined().uppercased()
    }

    private var tint: Color {
        // Deterministic hue from the name so each author is visually stable.
        let hues: [Color] = [.blue, .purple, .pink, .teal, .indigo, .green, .orange]
        let idx = abs(name.hashValue) % hues.count
        return hues[idx]
    }
}

// MARK: - Kind glyph (envelope / bubble / ticket / work-item)

enum KindGlyph {
    static func symbol(for kind: TriageKind) -> String {
        switch kind {
        case .email: return "envelope"
        case .chatMessage: return "bubble.left.and.bubble.right"
        case .ticket: return "ticket"
        case .workItem: return "checklist"
        case .codeReview: return "arrow.triangle.pull"
        case .calendarEvent: return "calendar"
        case .financeTxn: return "creditcard"
        case .healthMetric: return "heart"
        case .codeSession: return "terminal"
        default: return "circle"
        }
    }
}

// MARK: - Sample-data caption row

struct SampleCaptionRow: View {
    var id = "triage-sample-caption"

    var body: some View {
        Label("Sample data — live feed pending", systemImage: "exclamationmark.circle")
            .font(.caption)
            .foregroundStyle(.secondary)
            .accessibilityIdentifier(id)
    }
}
