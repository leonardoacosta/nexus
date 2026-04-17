# Ambiguity Audit — Nexus v2 PRD

> Generated: 2026-04-03
> PRD: docs/plan/v2/prd.md
> **Clarity Score: 9/10**

---

## Scoring Rationale

The PRD scores 9/10 on clarity. All four ship criteria are concrete and testable. Acceptance
criteria include specific thresholds (2s page load, 500ms WebSocket handshake, 100ms keypress
latency). No TBDs remain. Two sections are explicitly marked as unavailable with the commands
needed to generate them. The only deductions are for a few medium-severity hedging patterns
that were deemed acceptable in context (cost estimates and timeline ranges).

---

## Findings

| # | Location | Pattern | Original Text | Resolution | Severity |
|---|----------|---------|---------------|------------|----------|
| 1 | §5.1 Development Investment | Vague range | "~260" hours, "~$26,000" | Acceptable — AI-assisted estimate has inherent variance; base figure (344 hrs) is precise | Low |
| 2 | §5.1 Development Investment | Hedging | "25-30% reduction" for AI assist | Acceptable — productivity multiplier is empirically observed range, not a commitment | Low |
| 3 | §9 Timeline | Vague range | "6-10 calendar weeks" | Acceptable — no external deadline, range reflects uncertainty in scope-of-effort, not ambiguity in requirements | Low |
| 4 | §2 Target Users, Leo | Vague quantity | "3-5 machines" | Intentional — team is actively scaling from 3 to 5 machines; exact count changes quarterly | Low |
| 5 | §3 Scale Target | Vague quantity | "2-5 developers", "10-20 sessions" | Intentional — represents the operating range, not ambiguity; architecture must handle the upper bound | Low |
| 6 | §5.2 TCO | Range | "$0-20/month" infrastructure | Acceptable — depends on Vercel vs self-hosted decision (explicit either/or, not vague) | Low |
| 7 | §7 Technical Architecture | Open-ended | "Per-agent SQLite stores session events, health snapshots, and notification queue" | Schema not yet defined — will be produced during `/plan:infra` or implementation specs | Medium |
| 8 | §10 Route Architecture | Missing section | "[NOT AVAILABLE]" | Known gap — run `/plan:routes docs/plan/v2` to fill | Medium |
| 9 | §11 Infrastructure Plan | Missing section | "[NOT AVAILABLE]" | Known gap — run `/plan:infra docs/plan/v2` to fill | Medium |

---

## Category Summary

| Severity | Count | Action |
|----------|------:|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 3 | Documented, not blocking — sections 10-11 are optional artifacts, section 7 schema deferred to implementation |
| Low | 6 | Intentional ranges/estimates — no fix needed |
| **Total** | **9** | **Proceed** |

---

## Coherence Checks

| Check | Result |
|-------|--------|
| **User <> Requirements** | PASS — All 3 personas appear in at least one flow. All 5 flows map to named personas. All 4 ship criteria have dedicated flows. |
| **Requirements <> Scope** | PASS — No requirement exceeds scope-lock boundaries. All v2 Must-Do items have corresponding flows and acceptance criteria. No TUI, gRPC, or tRPC requirements appear. |
| **Pricing <> Users** | N/A — Internal tool, no pricing. Business model is zero-revenue, correctly reflected throughout. |
| **Design <> Users** | PASS — Dark mode, keyboard-first, dense layouts match the developer persona profile. Geist fonts and Phosphor icons are developer-tool appropriate. |
| **Architecture <> Scale** | PASS — SQLite + Bun + Tailscale handles 5 devs / 10 machines / 50 sessions. No horizontal scaling needed within target. |
| **Timeline <> Financials** | PASS — 260 hrs at 40-60 hrs/week = 4.3-6.5 weeks active development (within 6-10 week calendar estimate). $26K build cost with 4.3-month payback is consistent. |

---

## Weasel Word Scan

No instances of "should", "might", "could", "possibly", "generally", "typically", "usually",
"TBD", "TODO", "to be determined", "etc.", "and so on", or "and more" found in the PRD.

All requirements use definitive language: "displays", "renders", "sends", "forwards", "fetches",
"connects", "propagates".

---

## Recommendation

**Proceed to roadmap generation.** Clarity score of 9/10 exceeds the 7/10 threshold. All
findings are documented and non-blocking. The two missing sections (routes, infra) are optional
enrichment artifacts that can be generated in parallel with roadmap work.
