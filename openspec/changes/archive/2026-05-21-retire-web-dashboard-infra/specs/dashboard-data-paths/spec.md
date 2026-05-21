## REMOVED Requirements

### Requirement: Next.js web dashboard on port 3100

**Reason for removal**: P5.1 (`swift-dashboard-feature-parity`) brought the Swift app to full parity. The web dashboard becomes pure maintenance overhead.

**Migration**: `apps/nextjs/`, `packages/ui/`, `deploy/nexus-dashboard.service`, `deploy/traefik/`, and `deploy/nexus-bundle-manager.sh` (if web-only) are deleted in a single atomic commit. The systemd dashboard unit MUST be stopped + disabled before file deletion.

#### Scenario: web URL no longer resolves
- **GIVEN** the removal commit is merged + deployed
- **WHEN** browsing to the web dashboard URL
- **THEN** the connection is refused (Traefik gone) OR Traefik returns 404 (Traefik present but route gone)

#### Scenario: nexus-dashboard.service no longer exists
- **GIVEN** the removal is complete
- **WHEN** `systemctl --user list-unit-files | grep nexus-dashboard`
- **THEN** zero matches

### Requirement: web-specific packages

**Reason for removal**: `packages/ui/` (web component library) and any web-only dependencies become dead code once apps/nextjs is gone.

**Migration**: `git rm -r packages/ui/`. Remove from pnpm workspace + root tsconfig references.

#### Scenario: pnpm install succeeds without web packages
- **GIVEN** the removal is complete
- **WHEN** `pnpm install` runs on a fresh checkout
- **THEN** install succeeds; no errors about missing @nexus/ui or @nexus/nextjs
