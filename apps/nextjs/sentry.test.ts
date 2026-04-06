import { describe, it, expect } from "vitest";
import type * as Sentry from "@sentry/nextjs";
import { scrubSensitiveHeaders } from "./sentry.server.config";

type ErrorEvent = Parameters<typeof scrubSensitiveHeaders>[0];

function makeEvent(headers: Record<string, string>): ErrorEvent {
  return { type: "error", request: { headers } } as unknown as ErrorEvent;
}

describe("scrubSensitiveHeaders (server)", () => {
  it("removes Authorization header", () => {
    const result = scrubSensitiveHeaders(
      makeEvent({ Authorization: "Bearer token123", "content-type": "application/json" }),
    );
    expect(result?.request?.headers).not.toHaveProperty("Authorization");
    expect(result?.request?.headers).toHaveProperty("content-type");
  });

  it("removes x-nexus-secret header", () => {
    const result = scrubSensitiveHeaders(
      makeEvent({ "x-nexus-secret": "super-secret", host: "localhost" }),
    );
    expect(result?.request?.headers).not.toHaveProperty("x-nexus-secret");
    expect(result?.request?.headers).toHaveProperty("host");
  });

  it("removes Cookie header (both cases)", () => {
    const result = scrubSensitiveHeaders(
      makeEvent({ Cookie: "session=abc", cookie: "other=xyz", accept: "*/*" }),
    );
    expect(result?.request?.headers).not.toHaveProperty("Cookie");
    expect(result?.request?.headers).not.toHaveProperty("cookie");
    expect(result?.request?.headers).toHaveProperty("accept");
  });

  it("removes lowercase authorization header", () => {
    const result = scrubSensitiveHeaders(
      makeEvent({ authorization: "Bearer tok", "x-request-id": "abc" }),
    );
    expect(result?.request?.headers).not.toHaveProperty("authorization");
    expect(result?.request?.headers).toHaveProperty("x-request-id");
  });

  it("is a no-op when no sensitive headers present", () => {
    const result = scrubSensitiveHeaders(
      makeEvent({ host: "localhost", accept: "*/*" }),
    );
    expect(result?.request?.headers).toEqual({ host: "localhost", accept: "*/*" });
  });

  it("handles missing request.headers gracefully", () => {
    const event = { type: "error", request: {} } as unknown as ErrorEvent;
    const result = scrubSensitiveHeaders(event);
    expect(result).toBe(event);
  });

  it("handles missing request gracefully", () => {
    const event = { type: "error" } as unknown as ErrorEvent;
    const result = scrubSensitiveHeaders(event);
    expect(result).toBe(event);
  });
});
