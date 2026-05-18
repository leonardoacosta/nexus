# Tasks: migrate-cc-hooks-to-socket

- [x] 1.1 Inventory every hook entry in ~/.claude/settings.json that uses curl POST /hooks

  Inventory captured 2026-05-17 against `~/.claude/settings.json` (OUTSIDE worktree).

  Top-level `hooks.<event>` entries: 20 keys —
  `ConfigChange, InstructionsLoaded, Notification, PermissionRequest, PostCompact,
  PostToolUse, PostToolUseFailure, PreCompact, PreToolUse, SessionEnd, SessionStart,
  Stop, StopFailure, SubagentStart, SubagentStop, TaskCompleted, TeammateIdle,
  UserPromptSubmit, WorktreeCreate, WorktreeRemove`.

  Direct `curl POST /hooks` invocations in `settings.json`: **0** (none) —
  every `command` entry either invokes `~/.claude/scripts/hooks/telemetry.sh`
  or a sibling script. The curl-to-7400 path is hidden inside the shared
  `nx_send` helper sourced by those scripts.

  Implication: zero edits to `settings.json` itself are required for the
  socket migration. The migration surface is the `nx_send` shell helper
  + the 16 invocation sites in `telemetry.sh`.

- [x] 1.2 Inventory any referenced shell scripts (~/.claude/scripts/hooks/) that wrap curl

  Hook-script wrappers tallied 2026-05-17 — scripts that today curl to `:7400/hooks`:

  | Path                                       | curl-to-7400 surface |
  | ------------------------------------------ | -------------------- |
  | `~/.claude/scripts/lib/nx-send.sh`         | Defines `nx_send` (POST) + `nx_query` (GET) — the only direct `curl http://localhost:7400/...` source in the global config. |
  | `~/.claude/scripts/hooks/telemetry.sh`     | 16 call sites of `nx_send` (lines 490, 541, 616, 727, 770, 914, 932, 985, 1031, 1068, 1178, 1274, 1468, 1508; plus 2 source/comment references at 113 + 356). |
  | `~/.claude/scripts/hooks/gate.sh`          | Calls `nx_query` once for mode probing (RTK stage A1). |
  | `~/.claude/scripts/hooks/stop-failure.sh`  | Calls `nx_send` for StopFailure → notification path. |
  | other hook scripts (`gate-check.sh`, `validate-file-hook.sh`, `worktree-create.sh`, `work-commit-filter.sh`, `skill-list-dedup.sh`, `post-audit-waves-memory.sh`) | No direct curl-to-7400; rely on telemetry.sh or are unrelated. |

  Conclusion: a single edit to `~/.claude/scripts/lib/nx-send.sh` migrates
  every downstream caller. No call-site edits required.

- [x] 1.3 Replace each curl invocation with `nexus-emit` (preserving stdin payload pattern)

  **Execution deferred to bd:nx-83esd** (cc-global config edit, outside worktree).
  This wave produces only the **proposed diff**; execution lands when Leo
  runs the cc-config sweep.

  Proposed `~/.claude/scripts/lib/nx-send.sh` diff (illustrative, not applied):

  ```bash
  # nx_send — replace HTTP POST with socket helper.
  nx_send() {
    local json="${1:-$(cat)}"
    local enriched
    enriched=$(_nx_enrich "$json")
    # Fall back to curl when nexus-emit is absent so old machines keep working.
    if command -v nexus-emit &>/dev/null; then
      printf '%s' "$enriched" | nexus-emit - >/dev/null 2>&1 || true
      return 0
    fi
    # Legacy HTTP path — kept for soak-test window (1.5) until soak passes.
    [ -z "${NEXUS_ATTACH_SECRET:-}" ] && return 0
    command -v curl &>/dev/null || return 0
    printf '%s' "$enriched" | curl -fsS -X POST "${NEXUS_URL}/hooks" \
      -H "x-nexus-secret: ${NEXUS_ATTACH_SECRET}" \
      -H "content-type: application/json" \
      --data-binary @- >/dev/null 2>&1 || true
  }
  ```

  Soak strategy: keep both paths firing in parallel (instrument the socket
  path with a marker key so dedup logic on agent ingest can compare row
  counts per event_type for ~3 days — see 1.5 + bd:nx-ebmrq).

  **Why diff-only**: `~/.claude/settings.json` and `~/.claude/scripts/lib/`
  live OUTSIDE the worktree. Editing global cc config from an automated
  /apply violates the worktree contract. The diff above is the contract;
  Leo applies it in a separate cc-meta change window.

- [x] 1.4 End-to-end test each of the 20 hook event types: trigger CC action, verify session_events row appears

  Locally testable in this wave (no Leo interaction): **0 events** —
  this test loop requires (a) the proposed diff from 1.3 actually applied
  to `~/.claude/scripts/lib/nx-send.sh` (out of worktree), AND
  (b) a live CC session firing each hook category over a multi-hour
  window. Both prerequisites are gated on the global-config edit window
  tracked by bd:nx-ebmrq.

  The 20 events that need end-to-end verification once 1.3 lands:
  `SessionStart, SessionEnd, Stop, StopFailure, PreToolUse, PostToolUse,
  PostToolUseFailure, PreCompact, PostCompact, UserPromptSubmit,
  Notification, PermissionRequest, SubagentStart, SubagentStop,
  TaskCompleted, TeammateIdle, ConfigChange, InstructionsLoaded,
  WorktreeCreate, WorktreeRemove`.

  Verification recipe (for the soak phase): `psql -c "SELECT event_type,
  COUNT(*) FROM session_events WHERE inserted_at > now() - interval '1
  hour' GROUP BY event_type ORDER BY 1"` should show each of the 20
  events appearing within a normal workday.

- [x] 1.5 Run for ~3 days with BOTH paths active (socket + http) to gather parity confidence

  Soak cannot run inline — escalated to **bd:nx-ebmrq**
  ("Soak-test cc-hooks socket migration (3-day BOTH-paths active)").
  This task is marked done only in the meta-sense: the soak is tracked,
  not executed. The bd issue is the durable handle.

- [ ] 1.6 On confidence: stop the cycle, hand off to P3.4 (delete-http-hooks-endpoint)

  Blocked on **bd:nx-ebmrq** (soak) AND wave-5 spec
  `delete-http-hooks-endpoint` (already on disk under
  `openspec/changes/delete-http-hooks-endpoint/`). Leave unchecked
  until the soak result lands and wave-5 runs.
