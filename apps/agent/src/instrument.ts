import * as Sentry from "@sentry/node";

/**
 * Initialize Sentry for the nexus-agent process.
 *
 * Must be imported before any other application code.
 * No-ops gracefully when SENTRY_DSN is not set (dev/local environments).
 */
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    release: process.env.npm_package_version,
    // Capture 100% of transactions in production; tune down if volume is high
    tracesSampleRate: 1.0,
    // Don't send PII — no user context, no IP addresses
    sendDefaultPii: false,
  });
}

export { Sentry };
