## ADDED Requirements

### Requirement: Standardized Sentry release version

Sentry instrumentation MUST read the `release` configuration from `NEXUS_VERSION` env var, with `npm_package_version` as a fallback for dev environments where pnpm auto-injects the version. This applies to `apps/agent/src/instrument.ts` (which currently uses `npm_package_version` directly) and `apps/nextjs/sentry.server.config.ts` + `sentry.client.config.ts` (which currently omit the `release` field entirely).

#### Scenario: Production override

- **GIVEN** `NEXUS_VERSION=1.2.3` is set
- **WHEN** Sentry initializes
- **THEN** errors are tagged with `release: "1.2.3"`, regardless of `npm_package_version`

#### Scenario: Dev fallback

- **GIVEN** `NEXUS_VERSION` is unset but pnpm auto-injects `npm_package_version=0.1.0`
- **WHEN** Sentry initializes
- **THEN** errors are tagged with `release: "0.1.0"`
