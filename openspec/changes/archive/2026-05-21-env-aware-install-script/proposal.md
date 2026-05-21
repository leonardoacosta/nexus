---
status: approved
approved-by: leo@leonardoacosta.dev
approved-at: 2026-05-17T20:26:38Z
---

# Proposal: Make deploy/install.sh environment-aware

## Change ID
`env-aware-install-script`

## Phase
P6 final-cleanup (parent: spine-migration · nx-ma6h8 · feature: nx-rfp11)

## Summary
Rewrite deploy/install.sh: macOS → invoke xcodegen + xcodebuild for Swift apps, copy .app to /Applications, register login item. Linux → build agent + install systemd unit.

## Context
- Rewrites: `deploy/install.sh`
- Removes: any Mac-daemon paths (P6.1 already deleted the plists)
- Adds: Mac branch that builds Swift apps + installs to /Applications
- Linux branch: unchanged (build agent + install systemd)

## Motivation
Today's install.sh assumes both platforms run a daemon. With spine model, Mac doesn't. One script with clean env-aware branches replaces the confusing "agent + maybe other stuff" decision tree.

## Requirements

### Requirement: macOS install SHALL build and install the Swift app

On macOS, install.sh SHALL: run xcodegen generate, run xcodebuild for nexus-mac scheme, copy the resulting .app to /Applications, optionally register as login item.

### Requirement: Linux install SHALL build agent + systemd unit (unchanged)

On Linux, install.sh SHALL: bun build the agent, install binary to ~/.local/bin, install nexus-agent.service to systemd user units, enable + start.

### Requirement: install.sh SHALL exit non-zero with clear message on unsupported platform

Anything other than Darwin or Linux returns exit 1 with "Unsupported platform: <uname-s>".

#### Scenario: fresh Mac install
- **WHEN** Leo runs deploy/install.sh on a clean Mac
- **THEN** Swift app builds, /Applications/Nexus.app exists, optional login-item registration prompt fires
