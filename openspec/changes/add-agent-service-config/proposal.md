# Add Agent Service Config

## Why
The nexus-agent binary needs to run as a persistent system service that auto-starts on boot and restarts on crash. Without proper service configuration, operators must manually start the agent after every reboot or failure.

## What Changes
Create a systemd unit file and a macOS launchd plist for the compiled Bun `nexus-agent` binary. Add an install script that copies the binary and service file into place and enables the service. Configure automatic restart on failure.

## Specs
See specs/ directory (if applicable).
