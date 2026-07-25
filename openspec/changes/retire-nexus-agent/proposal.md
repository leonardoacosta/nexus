---
order: 0725a
---

# Retire the Nexus agent and decommission the nx fleet surface

## Why

Nexus was built as a cross-machine observability spine for Claude Code sessions. A 2026-07-25
audit of what it actually carries found the value has drained out of every lane except one:

- **Hook telemetry is ingested and discarded.** cc's `telemetry.sh` pushes ~28K events/day into
  the agent socket under event names the dispatcher has no `case` for (`hook_output_metrics` is
  96% of volume, plus `instructions_loaded`, `config_change`, `teammate_idle`, `command_start`,
  `session_terminate`, `command_metadata`, `task_completed`, `worktree_create`). Every one hits
  `default:` and is logged at WARN, then dropped. The typed `event: "telemetry"` case has zero
  producers.
- **The CC-cost reader is dark on both axes.** `telemetry/vm-read.ts` +
  `telemetry/session-cost-read.ts` query cc's native OTel series in VictoriaMetrics, but `VM_URL`
  is unset in the deployed `~/.env` (so the client self-disables) and `handleGetSessionTokens`
  is exported without an importer (so `GET /sessions/:id/tokens` is unrouted).
- **`POST /health/ingest` has no producer.** Its own handler comment names "the Rust collector",
  retired in v2. All 86,007 `health_snapshots` rows come from the in-process 30s scheduler
  (2,870 rows/24h against 2,880 expected).
- **Dead routes.** `routes/cursor.ts` and `routes/recommend.ts` export handlers no non-test file
  imports.

The one capability with no second path is **TTS**: Kokoro and ElevenLabs are reachable only
through the agent's notification manager. That capability moves to a dedicated kokoro hook
served from the homelab and piped through `leonardoacosta/herdr-shepherd`, which is the
subject of the three sibling proposals this one depends on.

Everything else the agent carries — cross-machine session listing, health history, `/analytics/*`,
APNs push, the Swift dashboard suite — is being retired rather than ported.

**The credential pool is the one exception.** It is being in-housed by `inhouse-credential-subsystem`
in `leonardoacosta/herdr-shepherd`, which lifts the 150 credential rows out of this repo's Postgres
store into `plugins/herdr-state/pkg/credentials`. That proposal was 4-of-6 complete on 2026-07-25
with its live-import task still outstanding, so this proposal is hard-blocked behind it: stopping
the agent or dropping the database first would destroy the import's only source.

## Context

- depends on: `herdr-shepherd-kokoro-notify`, `cc-kokoro-notify-replace-nx-send`, `inhouse-credential-subsystem`
- touches: `apps/agent`, `apps/nexus-emit`, `apps/nexus-statusline`, `apps/web`, `apps/swift`, `packages/core`, `packages/db`, `deploy`, `.claude/project.toml`, `README.md`
- base-commit: nexus@3b726e62

**Scope boundary — this proposal is the nx-side decommission ONLY.** Leo's 2026-07-25 decision
was one proposal per repo. The other two are authored from their own repo roots:

| Order | Repo | Proposal | Owns |
| --- | --- | --- | --- |
| 1 | `~/dev/personal/homelab` | `homelab-kokoro-service` (authored, `hl-0dx8`) | Stand up the kokoro container on the homelab box |
| 2 | `leonardoacosta/herdr-shepherd` | `herdr-shepherd-kokoro-notify` (authored, `hs-2vk`) | `plugins/herdr-state/pkg/notify` + `bin/notify.sh` pipe + notify board |
| 3 | `~/dev/cc` | `cc-kokoro-notify-replace-nx-send` (authored, `cc-wlm13`) | New `say_notify` calling the herdr pipe, delete `nx-send.sh` and its 25 call sites, repoint `BASH_ENV` + the TTS-Summary output style, sweep 38 doc refs |
| 4 | `~/dev/personal/nexus` | **this proposal** | Stop and remove the agent, units, Swift/web surfaces, and data |

Ordering is strict: kokoro serves, then the herdr pipe ships, then cc cuts over and is verified
speaking, then this proposal executes. Nothing here runs while cc still routes TTS through the
agent. Delivery model is homelab-synthesizes / Mac-plays; the pipe owns that hop.

**Replacement scope is speak-only** (Leo's decision). The agent's `notifications/` tree is ~40
files — rules engine, presence context, quiet hours, meeting/DND state, rate throttle, held
queue, dedup, speakability, cross-machine delivery, audio store, Telegram channel. None of it is
ported. Every `nx_notify` call reaching the new hook speaks, so notification volume rises; that
tradeoff was chosen explicitly over porting the guards.

## Preconditions

Every probe below must pass before task 1.1 runs. These are environmental assumptions this
proposal depends on, not things it creates.

| Probe | Expected |
| --- | --- |
| `curl -sf -o /dev/null -w '%{http_code}' "$HERDR_KOKORO_URL/health"` | `200` |
| `systemctl --user is-active nexus-agent` | `active` (the thing being retired is currently up) |
| `test -e ~/dev/cc/scripts/lib/nx-send.sh; echo $?` | `1` — cc deleted the transport, so no caller can still reach the agent |
| `grep -c '^- \[ \]' ~/dev/cc/openspec/changes/cc-kokoro-notify-replace-nx-send/tasks.md` | `0` — cc cutover complete and verified speaking |
| `psql "$POSTGRES_URL" -tAc "select count(*) from health_snapshots"` | non-zero integer (DB reachable for the dump) |
| `grep -c '^- \[ \]' ~/dev/personal/herdr-shepherd/openspec/changes/inhouse-credential-subsystem/tasks.md` | `0` — every task complete, including 4.1's real import against the live Postgres store and 4.2's nexus-agent-stopped verification |
| `git -C ~/dev/personal/nexus status --porcelain \| wc -l` | `0` — clean tree before a destructive run |
| `ls ~/.config/systemd/user/nexus-*.{service,timer}` | 4 units present (`nexus-agent`, `nexus-homelab-deploy` x2, `nexus-listener`) |

## Testing

| Seam | Verification | tasks.md ref |
| --- | --- | --- |
| TTS delivery after agent stop | Speak a test phrase through the cc kokoro hook with `nexus-agent` stopped; confirm audible output | 4.1 |
| Data preservation | `pg_dump` artifact restores into a scratch DB and row counts match pre-drop | 1.2 |
| Unit teardown | `systemctl --user list-unit-files \| grep -c nexus` returns `0` | 4.2 |
| Socket removal | `test -S ~/.config/nexus/agent.sock` returns non-zero | 4.2 |
| Fleet non-breakage | `harness` index page renders and cc hooks exit 0 with the agent gone | 4.3 |
| No dangling refs | Fleet grep for `nexus-agent`/`:7400`/`agents.toml` returns only archived/historical matches | 4.4 |

N/A — no user-facing web flow survives this change; `apps/web` is removed rather than modified.

## Done Means

- `systemctl --user list-unit-files | grep nexus` returns nothing, and the machine survives a
  reboot with no nexus unit starting.
- Leo hears a spoken notification triggered from a Claude Code session with no nexus process
  running anywhere on the fleet.
- The `nexus` Postgres database is either dumped-and-dropped or dumped-and-retained per the
  User Gate decision, with the dump artifact stored at a path Leo names.
- `~/dev/personal/nexus` is archived or deleted per the User Gate decision; no fleet repo
  contains a live (non-archived) reference to `nexus-agent`, `:7400`, or `agents.toml`.
- No Claude Code session emits a `nexus-emit: command not found` or comparable error after the
  cutover.

## Decisions

- proposal split — chosen: one proposal per repo (herdr-shepherd, cc, nx), chained by strict ordering; rejected: single cross-repo proposal, cc-only proposal with nx cleanup folded in; decided-by: leo
- notification feature scope — chosen: speak-only, drop routing/presence/quiet-hours/meeting/throttle/held-queue/dedup/cross-machine; rejected: port quiet-hours + rate-throttle + dedup, full parity port into shepherd; decided-by: leo
- kokoro hosting — chosen: served from the homelab, piped through herdr; rejected: kokoro on the Mac, reuse of an existing instance; decided-by: leo
- shepherd repo identity — chosen: `leonardoacosta/herdr-shepherd` (repo created 2026-07-25); rejected: folding the service into homelab or cc; decided-by: leo
- delta capability shape — chosen: one new `nexus-decommission` capability using `## ADDED Requirements`; rejected: `## REMOVED Requirements` deltas against the 92 existing capabilities (the misplaced-REMOVED-header class already cost this repo one fix commit, nx-z92vl / 084f8ea2); decided-by: default
- `stack:` value — chosen: `infra` (teardown is units/data/deploy work; batches read as provision/wire/surface/verify); rejected: a bun- or swift-flavored value, none of which is in the `stack:` enum; decided-by: default
- destructive-step placement — chosen: DB drop and repo deletion deferred to a terminal `## User Gate` as `[user:post]`; rejected: agent-executed drop/delete inside the DB batch; decided-by: default
- APNs / session history / cross-machine session listing / `/analytics/*` — chosen: retire without replacement; rejected: port to herdr-shepherd; decided-by: leo
- credential pool — chosen: NOT retired here — it is being in-housed by `inhouse-credential-subsystem` in `leonardoacosta/herdr-shepherd` (`plugins/herdr-state/pkg/credentials`, 4 of 6 tasks already done as of 2026-07-25); this proposal must not stop the agent or drop the database until that proposal's task 4.1 has run the real import against the live Postgres store; rejected: the earlier "retire without replacement" reading, which would have destroyed 150 credential rows the import still needs; decided-by: default (correction of an authoring error, not a Leo reversal)
