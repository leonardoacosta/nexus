# Proposal: Remove the macOS nexus-agent daemon path from deploy hooks + install.sh

## Change ID

remove-macos-deploy-agent-daemon

## Phase

Spine migration follow-up — completes the Mac-daemon decommission.

## Summary

Both git deploy hooks (`pre-push/01-deploy`, `post-merge/02-deploy`) and
`deploy/install.sh` still contain a macOS `Darwin)` branch that installs and
bootstraps a `com.nexus.agent` launchd daemon. The spine-migration architecture
(`remove-mac-deploy-artifacts`, `env-aware-install-script`) already decided
macOS runs **no** nexus-agent daemon — it is a pure Swift app + Tailnet member.
Those changes deleted the checked-in `deploy/com.nexus.agent.plist` and rewrote
`install.sh`, but left the hooks' Darwin daemon branch and `install.sh`'s inline
plist generator in place. The result is the `nx-cq0ol` crash (`sed: …
com.nexus.agent.plist: No such file or directory`) and a standing architectural
inconsistency. This change removes the dead macOS daemon path entirely.

## Context

- Removes: macOS daemon-install branch from `deploy/hooks.d/pre-push/01-deploy` and `deploy/hooks.d/post-merge/02-deploy`
- Removes: vestigial `com.nexus.agent.plist` inline generation from `deploy/install.sh`
- Removes: now-dead `bootstrap_with_retry()` helper in both hooks (only the removed Darwin branch called it)
- touches: `deploy/hooks.d/pre-push/01-deploy`, `deploy/hooks.d/post-merge/02-deploy`, `deploy/install.sh`
- depends on: `env-aware-install-script`, `remove-mac-deploy-artifacts`
- Resolves beads: nx-cq0ol

## Motivation

macOS owns zero daemon infrastructure under the spine model (Swift app +
Tailscale only; the dashboard reads remote agents over the Tailnet). Keeping a
half-wired Mac-agent install path is not just dead code — it actively breaks:
every macbook post-merge, every macOS pre-push, and every homelab→macbook
remote fanout fails on the missing plist template and silently writes an empty
launchd plist. Removing the path fixes the crash and closes the drift class
(`remove-mac-deploy-artifacts` already requires "zero deploy/ files reference
Mac-side daemons" — this finishes enforcing that for the hooks + install.sh).

## Requirements

### Requirement: No macOS nexus-agent daemon in deploy

The deploy hooks and `install.sh` MUST NOT, on `Darwin`, generate a
`com.nexus.agent` launchd plist, write to `~/Library/LaunchAgents/`, or invoke
`launchctl bootstrap`/`bootout`/`kickstart` for `com.nexus.agent`. macOS deploy
is limited to Swift-app build/install (owned by `env-aware-install-script`).

### Requirement: deploy hooks succeed on macOS and via homelab→macbook fanout

After this change, running the pre-push hook on macOS, a macbook post-merge,
and a homelab→macbook remote fanout MUST complete with zero `sed`/plist errors
and MUST NOT create an empty `~/Library/LaunchAgents/com.nexus.agent.plist`.
