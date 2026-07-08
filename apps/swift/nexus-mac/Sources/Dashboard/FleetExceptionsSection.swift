// FleetExceptionsSection — menubar popover region rendering the agent's
// `GET /exceptions` feed. Owns a FleetExceptionsObserver (@StateObject) that
// polls on the shared observer cadence.
//
// Spec: openspec/changes/add-fleet-exceptions-feed (task 2.2)
//
// Silent-when-clean: on an EMPTY feed the whole section is ABSENT (renders
// `EmptyView()` — no header, no empty-state placeholder). When non-empty it
// renders flat text lines (repo / class / count / offender-ids) — no scroll
// view, no drill-in / tap-to-expand.

import SwiftUI
import NexusShared

struct FleetExceptionsSection: View {
    @StateObject private var observer: FleetExceptionsObserver

    /// Injection seam for previews / tests; production uses the default
    /// network-backed observer.
    init(observer: FleetExceptionsObserver = FleetExceptionsObserver()) {
        _observer = StateObject(wrappedValue: observer)
    }

    var body: some View {
        Group {
            if observer.exceptions.isEmpty {
                // Silent-when-clean — the section is absent entirely.
                EmptyView()
            } else {
                content
            }
        }
        .task { observer.startPolling() }
        .onDisappear { observer.stopPolling() }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("FLEET EXCEPTIONS")
                .font(.jbm(9, weight: .semibold))
                .foregroundStyle(Color.nx.ink3)
                .tracking(0.6)
            ForEach(observer.exceptions) { exception in
                exceptionLine(exception)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(Color.nx.critical.opacity(0.06))
        .overlay(
            Rectangle().stroke(Color.nx.critical.opacity(0.15), lineWidth: 1)
        )
        .accessibilityIdentifier("fleet-exceptions-section")
    }

    private func exceptionLine(_ exception: FleetException) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(exception.repo)
                .font(.jbm(10, weight: .semibold))
                .foregroundStyle(Color.nx.critical)
            Text(exception.exceptionClass.label)
                .font(.jbm(10))
                .foregroundStyle(Color.nx.amber)
            Text("×\(exception.count)")
                .font(.jbm(10))
                .foregroundStyle(Color.nx.ink2)
            if !exception.offenders.isEmpty {
                Text(exception.offenders.joined(separator: " "))
                    .font(.jbm(9))
                    .foregroundStyle(Color.nx.ink3)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            Spacer(minLength: 0)
        }
        .accessibilityIdentifier("fleet-exception-\(exception.id)")
    }
}

#if DEBUG
#Preview("Fleet Exceptions — populated") {
    let observer = FleetExceptionsObserver()
    observer.setExceptionsForPreview([
        FleetException(
            repo: "nx",
            exceptionClass: .inProgressStale,
            count: 2,
            offenders: ["nx-abc12", "nx-def34"]
        ),
        FleetException(
            repo: "cc",
            exceptionClass: .p1Open,
            count: 1,
            offenders: ["cc-xy789"]
        ),
        FleetException(
            repo: "oo",
            exceptionClass: .unarchivedChanges,
            count: 3,
            offenders: ["add-foo", "add-bar", "add-baz"]
        ),
    ])
    return FleetExceptionsSection(observer: observer)
        .frame(width: 320)
        .background(Color.nx.substrate2)
}
#endif
