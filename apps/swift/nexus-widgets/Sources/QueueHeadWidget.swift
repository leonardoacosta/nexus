// QueueHeadWidget — widget configuration + views for the iOS queue-head glance
// (openspec/changes/add-queue-head-widget, tasks 1.1 + 1.3).
//
// Families: small home widget + lock-screen accessories (rectangular + inline).
// Each renders the ONE next action (verdict action + truncated title) or a
// distinct "clear" state. HARD INVARIANT (spec ## What Changes, review-asserted):
// NO counts, badges, backlog numbers, or lists in ANY state — the surface shows
// the next thing or nothing. Tap = plain app launch (default widget behavior; a
// deep-link into a future iOS decide deck is post-gate, so no `.widgetURL`).
//
// iOS uses standard SwiftUI semantic colors here — Color.nx is macOS-only
// (see nexus-ios TriageShared.swift).

import WidgetKit
import SwiftUI
import NexusShared

struct QueueHeadWidget: Widget {
    private let kind = "dev.leonardoacosta.nexus.ios.QueueHeadWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: QueueHeadProvider()) { entry in
            QueueHeadWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Next Action")
        .description("The single next thing to decide — or a clear queue.")
        .supportedFamilies([.systemSmall, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Family router

struct QueueHeadWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: QueueHeadEntry

    var body: some View {
        switch family {
        case .accessoryInline:
            InlineView(state: entry.state)
        case .accessoryRectangular:
            RectangularView(state: entry.state)
        default:
            SmallView(state: entry.state)
        }
    }
}

// MARK: - Small home widget

private struct SmallView: View {
    let state: QueueHeadState

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch state {
            case .head(let action, let title):
                Text(action.uppercased())
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.tint)
                    .accessibilityIdentifier("queue-head-action")
                Text(title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(3)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("queue-head-title")
                Spacer(minLength: 0)
            case .clear:
                Spacer(minLength: 0)
                Image(systemName: "checkmark.circle")
                    .font(.title2)
                    .foregroundStyle(.secondary)
                Text("Clear")
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("queue-head-clear")
                Spacer(minLength: 0)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .accessibilityIdentifier("queue-head-small")
    }
}

// MARK: - Lock-screen accessory (rectangular)

private struct RectangularView: View {
    let state: QueueHeadState

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch state {
            case .head(let action, let title):
                Text(action.uppercased())
                    .font(.caption2.weight(.bold))
                    .accessibilityIdentifier("queue-head-action")
                Text(title)
                    .font(.caption)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .accessibilityIdentifier("queue-head-title")
            case .clear:
                Label("Clear", systemImage: "checkmark.circle")
                    .font(.caption)
                    .accessibilityIdentifier("queue-head-clear")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("queue-head-rectangular")
    }
}

// MARK: - Lock-screen accessory (inline)

private struct InlineView: View {
    let state: QueueHeadState

    var body: some View {
        switch state {
        case .head(let action, let title):
            // Inline is a single system-styled line; the OS truncates.
            Text("\(action): \(title)")
                .accessibilityIdentifier("queue-head-inline")
        case .clear:
            Label("Clear", systemImage: "checkmark.circle")
                .accessibilityIdentifier("queue-head-inline-clear")
        }
    }
}

// MARK: - Previews

#Preview("Small — head", as: .systemSmall) {
    QueueHeadWidget()
} timeline: {
    QueueHeadEntry(date: .now, state: .head(action: "delegate", title: "WHS-346 export the quarterly report"))
    QueueHeadEntry(date: .now, state: .clear)
}

#Preview("Rectangular — head", as: .accessoryRectangular) {
    QueueHeadWidget()
} timeline: {
    QueueHeadEntry(date: .now, state: .head(action: "defer", title: "Review PR #482 auth refactor"))
    QueueHeadEntry(date: .now, state: .clear)
}

#Preview("Inline", as: .accessoryInline) {
    QueueHeadWidget()
} timeline: {
    QueueHeadEntry(date: .now, state: .head(action: "preempt", title: "Ship the widget"))
    QueueHeadEntry(date: .now, state: .clear)
}
