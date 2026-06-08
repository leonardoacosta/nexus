// CalendarScene (mx-0rxv) — CALENDAR_EVENT agenda. gcal + outlook-calendar
// merged into one day list. Spine = Core.*, body = CalendarBody.*. READ-ONLY.
//
// Design: ~/dev/mx/docs/nx-ui/nx-wireframe-calendar.html (iOS compact agenda).
// All-day chips on top; timed events with time range, location, RSVP summary,
// recurring badge, cancelled struck-through, Join deep-link, calendar_id color
// dot. Tap -> DetailScene.

import SwiftUI
import NexusShared

struct CalendarScene: View {
    @ObservedObject var observer: TriageObserver

    var body: some View {
        List {
            if observer.isSampleData {
                Section { SampleCaptionRow(id: "calendar-sample-caption") }
            }
            if !allDay.isEmpty {
                Section("All-day") {
                    ForEach(allDay) { item in
                        NavigationLink(value: item) { CalendarRow(item: item) }
                    }
                }
            }
            Section("Agenda") {
                if timed.isEmpty {
                    ContentUnavailableView("No events", systemImage: "calendar")
                } else {
                    ForEach(timed) { item in
                        NavigationLink(value: item) { CalendarRow(item: item) }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Calendar")
        .navigationDestination(for: TriageItem.self) { DetailScene(item: $0) }
        .accessibilityIdentifier("calendar-scene")
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
    }

    private var allDay: [TriageItem] {
        observer.calendar.filter { $0.payload.calendar?.allDay == true }
    }
    private var timed: [TriageItem] {
        observer.calendar
            .filter { $0.payload.calendar?.allDay != true }
            .sorted { ($0.payload.calendar?.startTime ?? .distantFuture)
                    < ($1.payload.calendar?.startTime ?? .distantFuture) }
    }
}

private struct CalendarRow: View {
    let item: TriageItem
    private var b: CalendarBody? { item.payload.calendar }
    private var cancelled: Bool { (b?.eventStatus ?? "").lowercased() == "cancelled" }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(calendarColor)
                .frame(width: 9, height: 9)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.title)
                        .font(.body.weight(.medium))
                        .strikethrough(cancelled)
                        .foregroundStyle(cancelled ? .secondary : .primary)
                        .lineLimit(1)
                    if cancelled { OutlinePill(text: "cancelled", tint: .red) }
                    if let rules = b?.recurrenceRules, !rules.isEmpty {
                        Image(systemName: "repeat").font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    BallChip(ball: item.ballInCourt)
                }
                if let b, !(b.allDay) {
                    Text(TriageFormat.timeRange(b.startTime, b.endTime))
                        .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                }
                if let loc = b?.location {
                    Label(loc, systemImage: "mappin.and.ellipse")
                        .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
                HStack(spacing: 8) {
                    if let rsvp = b?.selfResponseStatus {
                        OutlinePill(text: rsvpLabel(rsvp), tint: rsvpColor(rsvp))
                    }
                    if !attendeeSummary.isEmpty {
                        Text(attendeeSummary).font(.caption2).foregroundStyle(.secondary)
                    }
                    if let url = b?.conferenceUrl, let link = URL(string: url) {
                        Link(destination: link) {
                            Label("Join", systemImage: "video").font(.caption2)
                        }
                    }
                }
            }
        }
        .padding(.vertical, 2)
        .accessibilityIdentifier("calendar-row-\(item.id)")
    }

    private var calendarColor: Color {
        (b?.calendarId ?? "").contains("outlook") ? .indigo : .blue
    }

    private var attendeeSummary: String {
        guard let a = b?.attendees, !a.isEmpty else { return "" }
        let yes = a.filter { ($0.responseStatus ?? "") == "accepted" }.count
        return "\(yes)/\(a.count) going"
    }

    private func rsvpLabel(_ s: String) -> String {
        switch s {
        case "accepted": return "going"
        case "tentative": return "maybe"
        case "declined": return "no"
        case "needsAction": return "rsvp?"
        default: return s
        }
    }
    private func rsvpColor(_ s: String) -> Color {
        switch s {
        case "accepted": return .green
        case "declined": return .red
        case "needsAction": return .orange
        default: return .secondary
        }
    }
}

#if DEBUG
#Preview("Calendar (sample)") {
    NavigationStack {
        CalendarScene(observer: {
            let o = TriageObserver(); o.setItemsForPreview(.sampleData, isSample: true); return o
        }())
    }
}
#endif
