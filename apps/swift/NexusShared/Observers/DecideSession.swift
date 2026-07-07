// DecideSession — the platform-agnostic session state for the menubar decide
// pilot (openspec/changes/add-decide-flow-menubar, NexusShared task 2.3).
//
// A session is a memory-only serial deck of at most 10 ranked cards. Abandoning
// the popover abandons the session; items were never mutated, so nothing leaks
// and a re-fetch re-ranks correctly (server ranking is authoritative — the
// client NEVER re-ranks). Durable state lives in mx (the posted decisions).
//
// State-transition functions (skip / commitDecision / begin* / paused) are PURE
// and synchronous — no I/O inside them — so the transition math is unit-testable
// without the network (NexusSharedTests). The only I/O is `loadSession` (the
// batch fetch + /queue/head fallback) and `submit` (the decision POST), which
// call the pure transitions after the await resolves.
//
// ANTI-BIAS: this type computes NO override-rate, accept-streak, or cumulative
// tally. The only aggregate exposed is the session-relative `progressLabel`
// ("N of 10"). `sessionSize` is the fetched batch count, never a backlog total.

import Foundation
import Observation

/// The six narrow decide actions (the override picker + the accept target). The
/// `defer` action's case is named `deferAction` to dodge the Swift keyword; its
/// wire raw value stays `"defer"`. `keyEquivalent` is the 1…6 override-grid key.
public enum DecideAction: String, CaseIterable, Sendable, Identifiable, Hashable {
    case deferAction = "defer"
    case delegate
    case preempt
    case group
    case resolve
    case snooze

    public var id: String { rawValue }

    /// Tolerant map from a verdict's `action` string (camel/upper/lower).
    public init?(wire raw: String?) {
        guard let raw, !raw.isEmpty else { return nil }
        switch raw.lowercased() {
        case "defer":    self = .deferAction
        case "delegate": self = .delegate
        case "preempt":  self = .preempt
        case "group":    self = .group
        case "resolve":  self = .resolve
        case "snooze":   self = .snooze
        default:         return nil
        }
    }

    /// Human label for the button.
    public var label: String {
        switch self {
        case .deferAction: return "Defer"
        case .delegate:    return "Delegate"
        case .preempt:     return "Preempt"
        case .group:       return "Group"
        case .resolve:     return "Resolve"
        case .snooze:      return "Snooze"
        }
    }

    /// SF Symbol name for the action button.
    public var symbol: String {
        switch self {
        case .deferAction: return "clock.arrow.circlepath"
        case .delegate:    return "person.crop.circle.badge.checkmark"
        case .preempt:     return "bolt.fill"
        case .group:       return "square.stack.3d.up"
        case .resolve:     return "checkmark.circle"
        case .snooze:      return "moon.zzz"
        }
    }

    /// 1-based key equivalent in the override grid (1…6, grid order below).
    public var keyEquivalent: Character {
        switch self {
        case .deferAction: return "1"
        case .delegate:    return "2"
        case .preempt:     return "3"
        case .group:       return "4"
        case .resolve:     return "5"
        case .snooze:      return "6"
        }
    }

    /// Canonical 2×3 grid order (defer/delegate/preempt · group/resolve/snooze).
    public static let gridOrder: [DecideAction] =
        [.deferAction, .delegate, .preempt, .group, .resolve, .snooze]
}

@Observable
public final class DecideSession {

    /// Coarse UI phase. `deck` shows the current card; `overriding` swaps the
    /// action bar for the six-way picker inline; `peeking` expands the thread
    /// excerpt inline; `done` shows the session-done screen.
    public enum Phase: Sendable, Equatable {
        case deck
        case overriding
        case peeking
        case done
    }

    /// The working deck (memory-only). Skipped cards are re-inserted behind the
    /// current position (holds rank); decided cards are removed.
    public private(set) var items: [TriageItem] = []
    /// Pointer at the current card. Advancing is by REMOVAL (a decision drops the
    /// card and the next shifts into this slot), so this rarely moves except to
    /// clamp at the end.
    public private(set) var currentIndex: Int = 0
    /// Per-card skip tally (memory-only). 3rd skip forces a decision on a
    /// verdict-bearing card.
    public private(set) var skipCounts: [String: Int] = [:]
    /// Go-to-source paused the session; the popover shows a paused card on return.
    public var paused: Bool = false
    public private(set) var phase: Phase = .deck

    /// Number of cards decided this session (progress numerator base).
    public private(set) var decidedCount: Int = 0
    /// The fetched batch size (progress denominator). NEVER a backlog total.
    public private(set) var sessionSize: Int = 0

    public init() {}

    // MARK: - Derived (no aggregates beyond session-relative progress)

    /// The current card, or nil when the deck is exhausted.
    public var current: TriageItem? {
        guard currentIndex >= 0, currentIndex < items.count else { return nil }
        return items[currentIndex]
    }

    /// Skip tally for a card id.
    public func skipCount(for id: String) -> Int { skipCounts[id] ?? 0 }

    /// A card is in forced-decision when it is verdict-bearing (actionable) AND
    /// has been skipped 3+ times. Verdict-LESS cards are skip-only and NEVER
    /// forced (defensive rule, design §Risks).
    public func isForced(_ item: TriageItem) -> Bool {
        guard item.verdict?.isActionable == true else { return false }
        return skipCount(for: item.id) >= 3
    }

    /// Convenience for the current card.
    public var currentIsForced: Bool {
        guard let cur = current else { return false }
        return isForced(cur)
    }

    /// The accept target action derived from the current card's verdict, when it
    /// maps to one of the six. nil when the card is verdict-less / unmapped
    /// (accept unavailable — override or skip only).
    public var acceptAction: DecideAction? {
        DecideAction(wire: current?.verdict?.action)
    }

    /// Session-relative progress ("3 of 10"). The ONLY aggregate the flow shows.
    public var progressLabel: String {
        let n = min(decidedCount + 1, max(sessionSize, 1))
        return "\(n) of \(sessionSize)"
    }

    // MARK: - Pure transitions (no I/O — unit-testable)

    /// Seed a fresh session from a fetched batch. Resets all session state.
    public func seed(_ batch: [TriageItem]) {
        self.items = batch
        self.sessionSize = batch.count
        self.currentIndex = 0
        self.skipCounts = [:]
        self.decidedCount = 0
        self.paused = false
        self.phase = batch.isEmpty ? .done : .deck
    }

    /// Skip the current card: increment its tally and move it BEHIND the current
    /// position (holds rank — only this one card moves). A forced card cannot be
    /// skipped further (returns without change). Verdict-less cards skip freely.
    public func skip() {
        guard let cur = current else { return }
        // A card already at forced-decision cannot be skipped again.
        if isForced(cur) { return }
        skipCounts[cur.id, default: 0] += 1
        let item = items.remove(at: currentIndex)
        // Re-insert one slot back (behind the now-current next card). Clamped so
        // it lands within bounds. currentIndex is unchanged, so the next card
        // becomes current.
        let target = min(currentIndex + 1, items.count)
        items.insert(item, at: target)
        // Skipping never leaves an expanded panel open.
        if phase == .overriding || phase == .peeking { phase = .deck }
    }

    /// Record that the current card was decided (accept / override / snooze
    /// posted) and advance. Removes the card and clamps to `.done` when the deck
    /// empties. Call AFTER a successful (or already-decided 409) POST.
    public func commitDecision() {
        guard let cur = current else {
            phase = .done
            return
        }
        skipCounts.removeValue(forKey: cur.id)
        items.remove(at: currentIndex)
        decidedCount += 1
        // currentIndex stays put — the next card shifts into this slot. Clamp to
        // done when we removed the last card.
        if items.isEmpty || currentIndex >= items.count {
            phase = .done
        } else {
            phase = .deck
        }
    }

    /// Enter the inline override picker (guarded to actionable cards).
    public func beginOverride() {
        guard let cur = current, cur.verdict?.isActionable == true else { return }
        phase = .overriding
    }

    /// Leave the override picker back to the deck (Esc).
    public func cancelOverride() {
        if phase == .overriding { phase = .deck }
    }

    /// Expand the inline thread peek.
    public func beginPeek() {
        guard current != nil else { return }
        phase = .peeking
    }

    /// Collapse the inline thread peek (Esc / tap).
    public func endPeek() {
        if phase == .peeking { phase = .deck }
    }

    /// Go-to-source: mark the session paused (the caller opens the URL).
    public func markPaused() { paused = true }

    /// Resume from a paused card.
    public func resume() { paused = false }

    // MARK: - I/O (calls the pure transitions after awaits resolve)

    /// Start a session: fetch one ranked batch (`limit=10`); when the batch
    /// endpoint is empty/unavailable, fall back to a single-item session via
    /// `/queue/head`. Both reads are fail-soft, so a total gateway outage seeds
    /// an empty (immediately-done) session rather than throwing.
    public func loadSession(using client: NexusClient, limit: Int = 10) async {
        let batch = await client.fetchDecideQueue(limit: limit)
        if !batch.isEmpty {
            seed(batch)
            return
        }
        if let head = await client.fetchDecideQueueHead() {
            seed([head])
        } else {
            seed([])
        }
    }

    /// Post a decision for the current card, then advance. `isOverride` is true
    /// only when the human overrode the verdict (the six-way picker). Returns nil
    /// on success, or a `DecideError` the caller surfaces:
    ///   - `.alreadyDecided` (409): the deck ALSO advances (decided elsewhere).
    ///   - `.notActionable`: the card has no verdictId (no advance).
    ///   - `.transport` / `.badStatus`: the card stays put for a retry.
    @discardableResult
    public func submit(
        action: DecideAction,
        isOverride: Bool,
        note: String?,
        using client: NexusClient
    ) async -> DecideError? {
        guard let cur = current, cur.verdict?.isActionable == true else {
            return .notActionable
        }
        do {
            try await client.postDecision(
                requestID: cur.id,
                action: action.rawValue,
                overrideAction: isOverride ? action.rawValue : nil,
                note: note
            )
        } catch let error as DecideError {
            if error == .alreadyDecided {
                // Already decided elsewhere — refresh past it.
                commitDecision()
                return .alreadyDecided
            }
            return error
        } catch {
            return .transport
        }
        commitDecision()
        return nil
    }
}
