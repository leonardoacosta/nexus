// SessionSearch — pure, view-independent fuzzy filter for the nexus-mac
// dashboard session list.
//
// Bead: nx-0pfb (GCF — fuzzy search across sessions/projects). Redirected
// 2026-07-14 from the retired ratatui TUI to the live SwiftUI dashboard.
//
// Lives on `Session` in NexusShared so SessionsView (nexus-mac) applies a
// single filter layer over `observer.activeSessions` before rendering, and
// NexusSharedTests can exercise the match logic without spinning up SwiftUI.
// Matches the "type a few letters, narrow the list" interaction of the
// original TUI spec — subsequence (fuzzy), not exact.

import Foundation

public extension Session {
    /// Fields the dashboard search filters against. Mirrors what a user sees
    /// in a session row: the resolved project label (`projectLabel(for:)`),
    /// the lifecycle status, the origin hostname (`originAgent`), plus branch
    /// / spec / model as secondary hints. Empty fields contribute nothing.
    static func searchHaystack(for session: Session) -> [String] {
        [
            projectLabel(for: session),
            session.status,
            session.originAgent,
            session.branch ?? "",
            session.spec ?? "",
            session.model ?? "",
        ].filter { !$0.isEmpty }
    }

    /// Pure filter over a session list.
    ///
    /// - An empty / whitespace-only query returns the input unchanged (full
    ///   list), so exiting search mode is a no-op filter.
    /// - Otherwise keeps sessions whose project name, status, hostname, branch,
    ///   spec, or model subsequence-matches the query (case-insensitive).
    ///
    /// Order is preserved; the caller (SessionsView) applies its own sort after.
    static func fuzzyFilter(_ sessions: [Session], query: String) -> [Session] {
        let needle = query
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard !needle.isEmpty else { return sessions }
        return sessions.filter { session in
            searchHaystack(for: session).contains { field in
                fuzzySubsequenceMatch(needle: needle, haystack: field.lowercased())
            }
        }
    }

    /// Subsequence match: every character of `needle` appears in `haystack`
    /// in order, not necessarily contiguously. Substring is a special case, so
    /// this is strictly more permissive than a substring match — "oo" matches
    /// "leonardoacosta/oo" and "lco" matches "leonardoacosta". An empty needle
    /// matches everything. Both arguments are expected pre-lowercased by the
    /// caller.
    static func fuzzySubsequenceMatch(needle: String, haystack: String) -> Bool {
        if needle.isEmpty { return true }
        var iterator = haystack.makeIterator()
        for target in needle {
            var matched = false
            while let ch = iterator.next() {
                if ch == target {
                    matched = true
                    break
                }
            }
            if !matched { return false }
        }
        return true
    }
}
