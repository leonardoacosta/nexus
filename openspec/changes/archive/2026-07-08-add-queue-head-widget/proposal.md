# Add iOS Queue-Head Widget

## Why

The ambient-surface doctrine (proven by roadmap-pulse/statusline vs the decayed
command surfaces): guidance that must be remembered dies; guidance that is
already visible survives. On iPhone the ambient surface is WidgetKit — a
lock-screen/home widget showing the single next action. It extends the decide
flow's level-1 disclosure ("the one next thing") to the pocket, with zero new
data surface: it reads the same queue head the menubar label reads.

## What Changes

- New WidgetKit extension target (nexus-ios, XcodeGen project.yml): small home
  widget + lock-screen accessory families.
- Renders the queue-head item only: verdict action + truncated title (e.g.
  "delegate: WHS-346 export"). Clean queue renders "clear" — no counts, no
  badges, no backlog numbers, ever (same anti-bias/anti-sidetrack invariants
  as the decide flow).
- Timeline refresh: system-budgeted periodic refresh (~15 min goal) fetching
  via the agent `GET /queue/head`-equivalent path (`/queue?limit=1`) over the
  existing NexusClient conventions; stale data renders with no staleness
  alarm (a widget is a glance, not a monitor).
- Tap opens the nexus-ios app (plain launch; deep-linking into a future iOS
  decide deck is post-gate).

## Non-Goals

- No iOS decide/triage interactions (post-pilot-gate, per
  add-triage-verdict-layer).
- No medium/large widget families — more space invites lists.
- No watch complication (deliberately skipped per the surface-responsibility
  decision).

## Impact

- Affected specs: `decide-flow` (one ADDED requirement).
- Affected code: `apps/swift/project.yml` (new extension target),
  `apps/swift/nexus-widgets/` (new), NexusShared reuse (TriageItem+Verdict from
  add-decide-flow-menubar task 2.1 — hard dependency).
- Depends on: add-decide-flow-menubar (model + agent /queue proxy).

## Testing

- Timeline provider unit test with stubbed client: entry for verdict-bearing
  head, "clear" entry for empty queue, graceful entry on fetch failure.
- Headless typecheck via the Linux->Mac ssh + xcodegen contract.
- [user] On-device: add widget to lock screen + home, verify render + tap
  launch + refresh after a decision changes the head (GUI/signing-bound).
