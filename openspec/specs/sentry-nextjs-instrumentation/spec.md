# sentry-nextjs-instrumentation Specification

## Purpose
TBD - created by archiving change harden-dashboard-stability. Update Purpose after archive.
## Requirements
### Requirement: Next.js instrumentation hook for Sentry v8
`apps/nextjs/instrumentation.ts` MUST exist at the repository root of the Next.js app (sibling to `next.config.ts`) and satisfy all of the following:

- Exports an async `register()` function
- Inside `register()`, conditionally imports `./sentry.server.config` only when `process.env.NEXT_RUNTIME === 'nodejs'`
- Exports `onRequestError` set to `Sentry.captureRequestError` from `@sentry/nextjs`
- Does NOT call `Sentry.init` directly — delegates to the existing config files
- Does NOT import edge config (no `sentry.edge.config.ts` in this project)

#### Scenario: Server-side error captured by Sentry
Given the `instrumentation.ts` is present and `SENTRY_DSN` is set,
When an unhandled exception is thrown in a Next.js Server Component or Route Handler,
Then `Sentry.captureRequestError` is invoked via `onRequestError` and the error is forwarded to Sentry before the 500 response is sent.

#### Scenario: Dev environment — no DSN
Given `SENTRY_DSN` is not set,
When `register()` is called during Next.js startup,
Then `sentry.server.config.ts` is imported but the `if (dsn)` guard inside it prevents `Sentry.init` from being called — no error thrown, no crash.

#### Scenario: TypeScript diagnostic resolved
Given `instrumentation.ts` exists with correct exports,
When the TypeScript language server runs over `apps/nextjs/`,
Then no TS-1128 "Declaration or statement expected" diagnostic is emitted for `instrumentation.ts`.

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

