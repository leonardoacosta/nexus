# Implementation Tasks

<!-- beads:epic:nx-20ug -->

## API Batch

- [x] [1.1] [P-1] Add /api/health route at apps/nextjs/src/app/api/health/route.ts returning { status, version, timestamp } with export const dynamic = 'force-dynamic' [owner:api-engineer] [beads:nx-spz1]
- [x] [1.2] [P-1] Switch release env var in apps/agent/src/instrument.ts:15 from npm_package_version to (NEXUS_VERSION ?? npm_package_version) [owner:api-engineer] [beads:nx-rsrt]
- [x] [1.3] [P-2] Add release field to apps/nextjs/sentry.server.config.ts and sentry.client.config.ts using (NEXUS_VERSION ?? npm_package_version) — these files currently have no release field at all [owner:api-engineer] [beads:nx-h2wm]
- [x] [1.4] [P-2] Add NEXUS_VERSION and NEXT_PUBLIC_POSTHOG_KEY and NEXT_PUBLIC_POSTHOG_HOST to .env.example [owner:api-engineer] [beads:nx-w8ii]

## UI Batch

- [ ] [2.1] [P-1] Add posthog-js dependency to apps/nextjs/package.json [owner:ui-engineer] [beads:nx-cltc]
- [ ] [2.2] [P-2] Create PostHogProvider wrapper at apps/nextjs/src/components/posthog-provider.tsx — gated on NEXT_PUBLIC_POSTHOG_KEY, no-op if missing [owner:ui-engineer] [beads:nx-9r8c]
- [ ] [2.3] [P-3] Wire PostHogProvider at apps/nextjs/src/app/layout.tsx as the outermost client boundary [owner:ui-engineer] [beads:nx-3lii]

## E2E Batch

- [ ] [3.1] Unit test /api/health returns 200 with { status: "ok", version: string, timestamp: string } [owner:e2e-engineer] [beads:nx-fauy]
- [ ] [3.2] Unit test PostHogProvider no-ops when NEXT_PUBLIC_POSTHOG_KEY is unset (no posthog.init call, no errors) [owner:e2e-engineer] [beads:nx-b8fr]
- [ ] [3.3] Unit test instrument.ts reads NEXUS_VERSION with npm_package_version fallback [owner:e2e-engineer] [beads:nx-onf8]
