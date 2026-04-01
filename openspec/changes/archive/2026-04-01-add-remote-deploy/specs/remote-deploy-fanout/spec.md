# remote-deploy-fanout Specification

## Purpose
Fan out deploy to all registered agents via SSH after local deploy succeeds.

## ADDED Requirements

### Requirement: The deploy hook MUST fan out to remote agents after local deploy
After local build + service restart, the script MUST iterate non-local agents from agents.toml,
SSH to each, and trigger pull + build + deploy.

#### Scenario: Two agents, local + remote
Given agents.toml has omarchy (local) and macbook (remote)
When a git push triggers the post-merge hook on omarchy
Then omarchy builds locally, then SSHes to macbook and runs deploy

#### Scenario: Remote unreachable
Given macbook is offline or SSH fails
When the deploy hook attempts remote fan-out
Then it logs a warning, sends TTS notification, and exits 0 (does not block)

#### Scenario: Remote build fails
Given macbook is reachable but cargo build fails
When the remote deploy runs
Then the failure is logged and reported via TTS, other remotes still attempted

### Requirement: The deploy hook MUST wait 2 seconds before remote pull
The SSH command MUST sleep 2 seconds before git pull to let the push complete on the remote.

#### Scenario: Timing
Given a push just completed locally
When the remote deploy starts
Then it sleeps 2s, then runs git pull, ensuring the pushed commit is available

### Requirement: Remote deploys MUST run in background
The remote SSH commands MUST be backgrounded so the git hook returns promptly.

#### Scenario: Hook returns fast
Given 3 remote agents are configured
When the local deploy completes
Then remote deploys are launched in background and the hook exits immediately
