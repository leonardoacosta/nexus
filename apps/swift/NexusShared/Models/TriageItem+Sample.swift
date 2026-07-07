// TriageItem sample data — realistic per-archetype fixtures mirroring the six
// nx-ui wireframes (~/dev/mx/docs/nx-ui/nx-wireframe-{comms,calendar,finance,
// health,sessions,detail-universal}.html). The archetype views render these
// until the live `GET /triage` aggregator endpoint ships (TriageObserver swaps
// them in on empty/error with an `isSampleData` caption).
//
// Spec: mx-rkir [nx-ui]. Content is hand-written to match the wireframes — no
// lorem; labels, asks, amounts, RSVP states and anomaly reasons are the same the
// mockups display, so the views look identical to the approved designs.

import Foundation

extension TriageItem {
    private static let now = Date()
    private static func ago(_ s: TimeInterval) -> Date { now.addingTimeInterval(-s) }
    private static func ahead(_ s: TimeInterval) -> Date { now.addingTimeInterval(s) }

    // MARK: - Comms (gmail EMAIL, teams CHAT, ado WORK_ITEM, snow TICKET, thread, dormant)

    public static let sampleComms: [TriageItem] = [
        TriageItem(
            id: "gmail:msg:8841", source: "gmail", kind: .email,
            title: "Q3 contract redline — need sign-off today",
            url: "https://mail.google.com/mail/u/0/#inbox/8841",
            author: IdentityRef(displayName: "Dana Kerr", handle: "dana.kerr@acme.com"),
            ballInCourt: .mine, lastActivityAt: ago(8 * 60),
            payload: .comms(CommsBody(
                summary: "Approve the indemnity clause edit before 5pm so legal can countersign.",
                priority: .urgent, suggestedDisposition: .inbox,
                dispositionEvidence: "Direct ask with same-day deadline; you are the approver."
            ))
        ),
        TriageItem(
            id: "teams:msg:platform-oncall:5521", source: "teams", kind: .chatMessage,
            threadKey: "teams:channel:platform-oncall",
            title: "#platform-oncall",
            url: "https://teams.microsoft.com/l/message/platform-oncall/5521",
            author: IdentityRef(displayName: "Raj Mehta", handle: "raj.mehta@acme.com"),
            ballInCourt: .theirs, lastActivityAt: ago(22 * 60),
            payload: .comms(CommsBody(
                summary: "Sent you the deploy log — let me know if rollback looks right.",
                priority: .normal, suggestedDisposition: .waiting,
                dispositionEvidence: "You replied last; awaiting their confirmation."
            ))
        ),
        TriageItem(
            id: "teams:thread:offsite:201", source: "teams", kind: .chatMessage,
            threadKey: "teams:thread:offsite-logistics",
            title: "Offsite logistics",
            url: "https://teams.microsoft.com/l/message/offsite/201",
            author: IdentityRef(displayName: "Sam Liu", handle: "sam.liu@acme.com"),
            participants: [
                IdentityRef(displayName: "Sam Liu", handle: "sam.liu@acme.com"),
                IdentityRef(displayName: "Mara Cole", handle: "mara.cole@acme.com"),
                IdentityRef(displayName: "Tom Reyes", handle: "tom.reyes@acme.com"),
            ],
            ballInCourt: .unclear, lastActivityAt: ago(60 * 60),
            payload: .comms(CommsBody(
                summary: "Can you confirm the Thursday dinner headcount? Thread has 4 messages.",
                priority: .normal, suggestedDisposition: .inbox,
                dispositionEvidence: "Group thread, no explicit owner — heuristic unclear."
            ))
        ),
        TriageItem(
            id: "ado:wi:4821", source: "ado", kind: .workItem,
            title: "AB#4821 · Auth token refresh fails on retry",
            url: "https://dev.azure.com/acme/_workitems/edit/4821",
            author: IdentityRef(displayName: "Ana Brooks", handle: "ana.brooks@acme.com"),
            ballInCourt: .mine, lastActivityAt: ago(3 * 3600),
            payload: .comms(CommsBody(
                summary: "You're assigned reviewer — PR is waiting on your approval to merge.",
                priority: .high, upstreamState: "In Review", suggestedDisposition: .open,
                dispositionEvidence: "Assigned reviewer on an open PR awaiting your approval."
            ))
        ),
        TriageItem(
            id: "snow:inc:0294817", source: "snow", kind: .ticket,
            title: "INC0294817 · VPN gateway latency spike",
            url: "https://acme.service-now.com/incident.do?sysparm_query=number=INC0294817",
            author: IdentityRef(displayName: "ServiceNow · ops queue"),
            ballInCourt: .theirs, lastActivityAt: ago(5 * 3600),
            payload: .comms(CommsBody(
                summary: "Awaiting vendor RCA — assigned to network team, no action needed from you yet.",
                priority: .high, upstreamState: "Active", suggestedDisposition: .waiting,
                dispositionEvidence: "Assigned to network team; ball is with the vendor."
            ))
        ),
        TriageItem(
            id: "outlook:msg:budget-invoice", source: "outlook", kind: .email,
            title: "Budget approval — vendor invoice",
            author: IdentityRef(displayName: "Priya Tan", handle: "priya.tan@acme.com"),
            ballInCourt: .unclear, lastActivityAt: ago(2 * 86400),
            stillPresentUpstream: false, lastSeenAt: ago(2 * 86400),
            payload: .comms(CommsBody(
                summary: "Vendor invoice was approved and the thread was deleted from Outlook.",
                priority: .low, suggestedDisposition: .resolved,
                dispositionEvidence: "No longer upstream — deleted from Outlook, kept for history."
            ))
        ),
    ]

    // MARK: - Calendar (timed+RSVP, all-day, recurring, cancelled, conference)

    public static let sampleCalendar: [TriageItem] = [
        TriageItem(
            id: "gcal:event:q3-offsite", source: "gcal", kind: .calendarEvent,
            threadKey: "gcal:event:q3-offsite",
            title: "Q3 Planning Offsite",
            url: "https://calendar.google.com/event?eid=q3-offsite",
            author: IdentityRef(displayName: "Dana Wu", handle: "dana.wu@acme.com"),
            ballInCourt: .theirs, lastActivityAt: ago(86400),
            payload: .calendar(CalendarBody(
                startDate: "2026-06-09", endDate: "2026-06-10", allDay: true,
                isOrganizer: false, selfResponseStatus: "accepted",
                eventStatus: "confirmed", calendarId: "gcal", visibility: "default"
            ))
        ),
        TriageItem(
            id: "gcal:event:design-standup-0609", source: "gcal", kind: .calendarEvent,
            threadKey: "gcal:event:design-standup",
            title: "Design Standup",
            url: "https://calendar.google.com/event?eid=design-standup",
            author: IdentityRef(displayName: "Mara Cole", handle: "mara.cole@acme.com"),
            ballInCourt: .theirs, lastActivityAt: ago(7 * 86400),
            payload: .calendar(CalendarBody(
                startTime: dateAt(hour: 8, minute: 0), endTime: dateAt(hour: 8, minute: 30),
                location: "Zoom #design", isOrganizer: false, selfResponseStatus: "accepted",
                recurringEventId: "design-standup-master",
                recurrenceRules: ["RRULE:FREQ=WEEKLY;BYDAY=TU"],
                eventStatus: "confirmed", conferenceUrl: "https://zoom.us/j/design",
                calendarId: "gcal", visibility: "default"
            ))
        ),
        TriageItem(
            id: "outlook-calendar:event:1on1-priya", source: "outlook-calendar", kind: .calendarEvent,
            threadKey: "outlook-calendar:event:1on1-priya",
            title: "1:1 with Priya",
            url: "https://outlook.office.com/calendar/item/1on1-priya",
            author: IdentityRef(displayName: "Priya Raman", handle: "priya@acme.com"),
            ballInCourt: .mine, lastActivityAt: ago(4 * 3600),
            payload: .calendar(CalendarBody(
                startTime: dateAt(hour: 9, minute: 0), endTime: dateAt(hour: 9, minute: 45),
                location: "Microsoft Teams · Building C, Rm 210",
                description: "Weekly sync: sprint blockers, career check-in, review Q3 OKR draft before offsite.",
                isOrganizer: false, selfResponseStatus: "needsAction",
                attendees: [
                    CalendarAttendee(email: "priya@acme.com", displayName: "Priya Raman",
                                     responseStatus: "accepted", organizer: true),
                    CalendarAttendee(email: "leo@priceless.dev", displayName: "You",
                                     responseStatus: "needsAction", isSelf: true),
                    CalendarAttendee(email: "marcus@acme.com", displayName: "Marcus Chen",
                                     responseStatus: "tentative"),
                    CalendarAttendee(email: "dana@acme.com", displayName: "Dana Wu",
                                     responseStatus: "declined", optional: true),
                ],
                eventStatus: "confirmed",
                conferenceUrl: "https://teams.microsoft.com/l/meetup-join/1on1-priya",
                calendarId: "outlook-calendar", visibility: "default"
            ))
        ),
        TriageItem(
            id: "gcal:event:lunch-learn-graphql", source: "gcal", kind: .calendarEvent,
            threadKey: "gcal:event:lunch-learn-graphql",
            title: "Lunch Learn: GraphQL",
            url: "https://calendar.google.com/event?eid=lunch-learn-graphql",
            author: IdentityRef(displayName: "Tom Reyes", handle: "tom.reyes@acme.com"),
            ballInCourt: .theirs, lastActivityAt: ago(2 * 3600),
            payload: .calendar(CalendarBody(
                startTime: dateAt(hour: 13, minute: 0), endTime: dateAt(hour: 14, minute: 0),
                location: "Cafeteria", isOrganizer: false, selfResponseStatus: "accepted",
                eventStatus: "cancelled", calendarId: "gcal", visibility: "default"
            ))
        ),
        TriageItem(
            id: "outlook-calendar:event:acme-demo", source: "outlook-calendar", kind: .calendarEvent,
            threadKey: "outlook-calendar:event:acme-demo",
            title: "Customer Demo · Acme",
            url: "https://outlook.office.com/calendar/item/acme-demo",
            author: IdentityRef(displayName: "You", handle: "leo@priceless.dev"),
            ballInCourt: .theirs, lastActivityAt: ago(6 * 3600),
            payload: .calendar(CalendarBody(
                startTime: dateAt(hour: 14, minute: 0), endTime: dateAt(hour: 15, minute: 0),
                isOrganizer: true, selfResponseStatus: "accepted",
                eventStatus: "confirmed",
                conferenceUrl: "https://teams.microsoft.com/l/meetup-join/acme-demo",
                calendarId: "outlook-calendar", visibility: "default"
            ))
        ),
    ]

    // MARK: - Finance (pending online, posted in-store, refund, balances)

    public static let sampleFinance: [TriageItem] = [
        TriageItem(
            id: "plaid:txn:netflix-0607", source: "plaid", kind: .financeTxn,
            threadKey: "plaid:acct:chase-checking",
            title: "Netflix",
            url: "https://chase.com/transactions/netflix-0607",
            author: IdentityRef(displayName: "Chase Total Checking", handle: "chase:****1234"),
            createdAt: ago(2 * 3600), lastActivityAt: ago(2 * 3600),
            payload: .finance(FinanceBody(
                amount: 22.99, merchantName: "Netflix", pending: true,
                paymentChannel: "online", categoryPrimary: "Subscription",
                categoryDetailed: "ENTERTAINMENT_STREAMING",
                accountName: "Total Checking", accountMask: "1234",
                institution: "Chase", accountType: "depository",
                balanceCurrent: 4820.17, balanceAvailable: 4655.42
            ))
        ),
        TriageItem(
            id: "plaid:txn:whole-foods-0607", source: "plaid", kind: .financeTxn,
            threadKey: "plaid:acct:chase-checking",
            title: "Whole Foods Market",
            url: "https://chase.com/transactions/whole-foods-0607",
            author: IdentityRef(displayName: "Chase Total Checking", handle: "chase:****1234"),
            createdAt: ago(5 * 3600), lastActivityAt: ago(5 * 3600),
            payload: .finance(FinanceBody(
                amount: 83.41, merchantName: "Whole Foods Market", pending: false,
                paymentChannel: "in store", categoryPrimary: "Groceries",
                categoryDetailed: "FOOD_AND_DRINK_GROCERIES",
                accountName: "Total Checking", accountMask: "1234",
                institution: "Chase", accountType: "depository",
                balanceCurrent: 4820.17, balanceAvailable: 4655.42
            ))
        ),
        TriageItem(
            id: "plaid:txn:amazon-refund-0606", source: "plaid", kind: .financeTxn,
            threadKey: "plaid:acct:amex-platinum",
            title: "Amazon — Refund",
            url: "https://americanexpress.com/transactions/amazon-refund-0606",
            author: IdentityRef(displayName: "Amex Platinum Card", handle: "amex:****8821"),
            createdAt: ago(1 * 86400), lastActivityAt: ago(1 * 86400),
            payload: .finance(FinanceBody(
                amount: -41.20, merchantName: "Amazon", pending: false,
                paymentChannel: "online", categoryPrimary: "Refund",
                categoryDetailed: "GENERAL_MERCHANDISE_REFUND",
                accountName: "Platinum Card", accountMask: "8821",
                institution: "Amex", accountType: "credit",
                balanceCurrent: -1284.66
            ))
        ),
        TriageItem(
            id: "plaid:txn:delta-0606", source: "plaid", kind: .financeTxn,
            threadKey: "plaid:acct:amex-platinum",
            title: "Delta Air Lines",
            url: "https://americanexpress.com/transactions/delta-0606",
            author: IdentityRef(displayName: "Amex Platinum Card", handle: "amex:****8821"),
            createdAt: ago(1 * 86400), lastActivityAt: ago(1 * 86400),
            payload: .finance(FinanceBody(
                amount: 418.60, merchantName: "Delta Air Lines", pending: false,
                paymentChannel: "online", categoryPrimary: "Travel",
                categoryDetailed: "TRAVEL_FLIGHTS",
                accountName: "Platinum Card", accountMask: "8821",
                institution: "Amex", accountType: "credit",
                balanceCurrent: -1284.66
            ))
        ),
    ]

    // MARK: - Health (RHR + HRV flagged, Sleep, VO2 Max, Respiratory, Steps)

    public static let sampleHealth: [TriageItem] = [
        healthMetric(
            id: "health:resting_heart_rate", title: "Resting Heart Rate",
            metricType: "resting_heart_rate", value: 61, unit: "bpm",
            min: 49, avg: 54, max: 61, device: "Apple Watch",
            anomaly: "Resting HR 18% above your 30-day baseline (61 vs 52 bpm)"
        ),
        healthMetric(
            id: "health:hrv_sdnn", title: "HRV (SDNN)",
            metricType: "hrv_sdnn", value: 36, unit: "ms",
            min: 33, avg: 48, max: 62, device: "Apple Watch",
            anomaly: "HRV dropped 24% below 30-day average — possible elevated strain"
        ),
        healthMetric(
            id: "health:sleep_duration", title: "Sleep",
            metricType: "sleep_duration", value: 7.2, unit: "hr",
            min: 5.8, avg: 7.07, max: 8.35, device: "Apple Watch", anomaly: nil
        ),
        healthMetric(
            id: "health:vo2_max", title: "VO₂ Max",
            metricType: "vo2_max", value: 44, unit: "ml/kg·min",
            min: 42, avg: 43, max: 44, device: "Apple Watch", anomaly: nil
        ),
        healthMetric(
            id: "health:respiratory_rate", title: "Respiratory Rate",
            metricType: "respiratory_rate", value: 14, unit: "br/min",
            min: 12, avg: 14, max: 16, device: "Apple Watch", anomaly: nil
        ),
        healthMetric(
            id: "health:steps", title: "Steps",
            metricType: "steps", value: 8431, unit: "count",
            min: 3102, avg: 7940, max: 14277, device: "iPhone", anomaly: nil
        ),
    ]

    private static func healthMetric(
        id: String, title: String, metricType: String,
        value: Double, unit: String,
        min: Double, avg: Double, max: Double,
        device: String, anomaly: String?
    ) -> TriageItem {
        TriageItem(
            id: id, source: "health", kind: .healthMetric, title: title,
            ballInCourt: anomaly == nil ? .unclear : .mine,
            lastActivityAt: ago(4 * 3600),
            payload: .health(HealthBody(
                metricType: metricType, value: value, unit: unit, sourceDevice: device,
                periodStart: ago(30 * 86400), periodEnd: now,
                min: min, max: max, avg: avg, anomalyReason: anomaly
            ))
        )
    }

    // MARK: - Sessions (blocked apply=MINE, running ad_hoc 0.62, idle, ended)

    public static let sampleSessions: [TriageItem] = [
        TriageItem(
            id: "session:apply-source-routing", source: "sessions", kind: .codeSession,
            title: "apply: add-source-attention-routing — gate failed",
            ballInCourt: .mine, lastActivityAt: ago(3 * 60),
            payload: .session(SessionBody(
                status: "running", agentState: "blocked", sessionType: "apply",
                machine: "homelab", model: "claude-opus-4-8",
                branch: "apply/add-source-routing", totalCostUsd: 4.82,
                rateLimitUtilization: 0.41, spec: "add-source-attention-routing"
            ))
        ),
        TriageItem(
            id: "session:gmail-eval-rework", source: "sessions", kind: .codeSession,
            title: "refactor gmail mirror eval harness",
            ballInCourt: .mine, lastActivityAt: ago(6 * 60),
            payload: .session(SessionBody(
                status: "running", agentState: "waiting", sessionType: "ad_hoc",
                machine: "macbook", model: "claude-opus-4-8",
                branch: "gmail-eval-rework", totalCostUsd: 1.17,
                rateLimitUtilization: 0.23, spec: nil
            ))
        ),
        TriageItem(
            id: "session:calendar-topology-notes", source: "sessions", kind: .codeSession,
            title: "draft calendar mesh deploy topology notes",
            ballInCourt: .theirs, lastActivityAt: ago(90),
            payload: .session(SessionBody(
                status: "running", agentState: "ready", sessionType: "ad_hoc",
                machine: "homelab", model: "claude-sonnet-4-6",
                branch: "main", totalCostUsd: 0.96, rateLimitUtilization: 0.62
            ))
        ),
        TriageItem(
            id: "session:imessage-tcc-fix", source: "sessions", kind: .codeSession,
            title: "imessage Mac TCC signing investigation",
            ballInCourt: .theirs, lastActivityAt: ago(45 * 60),
            stillPresentUpstream: true,
            payload: .session(SessionBody(
                status: "idle", agentState: "ready", sessionType: "ad_hoc",
                machine: "macbook", model: "claude-opus-4-8",
                branch: "imessage-tcc-fix", totalCostUsd: 2.41,
                rateLimitUtilization: 0.08
            ))
        ),
        TriageItem(
            id: "session:calendar-deploy-complete", source: "sessions", kind: .codeSession,
            title: "apply: deploy-gcal-outlook-calendar (complete)",
            ballInCourt: .unclear, lastActivityAt: ago(3 * 3600),
            stillPresentUpstream: false, lastSeenAt: ago(3 * 3600),
            payload: .session(SessionBody(
                status: "ended", agentState: "ready", sessionType: "apply",
                machine: "homelab", model: "claude-opus-4-8",
                branch: "apply/calendar-deploy", totalCostUsd: 11.34,
                spec: "deploy-gcal-outlook-calendar"
            ))
        ),
    ]

    // MARK: - Decide flow (verdict-present + verdict-absent)
    //
    // Spec: openspec/changes/add-decide-flow-menubar. The menubar decide surface
    // renders a session batch of verdict-bearing cards; ONE verdict-less item is
    // included to exercise the defensive skip-only render path (no VerdictBox,
    // excluded from forced-decision).

    /// A verdict-BEARING card (renders the VerdictBox + the six-way actions).
    public static let sampleDecideVerdict: TriageItem = TriageItem(
        id: "ado:wi:4821", source: "ado", kind: .workItem,
        title: "AB#4821 · Auth token refresh fails on retry",
        url: "https://dev.azure.com/acme/_workitems/edit/4821",
        author: IdentityRef(displayName: "Ana Brooks", handle: "ana.brooks@acme.com"),
        ballInCourt: .mine, lastActivityAt: ago(3 * 3600),
        payload: .comms(CommsBody(
            summary: "You're assigned reviewer — PR is waiting on your approval to merge.",
            priority: .high, upstreamState: "In Review", suggestedDisposition: .open,
            dispositionEvidence: "Assigned reviewer on an open PR awaiting your approval."
        )),
        verdict: Verdict(
            action: "delegate", disposition: "open",
            reason: "Reviewer assignment, but the fix is a one-line retry guard — hand to the on-call.",
            confidence: 0.82, promptVersion: "decide-v1", verdictId: "vd_4821_a"
        )
    )

    /// A verdict-LESS card (pre-verdict payload) — decodes unchanged, renders
    /// skip-only, and is EXCLUDED from forced-decision.
    public static let sampleDecideNoVerdict: TriageItem = TriageItem(
        id: "gmail:msg:8841", source: "gmail", kind: .email,
        title: "Q3 contract redline — need sign-off today",
        url: "https://mail.google.com/mail/u/0/#inbox/8841",
        author: IdentityRef(displayName: "Dana Kerr", handle: "dana.kerr@acme.com"),
        ballInCourt: .mine, lastActivityAt: ago(8 * 60),
        payload: .comms(CommsBody(
            summary: "Approve the indemnity clause edit before 5pm so legal can countersign.",
            priority: .urgent, suggestedDisposition: .inbox,
            dispositionEvidence: "Direct ask with same-day deadline; you are the approver."
        ))
        // No verdict — pre-verdict steady state.
    )

    /// A representative decide session batch (<=10): verdict-bearing cards plus
    /// the single verdict-less card. Backs the DecideDeckView `#Preview`.
    public static let sampleDecideBatch: [TriageItem] = [
        sampleDecideVerdict,
        TriageItem(
            id: "teams:msg:platform-oncall:5521", source: "teams", kind: .chatMessage,
            threadKey: "teams:channel:platform-oncall",
            title: "#platform-oncall — rollback confirmation",
            url: "https://teams.microsoft.com/l/message/platform-oncall/5521",
            author: IdentityRef(displayName: "Raj Mehta", handle: "raj.mehta@acme.com"),
            ballInCourt: .theirs, lastActivityAt: ago(22 * 60),
            payload: .comms(CommsBody(
                summary: "Sent you the deploy log — let me know if rollback looks right.",
                priority: .normal, suggestedDisposition: .waiting,
                dispositionEvidence: "You replied last; awaiting their confirmation."
            )),
            verdict: Verdict(
                action: "snooze", disposition: "waiting",
                reason: "Ball is with them for the rollback call — nothing owed until they reply.",
                confidence: 0.66, promptVersion: "decide-v1", verdictId: "vd_5521_b"
            )
        ),
        TriageItem(
            id: "snow:inc:0294817", source: "snow", kind: .ticket,
            title: "INC0294817 · VPN gateway latency spike",
            url: "https://acme.service-now.com/incident.do?sysparm_query=number=INC0294817",
            author: IdentityRef(displayName: "ServiceNow · ops queue"),
            ballInCourt: .theirs, lastActivityAt: ago(5 * 3600),
            payload: .comms(CommsBody(
                summary: "Awaiting vendor RCA — assigned to network team.",
                priority: .high, upstreamState: "Active", suggestedDisposition: .waiting,
                dispositionEvidence: "Assigned to network team; ball is with the vendor."
            )),
            verdict: Verdict(
                action: "defer", disposition: "waiting",
                reason: "Vendor RCA pending — defer until the network team escalates.",
                confidence: 0.38, promptVersion: "decide-v1", verdictId: "vd_0294817_c"
            )
        ),
        sampleDecideNoVerdict,
    ]

    // MARK: - Combined feed

    /// Every archetype's fixtures concatenated — the cross-source feed the
    /// universal detail page and the Triage/Radar list render. Aggregated
    /// families (comms + calendar) lead; standalone surfaces (finance, health,
    /// sessions) follow.
    public static let sampleData: [TriageItem] =
        sampleComms + sampleCalendar + sampleFinance + sampleHealth + sampleSessions

    /// Today, at the given wall-clock time (local) — anchors the calendar
    /// fixtures to a stable agenda regardless of when the preview renders.
    private static func dateAt(hour: Int, minute: Int) -> Date {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .current
        let comps = cal.dateComponents([.year, .month, .day], from: now)
        var dc = DateComponents()
        dc.year = comps.year; dc.month = comps.month; dc.day = comps.day
        dc.hour = hour; dc.minute = minute
        return cal.date(from: dc) ?? now
    }
}
