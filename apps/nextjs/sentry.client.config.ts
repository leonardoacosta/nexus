import * as Sentry from "@sentry/nextjs";

/** Strip sensitive headers from Sentry events before they leave the process. */
function scrubSensitiveHeaders(
  event: Sentry.ErrorEvent,
): Sentry.ErrorEvent | null {
  if (event.request?.headers) {
    const scrubbed = { ...event.request.headers };
    delete scrubbed["Authorization"];
    delete scrubbed["authorization"];
    delete scrubbed["x-nexus-secret"];
    delete scrubbed["Cookie"];
    delete scrubbed["cookie"];
    event.request = { ...event.request, headers: scrubbed };
  }
  return event;
}

const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? "production",
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    // Replay integration for session replay (optional)
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1.0,
    beforeSend: scrubSensitiveHeaders,
  });
}

export { scrubSensitiveHeaders };
