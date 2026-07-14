## ADDED Requirements

### Requirement: session_start correlates to the existing process-watcher row via tmux pane, never creating a duplicate

The agent SHALL correlate a `session_start` event delivered over the socket transport to an existing `process-watcher`-discovered `sessions` row (`id = cc-<pid>-<hash>`) via the tmux pane the event names, before falling back to creating a second, UUID-keyed row for the same real session.

The correlation SHALL translate the event's `tmux_target` (tmux's raw `%N` pane-id form) to the
canonical `<session>:<window>.<pane>` address via a live `tmux list-panes -a` query, then match
that address against the `tmux_target` column of `sessions` rows with `status IN ('active',
'idle')` that do NOT already carry a non-empty `cc_session_id` (idempotency — an
already-correlated session's row is never re-matched or double-written). When exactly one row
matches, the system SHALL call the existing `cc_session_id` bridge-write path with that row's id
and the event's `session_id`. When multiple rows match (a reused pane with a stale unclosed
sibling), the row with the most recent `last_activity` SHALL be chosen.

When no match is found — the event carries no `tmux_target`, the translation lookup misses, or
no `sessions` row shares the translated address — the system SHALL fall back to the pre-existing
behavior of creating a new row keyed by the event's own `session_id` (unchanged regression
guard: the new correlation path can only add linkage, never make an unmatched session worse than
today's behavior).

The system SHALL NOT create a new `sessions` row (of either shape) for a `session_start` event
whose correlation succeeds — the event's data SHALL be applied entirely to the matched
process-watcher row.

#### Scenario: a matching, unlinked process-watcher row correlates successfully
- Given: an `active` `process-watcher`-discovered `sessions` row with `tmux_target = "0:8.1"`
  and an empty `cc_session_id`, and a `session_start` socket event whose `tmux_target` (`%N`
  form) translates to `"0:8.1"`
- When: the event is dispatched
- Then: the matched row's `cc_session_id` is set to the event's `session_id`, and no second
  (UUID-keyed) row is created for this session

#### Scenario: no matching row falls back to the pre-existing behavior
- Given: a `session_start` socket event whose `tmux_target` does not match any current
  `active`/`idle` `sessions` row's `tmux_target` (or the event carries no `tmux_target` at all)
- When: the event is dispatched
- Then: a new row is created keyed by the event's own `session_id`, identical to today's
  behavior — no error, no regression

#### Scenario: an already-linked row is never re-matched
- Given: a `sessions` row whose `tmux_target` matches the event's translated address, but that
  row already carries a non-empty `cc_session_id` from a prior correlation
- When: a subsequent `session_start`-shaped event for the same pane is dispatched (e.g. a
  reconnect or duplicate hook delivery)
- Then: that row is excluded from matching — the event falls through to the no-match fallback
  path rather than re-writing an already-correlated row

#### Scenario: multiple matching rows resolve by most-recent activity
- Given: two `sessions` rows share the same translated `tmux_target` (a reused tmux pane whose
  prior occupant's row went stale but was never marked ended), neither carrying a
  `cc_session_id`
- When: a `session_start` event correlates against that `tmux_target`
- Then: the row with the more recent `last_activity` is chosen for the `cc_session_id` write
