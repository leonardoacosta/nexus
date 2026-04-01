# Proposal: Remote Deploy Fan-Out

## Change ID
`add-remote-deploy`

## Summary
Extend the post-merge deploy hook to SSH into remote agents from agents.toml, wait 2 seconds
(let git settle), then pull, build, and deploy on each remote machine.

## Context
- Extends: `deploy/hooks.d/post-merge/02-deploy` (current local-only deploy script)
- Related: `~/.config/nexus/agents.toml` (agent registry with host/user info)
- Depends on: Tailscale peer-to-peer networking (SSH between machines)

## Motivation
Currently `02-deploy` only builds and restarts the agent on the local machine. With 2+ machines
(omarchy Linux homelab, macbook Mac), a push to main only deploys locally — the other machine
stays on stale binaries until someone manually SSHes and rebuilds. The deploy should fan out to
all registered agents automatically.

## Requirements
### Req-1: Fan-out to remote agents after local deploy
After the local build + restart succeeds, the deploy hook MUST SSH into each remote agent
listed in agents.toml, wait 2 seconds, then run `cd ~/dev/nx && git pull && deploy/hooks.d/post-merge/02-deploy --force`.

### Req-2: Parse agents.toml for remote targets
The script MUST read agents.toml to discover remote hosts, skipping the local machine
(self_name or localhost). Uses host + user fields for SSH target.

### Req-3: Non-blocking remote deploy with status reporting
Remote deploys MUST NOT block the git hook exit. Run in background with timeout. Report
success/failure per machine via TTS notification.

## Scope
- **IN**: Remote SSH deploy fan-out in 02-deploy, agents.toml parsing, 2s delay, status reporting
- **OUT**: Cross-compilation, binary shipping, new config formats, CI/CD changes

## Impact
| Area | Change |
|------|--------|
| deploy/hooks.d/post-merge/02-deploy | Add remote fan-out section after local deploy |
| agents.toml | Read-only — parse for remote targets |

## Risks
| Risk | Mitigation |
|------|-----------|
| SSH key not set up for remote | Use ssh -o ConnectTimeout=5, log warning and skip |
| Remote repo not at ~/dev/nx | Use agents.toml or convention; fallback gracefully |
| Remote build fails | Log error, continue to next host, TTS notify |
| Git hook timeout | Background the remote deploys, don't block the hook |
