# Proposal: add-dashboard-observability-baseline

## Summary

Three observability baseline gaps bundled: wire PostHog provider in apps/nextjs, add `/api/health` endpoint for deploy-monitor + uptime checks, switch `release` env var in Sentry instrumentation to `NEXUS_VERSION` with npm_package_version fallback. Closes F5/F8/G10 from audit #4.

## Context

Extends `apps/nextjs/src/`, `apps/agent/src/instrument.ts`. Related: archived `2026-04-18-harden-notification-reliability` (most recent observability work — added `withChannelTimeout` + Sentry breadcrumbs).

**Investigation findings:**
- `apps/agent/src/instrument.ts:15` confirms `release: process.env.npm_package_version` (G10 exact match)
- `apps/nextjs/src/instrumentation.ts` does NOT exist — Next.js Sentry is wired via `sentry.server.config.ts` and `sentry.client.config.ts` (both present); neither has a `release` field at all (not just non-standard — missing entirely)
- `posthog-js` is absent from `apps/nextjs/package.json` (F5 confirmed)
- `apps/nextjs/src/app/api/` has only `projects/` and `ws-token/` — no health route (F8 confirmed)

## Motivation

Dashboard lacks analytics (no PostHog → no feature usage visibility). Deploy monitor's git_hook health check currently auto-skips because /api/health returns 404 — silent CI regression waiting to bite. Sentry `release` field uses a non-standard env var that makes prod vs dev releases indistinguishable without the pnpm-auto-injected value; `sentry.server.config.ts` and `sentry.client.config.ts` are missing the `release` field entirely.

## Requirements (ADDED)

### PostHog provider in Next.js dashboard

apps/nextjs MUST wire PostHog via the official `posthog-js` package. Initialization MUST be gated on a `NEXT_PUBLIC_POSTHOG_KEY` env var (missing key → no-op, no errors). Provider MUST be rendered at the app root (likely `apps/nextjs/src/app/layout.tsx`).

### Health endpoint for deploy monitor

apps/nextjs MUST expose `GET /api/health` returning `{ status: "ok", version: string, timestamp: string }` with HTTP 200 under normal operation. The endpoint MUST be dynamic (force-dynamic) so it does not serve stale static responses. The endpoint MUST NOT perform DB or agent calls in v1.

### Standardized release env var

Sentry instrumentation (`apps/agent/src/instrument.ts` and `apps/nextjs/sentry.server.config.ts` + `sentry.client.config.ts`) MUST read release version from `NEXUS_VERSION` env var, with `npm_package_version` as a fallback for dev. `.env.example` MUST document `NEXUS_VERSION`.

## Scope

**IN:** Three baseline items above.

**OUT:** Event taxonomy design for PostHog (which events to track — that's a follow-up product decision); deep health endpoint (DB ping, agent ping — v2 scope); rename of existing npm_package_version references outside instrumentation.

## Impact

- `apps/nextjs/package.json` — add `posthog-js` dep
- `apps/nextjs/src/app/layout.tsx` (or root provider) — wrap in PostHogProvider
- `apps/nextjs/src/app/api/health/route.ts` — NEW file
- `apps/nextjs/src/components/posthog-provider.tsx` — NEW file
- `apps/agent/src/instrument.ts:15` — env var switch
- `apps/nextjs/sentry.server.config.ts` — add release field with NEXUS_VERSION ?? npm_package_version
- `apps/nextjs/sentry.client.config.ts` — same
- `.env.example` — add `NEXUS_VERSION`, `NEXT_PUBLIC_POSTHOG_KEY`, `NEXT_PUBLIC_POSTHOG_HOST`

## Risks

- **PostHog key leak:** Use `NEXT_PUBLIC_` prefix correctly so only the public write-key ever reaches the browser. Never expose admin/API key.
- **Health endpoint performance:** Response must stay <50ms; no DB/agent calls in v1.
- **`NEXUS_VERSION` undefined in dev:** Fallback to `npm_package_version` prevents breakage.
