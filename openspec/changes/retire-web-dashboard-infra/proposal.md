# Proposal: Retire web dashboard infrastructure

## Change ID
`retire-web-dashboard-infra`

## Phase
P5 web-deprecation (parent: spine-migration · nx-ma6h8 · feature: nx-rguah)

## Summary
Once Swift parity is verified (P5.1), bundle-delete apps/nextjs, packages/ui, deploy/nexus-dashboard.service, deploy/traefik, and audit/delete deploy/nexus-bundle-manager.sh.

## Context
- Deletes: `apps/nextjs/` (full Next.js 15 dashboard, ~hundreds of files)
- Deletes: `packages/ui/` (web component library)
- Deletes: `deploy/nexus-dashboard.service` (systemd)
- Deletes: `deploy/traefik/` (dynamic config)
- Audits: `deploy/nexus-bundle-manager.sh` (likely delete if web-only)
- Depends-on: `swift-dashboard-feature-parity` (P5.1 · nx-urao8)

## Motivation
With Swift parity verified, the web stack is pure overhead — a maintained dependency for zero use. Removing it eliminates a build pipeline, a deploy unit, a routing layer, and a UI component library.

## Requirements

### Requirement: all listed paths SHALL be deleted in one commit

Single commit titled "chore: retire web dashboard stack". Atomic delete avoids a half-state where Traefik routes to a stopped service.

### Requirement: nexus-dashboard.service SHALL be stopped + disabled before deletion

`systemctl --user stop nexus-dashboard && systemctl --user disable nexus-dashboard` SHALL run before the systemd unit file is deleted.

#### Scenario: web URL returns 404 post-deletion
- **GIVEN** deletion complete
- **WHEN** browsing to the web dashboard URL
- **THEN** receives Traefik 404 (or connection refused if Traefik is also down)
