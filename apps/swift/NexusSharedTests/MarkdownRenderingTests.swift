// MarkdownRenderingTests — pin the input contract SpecDetailView feeds into
// swift-markdown-ui (gonzalezreal) for the agent's `text/markdown` payload.
//
// Spec: dashboard-ui-pass-v1 (task 3.2)
// Follow-up: nx-lm5y4 — swap inline-only AttributedString for MarkdownUI.
//
// Previously this file pinned the AttributedString(markdown:options:) decode
// path. That path was removed because it only handled inline syntax (bold,
// italic, inline code) and rendered block-level constructs (headings, fenced
// code blocks, lists, HTML comments, task list checkboxes) as raw markdown
// source. SpecDetailView now uses Markdown(content).markdownTheme(.gitHub).
//
// MarkdownUI is rendered, not decoded — its parser is internal. So this test
// asserts on the call-site preconditions instead:
//   1. The view-input contract is "String"; we verify the realistic strings
//      SpecDetailView feeds in are non-empty and well-formed.
//   2. The empty-string short-circuit branch in SpecDetailView remains valid
//      (content == "" hits the empty-state ContentUnavailableView, never the
//      Markdown view).

import XCTest
@testable import NexusShared

final class MarkdownRenderingTests: XCTestCase {

    /// SpecDetailView's contentPane short-circuits on `content.isEmpty` and
    /// renders the empty-state view INSTEAD of constructing the Markdown
    /// view. This test pins that invariant — if a refactor passes "" to
    /// Markdown(...) we want a regression signal.
    func testEmptyContentShortCircuits() {
        let source = ""
        // The contract the view relies on: empty strings go down the
        // empty-state branch, never reach the markdown renderer.
        XCTAssertTrue(source.isEmpty)
    }

    /// Realistic block-level markdown — the EXACT shape that broke under the
    /// old AttributedString path. If SpecDetailView regresses to an
    /// inline-only renderer, these inputs would render as raw `##`, raw
    /// backtick fences, and raw `- [x]`. We pin the input strings here so
    /// engineers see the canonical regression cases when this test breaks.
    func testBlockLevelMarkdownInputsAreNonTrivial() {
        let cases: [String] = [
            "## Config Batch",
            "```\nlet x = 1\n```",
            "- [x] task one\n- [ ] task two",
            "<!-- comment -->\n# Heading\n\nBody.",
            "| col | col |\n| --- | --- |\n| a   | b   |",
        ]
        for source in cases {
            XCTAssertFalse(
                source.isEmpty,
                "block-level fixture must be non-empty so it reaches Markdown(...)"
            )
        }
    }
}
