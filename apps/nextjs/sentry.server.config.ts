import * as Sentry from "@sentry/nextjs";

/** Strip sensitive headers from Sentry events before they leave the process. */
function scrubSensitiveHeaders(
  event: Sentry.ErrorEvent,
): Sentry.ErrorEvent | null {
  if (event.request?.headers) {
    const scrubbed = { ...event.request.headers };
    delete scrubbed["Authorization"];
    delete scrubbed["authorization"];
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
    release: process.env.NEXUS_VERSION ?? process.env.npm_package_version,
    tracesSampleRate: 1.0,
    sendDefaultPii: false,
    beforeSend: scrubSensitiveHeaders,
  });
}

export { scrubSensitiveHeaders };
