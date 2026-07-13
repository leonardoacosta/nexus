# statusline-renderer

## ADDED Requirements

### Requirement: nexus-statusline SHALL push its resolved context-window reading to nx-agent on every render
nexus-statusline SHALL fire an async, non-awaited `POST /sessions/:id/context` to the local
nx-agent after `context-guard.ts`'s existing spurious-zero-guard logic resolves a value (unchanged
— the local `statusline-ctx.<sessionId>.json` snapshot and its guard behavior are not modified by
this requirement), carrying the resolved `{usedPercentage, contextWindowSize}`. This push MUST NOT
block or delay the statusline render — fire-and-forget, matching this codebase's fail-soft
convention for every other external call in the render path. A failed or slow POST MUST be
silently swallowed.

#### Scenario: Render never blocks on the push
Given nx-agent is unreachable
When the statusline renders and resolves a context value
Then the render completes and prints normally, with no added latency waiting on the POST

#### Scenario: Push carries the resolved (guarded) value, not the raw CC frame
Given CC's raw stdin frame for this render is a spurious `used_percentage: 0`
And the guard resolves the fresh cached snapshot value (`42`) instead
When the push fires
Then the POST body carries `usedPercentage: 42` (the resolved value), never the raw `0`

### Requirement: nexus-statusline SHALL NOT write the tmux-pane-keyed session-context file
`session-context.ts`'s `writeSessionContext()` export and its call site MUST be removed — a clean
replacement, not a compat shim. nexus-statusline MUST NOT write `session-context.<pane>.json` on
any render going forward. cc-tmux's session-bar context-% segment reads as absent until cc-tmux's
own (out-of-scope) follow-up starts querying `GET /sessions/:id/context` directly.

#### Scenario: No pane-keyed file is written
Given a statusline render completes with a resolved context value
When the render's side effects are inspected
Then no `session-context.<pane>.json` file is created or updated

#### Scenario: Existing orphaned pane-keyed files still get garbage-collected
Given a pane-keyed file from before this change exists on disk and has aged past its TTL
When the existing `gcSessionContext` opportunistic GC runs
Then the orphaned file is still pruned (the GC's `session-context.` prefix is unchanged — this
requirement stops the writer, not the sweep of pre-existing files)
