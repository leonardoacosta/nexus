# Design: remove-macos-deploy-agent-daemon

## Decision

Remove the macOS `nexus-agent` daemon-install path everywhere it survives
(both deploy hooks + `install.sh`), rather than repairing it. macOS runs no
Nexus daemon under the spine model — repairing the plist path would entrench
infrastructure two active specs explicitly delete.

## Options considered (from beads nx-cq0ol)

| Option | Verdict |
| --- | --- |
| A — hooks delegate to `install.sh` | Rejected: `install.sh` has no agent-only mode; unconditionally runs `xcodegen`+`xcodebuild` on Darwin → full Swift build on every push |
| B — extract plist heredoc to shared `deploy/lib/gen-agent-plist.sh` | Rejected after discovery: keeps a macOS agent daemon, contradicting `remove-mac-deploy-artifacts` ("zero daemon infrastructure on Mac") and `env-aware-install-script` ("with spine model, Mac doesn't [run a daemon]") |
| C — restore checked-in plist | Rejected: reintroduces the `$USER`/`$HOME` drift `install.sh:191-194` deleted it to fix |
| **D (chosen) — remove the macOS daemon path** | Fixes the `nx-cq0ol` crash AND closes the architectural inconsistency; smallest correct change; no new drift class |

## Why discovery overrode the original recommendation

`nx-cq0ol` was filed recommending Option B before the two active deploy specs
were inspected. `remove-mac-deploy-artifacts` (Mac = pure Swift app + Tailnet,
no agent) and `env-aware-install-script` (macOS branch = Swift build only)
establish that the Mac agent daemon is intentionally decommissioned. The
surviving Darwin branch in the hooks + the inline plist generator in
`install.sh` are leftovers those specs did not finish removing. Option B would
have re-cemented them.

## Affected sites

- `deploy/hooks.d/pre-push/01-deploy` — `Darwin)` case body (~L108–117) + dead `bootstrap_with_retry()` (~L20–42)
- `deploy/hooks.d/post-merge/02-deploy` — `Darwin)` case body (~L152–164) + dead `bootstrap_with_retry()`
- `deploy/install.sh` — inline `com.nexus.agent.plist` block (~L191–268: comment, `PLIST=`, XML heredoc L231–257, launchctl echo L267–268). Swift-app build path is untouched (owned by `env-aware-install-script`).

`bootstrap_with_retry` is confirmed called only from the removed Darwin
branches (pre-push L116, post-merge L160); Linux uses `systemctl`. Removing the
helper is entailed by removing its sole caller (Reader Gate — no orphan code).

## Out of scope

- Swift app build/login-item logic on macOS (owned by `env-aware-install-script`)
- The Linux/systemd branch (correct, unchanged)
- Archiving `env-aware-install-script` / `remove-mac-deploy-artifacts` (separate housekeeping)
