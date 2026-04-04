# Proposal: Auto Credential Rotation on Rate Limit

## Change ID
`add-credential-rotation`

## Summary
Nexus agent manages multiple Claude Code OAuth credentials, monitors per-account usage via the
Anthropic API, and automatically swaps the active credential when a session hits a rate limit —
sending "continue" to resume the session seamlessly.

## Context
- Extends: `crates/nexus-agent/src/services/credential_watcher.rs` (file watching), `crates/nexus-agent/src/socket.rs` (notification interception), `crates/nexus-agent/src/dispatch.rs` (tmux send-keys), `crates/nexus-status/src/main.rs` (usage API client)
- Related: `2026-03-21-session-broker` (command dispatch pattern), `2026-03-21-status-bar-telemetry` (rate limit telemetry)
- Confirmed: CC re-reads `~/.claude/.credentials.json` from disk on each API call — symlink swap takes effect immediately across all sessions without restart.

## Motivation
Claude Code sessions hit 5-hour and 7-day usage rate limits. When this happens, the session stops
and the user must manually intervene. With multiple accounts available (personal, work, team), Nexus
can automatically rotate to the account with the most remaining capacity, resume the session, and
notify the user only when all accounts are exhausted. This eliminates idle time between rate limit
hits and maximizes throughput across accounts.

## Requirements

### Req-1: Credential Pool Service
The agent manages a pool of OAuth credentials stored in `~/.config/nexus/credentials/`. Each file
is a JSON object matching the Claude Code `.credentials.json` format. The service parses each file
on startup, watches for changes via inotify/kqueue, and maintains an in-memory registry of all
accounts with their current usage data.

### Req-2: Usage Monitoring (Hybrid Strategy)
The agent polls the Anthropic usage API (`/api/oauth/usage`) for each credential on a 5-minute
interval (proactive), and immediately on rate limit detection (on-demand). Results are persisted
to `~/.config/nexus/state/usage-cache.json` so they survive restarts and are available instantly
on next boot. Each account tracks: `five_hour.utilization`, `five_hour.resets_at`,
`seven_day.utilization`, `seven_day.resets_at`, `last_polled`.

### Req-3: Rate Limit Interception
When a session emits a "You've hit your limit" notification via socket event, or a
`rate_limit_event` with `utilization >= 1.0`, the agent intercepts it before TTS delivery. Instead
of announcing the limit, it triggers the credential rotation flow.

### Req-4: Credential Swap via Symlink
The active credential is always `~/.claude/.credentials.json` which is a symlink pointing to one
file in `~/.config/nexus/credentials/`. On rotation, the agent atomically replaces the symlink
(`remove_file` + `symlink`) to point to the credential with the lowest combined utilization
(`min(five_hour.utilization, seven_day.utilization)`).

### Req-5: Auto-Continue Sessions
After swapping credentials, the agent sends "continue" to the affected session via
`tmux send-keys` using the existing `dispatch_answer` mechanism. No user confirmation required.

### Req-6: Cross-Session Debounce
If multiple sessions hit the rate limit within a 3-minute window after a swap, the agent
auto-sends "continue" to each without re-querying usage or re-swapping. The credential was already
rotated — subsequent sessions just need to be told to retry.

### Req-7: Exhaustion Notification
When ALL credentials are exhausted (all accounts at utilization >= 1.0), the agent sends a
notification listing each account name, its limit type (5h/7d), and when it resets. It identifies
the soonest-to-reset account. Format:
```
All accounts rate-limited:
  personal: 5h resets 2:15 PM
  work: 7d resets Thu
  team: 5h resets 1:45 PM ← next available
```

## Scope
- **IN**: Credential file management, usage API polling, rate limit interception, symlink swap,
  auto-continue via tmux, cross-session debounce, exhaustion notification, usage cache persistence
- **OUT**: OAuth token refresh (assume tokens are valid/refreshed externally), credential file
  creation UI (user manually places files), per-session credential assignment (all sessions share
  the active credential), TUI credential management screen

## Impact
| Area | Change |
|------|--------|
| nexus-core | New `CredentialAccount` and `UsageWindow` types, `SocketEvent::RateLimitHit` variant |
| nexus-agent/services | New `credential_pool.rs` service, modified `credential_watcher.rs` |
| nexus-agent/socket | Intercept rate limit notifications before TTS delivery |
| nexus-agent/dispatch | Reuse `dispatch_answer` for sending "continue" |
| nexus-status | Extract usage API client into nexus-core for reuse |
| Config | New `~/.config/nexus/credentials/` directory convention |
| State | New `~/.config/nexus/state/usage-cache.json` persisted cache |

## Risks
| Risk | Mitigation |
|------|-----------|
| OAuth token expiry per account | Check `expiresAt` field before selecting; skip expired tokens |
| Symlink race on concurrent reads | Atomic `remove_file` + `symlink` on same filesystem; CC reads are non-transactional single-file reads |
| Usage API rate limiting itself | 5-min poll interval is conservative; cache results to avoid redundant calls |
| No credentials in pool dir | Graceful fallback — operate in passthrough mode, no interception |
| tmux target not set on session | Skip auto-continue for non-tmux sessions; log warning |
