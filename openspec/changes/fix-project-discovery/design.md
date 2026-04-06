## Context

The project discovery pipeline spans three layers: the agent route
(`apps/agent/src/routes/projects-discovered.ts`), the Next.js client aggregator
(`apps/nextjs/src/lib/agent-client.ts`), and the shared `DiscoveredProject` type in
`packages/core`. Bugs at each layer interact: the agent computes correct session data but
discards counts before serialization; the client maps a boolean back to 0/1 with no awareness
of actual counts; and the dedup key fails across machines with different home directories.

This is a cross-cutting fix touching all three layers simultaneously. A design step is required
to pin decisions before implementation so that the wire format, client mapping, and dedup
algorithm are updated consistently rather than piecemeal.

Constraints:
- No DB schema migration — all fixes are in application code
- Must remain backward compatible with agents that have not yet upgraded (see Protocol Versioning
  below)
- TypeScript strict mode enabled; no `any` casts permitted in changed code

## Goals / Non-Goals

Goals:
- Correct session counts (numeric) flow end-to-end from agent to UI
- Tilde expansion is guaranteed at every FS call site
- Cross-machine dedup uses a stable canonical key
- Stale projects are evicted from the aggregated view automatically
- Symlink-created duplicates are eliminated at the route level

Non-Goals:
- Real-time push of project discovery events (GCF — future work)
- Project health scores or session trend analytics (GCF — future work)
- Registry write-back (creating registry entries from discovered projects)
- Migration of existing DB rows that contain un-expanded `~` values

## Decisions

### Decision 1: Wire Format — Replace Boolean with Counts

**What:** Remove `hasActiveSessions: boolean` from `AgentDiscoveredProject`. Replace with
`activeSessions: number` (sessions with `status = "active"` or `last_seen` within the past
5 minutes) and `totalSessions: number` (all sessions whose `cwd` starts with `fullPath` or
whose `project` field matches the directory name, within the 24-hour query window).

**Why:** The boolean was a lossy encoding introduced when session count queries were expensive.
The `queryRecentSessions` call already fetches the full session list; counting by project adds
O(S) work per project scan where S is sessions in the 24h window — negligible for the expected
scale (< 100 sessions).

**Alternatives considered:**
- Keep boolean, fix client to not fake counts: rejected — the dashboard shows numeric counts;
  showing "1 active" when there are actually 3 is a UX bug, not just a type issue.
- Add counts as optional fields alongside boolean: rejected — creates a versioning mess and does
  not fix the P1 data loss.

### Decision 2: Tilde Expansion — `expandProjectsDir` Is the Single Source of Truth

**What:** The `expandProjectsDir` helper in the route file already handles `~` correctly via
`os.homedir()`. The fix is to confirm it is called at every FS entry point and add a unit test.
No new helper is needed.

**Why:** The known issue nx-8v2a was filed when the route was first written without tilde
support. The fix was applied to `handleGetDiscoveredProjects` but not audited at other call
sites (e.g. startup config parsing, any future cron refresh). The test closes that gap
permanently.

**Alternatives considered:**
- Expand at DB write time: rejected — would require a migration and breaks portability (a DB
  row written on one user's machine should be transportable).
- Expand in `AgentConfigSchema` zod transform: possible future hardening but out of scope for
  this fix.

### Decision 3: Dedup Key — Normalized Absolute Path + Git Remote Fallback

**What:** Compute the canonical key in two steps:

1. Resolve symlinks: `fs.realpathSync(project.path)` — catches `~/dev/link → ~/dev/nx`.
2. Normalize case: lowercase on `process.platform === "darwin"` (HFS+ / APFS
   case-insensitive), preserve case on Linux.
3. If `git remote get-url origin` exits 0 within 500 ms, use that URL as the canonical
   cross-machine identity key (e.g. `git@github.com:owner/repo.git`). Otherwise fall back to
   the normalized path.

The git remote lookup is done once per project per aggregation cycle and cached with the
project entry.

**Why:** Home directory paths differ across machines (`/home/alice/dev/nx` vs
`/Users/alice/dev/nx`). A git remote URL is machine-independent and already present for every
tracked project. The fallback to normalized path handles monorepos, local-only projects, and
cases where git is not available.

**Alternatives considered:**
- Use `name` field only as key: rejected — different projects on different machines can share
  names (e.g. two devs both have a `web` project).
- Hash of directory contents: rejected — expensive, unstable across branch switches.
- Require a `nexus-id` file in each project root: rejected — too invasive, requires user
  action.

### Decision 4: Stale Project Eviction — 1-Hour TTL in Aggregated View

**What:** The aggregated map (client-side, in `fetchDiscoveredProjects`) tracks `lastSeenAt`
per key. On each refresh, entries not returned by any agent in the current cycle have their
`lastSeenAt` unchanged. Entries where `Date.now() - lastSeenAt > 3_600_000` (1 hour) are
dropped before the result is returned.

This TTL lives in the TtlCache layer, not the per-project cache. It survives across short
cache misses.

**Why:** Without eviction, agents that go offline leave their projects in the aggregated list
forever. 1 hour is long enough to survive temporary agent outages (network blip, restart) but
short enough to clean up stale entries within a single work session.

**Alternatives considered:**
- No eviction, clear on agent offline: rejected — agents go offline during reboots without
  sending a disconnect signal.
- Evict immediately when agent returns offline: rejected — aggressive; causes projects to
  flicker during brief outages.
- DB-persisted expiry: out of scope — this is a presentation-layer concern, not a data
  persistence concern.

### Decision 5: Agent Field Frozen at First Report

**What:** On dedup hit (same canonical key from two agents), do NOT overwrite the `agent`
field. The first agent to respond "owns" the entry. `machineCount` increments normally.

**Why:** The `agent` field drives the "open on machine X" action in the UI. If it changes
non-deterministically across refreshes (because `Promise.allSettled` does not guarantee order),
the action target changes, which is confusing. Freezing at first report gives stable UI
behaviour. If the owning agent goes offline, the entry is eventually evicted (Decision 4) and
re-owned by whichever agent reports it next.

### Decision 6: Protocol Versioning — Graceful Degradation

**What:** The Next.js client must handle responses from both old agents (with `hasActiveSessions`)
and new agents (with `activeSessions`/`totalSessions`). Detection logic:

```typescript
const activeSessions =
  typeof project.activeSessions === "number"
    ? project.activeSessions
    : project.hasActiveSessions
      ? 1
      : 0;
```

This shim is removed once all agents are upgraded. It is annotated with a
`// TODO(fix-project-discovery): remove after all agents upgraded` comment.

## Risks / Trade-offs

- **Git remote exec risk**: spawning `git remote get-url origin` for each discovered project
  adds latency to the aggregation cycle. Mitigated by a 500 ms hard timeout and by caching the
  result alongside the project entry.

- **realpathSync throws on broken symlinks**: mitigated by wrapping in try/catch and logging
  a warning; broken symlinks are skipped, not errored.

- **Case normalization on macOS**: lowercasing paths could theoretically collide two
  legitimately different paths if a case-sensitive volume is mounted on macOS. Accepted risk —
  uncommon and the correct behaviour is to deduplicate them in this scenario anyway.

## Migration Plan

1. Deploy agent update first (wire format change: add `activeSessions`/`totalSessions`, keep
   `hasActiveSessions` for one release cycle).
2. Deploy Next.js client with graceful degradation shim (Decision 6).
3. After all agents are confirmed upgraded (monitor via `X-Cache-Age` header and agent version
   field), remove `hasActiveSessions` from the interface and the client shim.
4. No DB migration required.

## Open Questions

- Should `registryId` be looked up synchronously in the route handler (adds one DB query per
  project entry) or lazily on demand? Current decision: synchronous, batched with a single
  `IN (...)` query after the directory scan. Revisit if scan latency exceeds 500 ms.
- Should `queryWindowHours` be configurable per-agent via the DB row, or as a global constant?
  Current decision: global constant (24 h) until a user story requires per-agent tuning.
