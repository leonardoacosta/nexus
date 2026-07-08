# decide-flow Specification

## Purpose
TBD - created by archiving change add-decide-flow-menubar. Update Purpose after archive.
## Requirements
### Requirement: The agent SHALL proxy the decision queue and decision write-back with asymmetric failure posture

nexus-agent SHALL serve `GET /queue` (forwarding `limit` to the mx gateway,
fail-soft to `{ items: [] }` with 200 when the gateway is unreachable) and
`POST /requests/{id}/decision` (forwarding the JSON body, propagating gateway
409/5xx responses verbatim and mapping timeouts to 504 — never a fabricated
success).

#### Scenario: Queue read degrades gracefully
- **GIVEN** the mx gateway is down
- **WHEN** `GET /queue?limit=10` is called with valid auth
- **THEN** the agent returns 200 `{ items: [] }` and logs the failure

#### Scenario: Decision write never fakes success
- **GIVEN** the gateway returns 409 (verdict already decided)
- **WHEN** `POST /requests/{id}/decision` is called
- **THEN** the agent returns 409 with the gateway body unmodified

### Requirement: TriageItem SHALL decode verdict fields additively

NexusShared's `TriageItem` SHALL gain an optional nested `Verdict` (action,
disposition, reason, confidence, promptVersion, verdictId) such that payloads
without verdict fields continue to decode unchanged.

#### Scenario: Old payload still decodes
- **WHEN** a pre-verdict gateway payload is decoded
- **THEN** decoding succeeds and `verdict` is nil

### Requirement: The menubar SHALL host a session-boxed serial decide deck

nexus-mac SHALL render decisions through a `MenuBarExtra` popover: the menubar
label shows only the queue-head action compactly; the popover shows exactly one
card at a time from a session batch of 10 fetched once at session start.
Ranking is server-owned — the deck SHALL offer no sort, filter, or reorder
controls. Progress SHALL read session-relative only ("N of 10"); the total open
count, override rate, or any cumulative tally SHALL NOT render anywhere in the
flow. The session SHALL end with a full-stop view offering no continue
affordance.

#### Scenario: One card, no list
- **GIVEN** a session batch of 10 items
- **WHEN** the popover is open mid-session
- **THEN** exactly one card is visible and no other queue items render

#### Scenario: Session ends at a full stop
- **WHEN** the 10th decision or skip completes
- **THEN** the done view renders with no remaining-count and no continue button

### Requirement: Card actions SHALL be narrow, constrained, and skip SHALL carry friction

Each card SHALL offer exactly: accept (A), override (O — constrained to
defer/delegate/preempt/group/resolve/snooze with keys 1–6 plus an optional
one-line note), peek (P — inline thread excerpt, no navigation), skip (S), and
go-to-source (G — opens the item URL and pauses the session, requiring explicit
resume). Accepting or overriding SHALL post the decision through the agent and
advance the deck. A skipped item SHALL hold its rank and return; its third skip
SHALL reduce the card's actions to the six-way picker (snooze being the
sanctioned "not now"). A 409 on post SHALL surface as "already decided
elsewhere" and advance without retry.

#### Scenario: Accept posts and advances
- **GIVEN** a card with a live verdict suggesting delegate
- **WHEN** A is pressed
- **THEN** a decision with action=accept posts via the agent and the next card renders

#### Scenario: Override is constrained with a purpose-labeled note
- **WHEN** O is pressed
- **THEN** exactly six options render with 1–6 key equivalents and an optional note field labeled as tuning input, and Enter confirms while Esc returns to the verdict

#### Scenario: Third skip forces a decision
- **GIVEN** an item skipped in two prior sessions
- **WHEN** it is skipped a third time
- **THEN** the card presents only the six-way picker and skip is no longer offered

#### Scenario: Go-to-source acknowledges the context switch
- **WHEN** G is pressed
- **THEN** the item URL opens externally and the popover shows a paused state requiring explicit resume

### Requirement: An iOS widget SHALL render the queue head and nothing else

A WidgetKit extension SHALL render, in small home and lock-screen accessory
families only, the queue-head item's verdict action and truncated title. It
SHALL render a "clear" state on an empty queue and SHALL retain the last
rendered entry on fetch failure. It SHALL NOT render counts, badges, backlog
totals, override rates, or lists in any state. Tapping SHALL open the
nexus-ios app.

#### Scenario: Head renders as one action
- **GIVEN** the ranked queue's head is a delegate-verdict item
- **WHEN** the widget timeline refreshes
- **THEN** the widget shows the action and truncated title with no numeric aggregate anywhere

#### Scenario: Empty queue renders clear, not zero
- **GIVEN** no open verdict-bearing requests
- **WHEN** the widget refreshes
- **THEN** it renders the "clear" state and no count

#### Scenario: Fetch failure degrades silently
- **GIVEN** the agent is unreachable
- **WHEN** the timeline refresh runs
- **THEN** the prior entry remains and no error state or staleness alarm renders

