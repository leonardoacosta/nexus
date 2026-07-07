# Design — Decide Flow (macOS Menubar Pilot)

## Context

The interaction contract was designed against three constraints (2026-07-07):
priority order is absolute and server-owned; the surface must not create
sidetrack opportunities; per-item actions are deliberately narrow. The pilot
exists to accumulate >= 30 `mx_verdict_decisions` rows so the pre-registered
override-rate gate (mx add-triage-verdict-layer proposal.md) can run.

## Agent layer (apps/agent)

| Route | Contract |
| --- | --- |
| `GET /queue` | Passthrough to `${MX_GATEWAY_URL}/queue`, forwarding `limit`. Fail-soft per /requests convention: gateway down => `{ items: [] }` 200 (the popover renders "queue unavailable", never spins). |
| `POST /requests/{id}/decision` | Passthrough of the JSON body. **NOT fail-soft**: 409 (no live verdict / already decided) and 5xx return verbatim with the gateway body. Timeout follows the existing 10s bound but maps to 504, not an empty 200. |

Rationale for the asymmetry: a read that degrades to empty is a graceful UX; a
write that degrades to fake-success corrupts the pilot's decision data.

## NexusShared

- `TriageItem` + `Verdict` (nested optional Codable struct: `action`,
  `disposition`, `reason`, `confidence`, `promptVersion`, `verdictId`). All
  optional — payloads from a pre-verdict gateway decode unchanged.
  `TriageItem+Sample` gains verdict-present and verdict-absent samples for
  SwiftUI previews.
- `DecideSession` (@Observable, platform-agnostic): fetches one batch
  (`limit=10`) at session start via the NexusClient endpoint pattern; owns
  `items`, `currentIndex`, `skipCounts[id]`, `paused`, `phase`
  (deck|overriding|peeking|done). Session state is memory-only — abandoning the
  popover abandons the session; items were never mutated, so nothing leaks.
  Skip: increments count, moves the item behind the current position (holds
  rank, does not re-rank); third skip sets `forcedDecision` on that card
  (actions reduce to the six-way override picker, where snooze is the sanctioned
  "not now").
- `DecisionClient` endpoint on the existing NexusClient actor: `postDecision(
  requestID:action:overrideAction:note:)`. A 409 surfaces as a card-level
  "already decided elsewhere — refreshing" and advances the deck.

## nexus-mac (SwiftUI)

- `MenuBarExtra` (window style). Label: compact queue-head rendering (SF Symbol
  + truncated action, e.g. "tray.full — delegate: WHS-346 export"). Clicking
  opens the popover hosting `DecideDeckView`.
- `DecideDeckView`: renders exactly one `DecideCardView`; footer action bar;
  progress reads "3 of 10" (session-relative only — the total open count never
  renders inside the flow).
- `DecideCardView`: header (ball/source/requester/age), why-now line (from the
  ranking fields), title, `VerdictBox` (action, confidence band, reason,
  initiative), keyboard equivalents A/O/P/S/G via `.keyboardShortcut`.
- Override: inline expansion within the popover (no sheet inside a menubar
  popover) — 2x3 button grid for defer/delegate/preempt/group/resolve/snooze
  with 1–6 key equivalents, optional single-line note field labeled
  "why? (this tunes the model)", Enter confirms, Esc returns.
- Peek: `P` / tap expands the thread excerpt inline below the VerdictBox
  (agent `/thread` passthrough already exists). No navigation.
- Go-to-source: `G` opens the item URL AND sets `paused` — the popover shows a
  paused card on return ("resume session") instead of pretending the switch
  didn't happen.
- `SessionDoneView`: "SESSION DONE — 10 decided. The rest will keep." Esc
  closes. Deliberately no remaining-count and no continue button; a new session
  starts only by reopening the popover.

## Anti-bias invariants (UI-enforced)

No override-rate, accept-streak, or cumulative tally is computed or rendered
anywhere in NexusShared/nexus-mac. The only aggregate the user ever sees is the
mx biweekly report (banded, suppressed under n=30). This mirrors the storage
rule (rate is a report query, never a counter).

## Decisions

- **Menubar popover over a window/app**: the pilot must live where the context
  switches happen; a separate window is itself a sidetrack surface.
- **Inline expansion over sheets** in the popover: sheets over MenuBarExtra
  popovers are visually unstable and break the "one room" feel.
- **Session state is ephemeral**: durable state lives in mx (decisions) — a
  crashed popover loses only deck position, and re-fetch re-ranks correctly.
- **Fallback to /queue/head** if mx add-queue-batch hasn't landed: sessions of
  one, same card mechanics — lets the Swift work proceed independently.

## Risks

- MenuBarExtra keyboard-shortcut quirks across macOS versions — verify A/O/P/S/G
  fire in the popover during the [user] device pass; fall back to buttons-only
  if a shortcut is swallowed.
- Verdict-less items: mx `GET /queue` guarantees verdict-bearing items only (see
  mx add-queue-batch), but decode defensively — if one slips through, render the
  card without a VerdictBox as skip-only (decisions require a verdict_id) and
  exclude it from forced-decision.
