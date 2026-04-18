## ADDED Requirements

### Requirement: PostHog provider in Next.js dashboard

The dashboard MUST wire PostHog via `posthog-js` at the app root. Initialization MUST be gated on `NEXT_PUBLIC_POSTHOG_KEY` — when the env var is missing, the provider MUST no-op silently and not throw.

#### Scenario: Production with key

- **GIVEN** `NEXT_PUBLIC_POSTHOG_KEY` is set in the Next.js runtime
- **WHEN** the app root renders
- **THEN** PostHog is initialized exactly once and subsequent `usePostHog()` hooks return a valid client

#### Scenario: Dev without key

- **GIVEN** `NEXT_PUBLIC_POSTHOG_KEY` is unset
- **WHEN** the app root renders
- **THEN** no PostHog initialization occurs, no network request is made, and `usePostHog()` returns a no-op stub

### Requirement: Health endpoint for uptime monitoring

The dashboard MUST expose `GET /api/health` returning `{ status: "ok", version: string, timestamp: string }` with HTTP 200 under normal operation. The endpoint MUST be dynamic (no static prerendering) and MUST NOT perform DB or agent calls in v1.

#### Scenario: Deploy monitor health check

- **GIVEN** the dashboard is running after a deploy
- **WHEN** the deploy monitor issues `curl /api/health`
- **THEN** a 200 response is returned within 50ms with the shape above
