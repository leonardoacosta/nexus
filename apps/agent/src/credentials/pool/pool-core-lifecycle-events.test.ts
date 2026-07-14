/**
 * Live-PG lifecycle-event coverage for CredentialPool lease/release
 * (close-credential-page-e2e-debt task 4.4 / nx-b0ew).
 *
 * Verifies the credential lifecycle audit stream: a `cc_profile_events` row
 * (renamed from `credential_events`) is persisted for BOTH a lease and a
 * release. `CredentialPool.emitEvent` is fire-and-forget (`void`), so the
 * assertions poll for the row rather than reading immediately after the call
 * returns.
 *
 * NOTE ON SCOPE: this spec's other three tasks (warning banner, agent source
 * attribution, MCP provider pills) describe the NATIVE SwiftUI CredentialsView
 * (apps/swift/nexus-mac/Sources/Dashboard/CredentialsView.swift) — nx has no
 * web credential page, so Playwright (the proposal's assumed harness) cannot
 * exercise them. This task, `cc_profile_events` persistence, is the one
 * behaviour that lives in the Bun/agent backend and is testable here.
 *
 * PG-gated on NEXUS_PG_TESTS=1 + POSTGRES_URL (skips cleanly otherwise). Uses an
 * isolated throwaway schema so it never touches `public`.
 */

import { describe, expect, it, beforeAll, afterAll } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ccProfileEvents } from "@nexus/db";
import { CredentialPool } from "./pool-core";
import { TEST_KEY } from "../credentials.helpers";
import { hasLivePg as hasPg } from "../../testing/live-pg";
import {
  createIsolatedSchema,
  type IsolatedSchema,
} from "../../testing/isolated-pg-schema";

// credentials (pool storage) + cc_profile_events (lifecycle audit stream).
// Mirrors packages/db/src/schema/{credentials,ccProfileEvents}.ts; agent_id FK
// dropped for test isolation (the pool always writes agentId: null).
const DDL = `
CREATE TABLE credentials (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  value_encrypted text,
  encryption_key_id text DEFAULT 'v1',
  agent_id text,
  status text NOT NULL DEFAULT 'available',
  leased_by text,
  leased_at timestamp,
  cooldown_until timestamp,
  rate_limit_count integer NOT NULL DEFAULT 0,
  fingerprint text NOT NULL DEFAULT '',
  duplicate_group_id text,
  is_primary boolean NOT NULL DEFAULT false,
  subscription_type text,
  rate_limit_tier text,
  expires_at timestamptz,
  account_email text,
  account_name text,
  account_uuid text,
  org_name text,
  org_uuid text,
  mcp_providers text,
  usage_5h_used integer,
  usage_5h_limit integer,
  usage_5h_reset_at timestamptz,
  usage_7d_used integer,
  usage_7d_limit integer,
  usage_7d_reset_at timestamptz,
  usage_polled_at timestamptz,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX credentials_fingerprint_idx ON credentials (fingerprint);
CREATE TABLE cc_profile_events (
  id text PRIMARY KEY,
  profile_id text NOT NULL,
  event_type text NOT NULL,
  session_id text,
  metadata jsonb,
  created_at timestamp NOT NULL DEFAULT now()
);
`;

const oauthValue = JSON.stringify({
  claudeAiOauth: {
    refreshToken: "rt-lifecycle-0001",
    accessToken: "at-lifecycle-0001",
    expiresAt: 1893456000000,
  },
});

describe.skipIf(!hasPg)("CredentialPool lease/release lifecycle events", () => {
  let iso: IsolatedSchema;
  let pool: CredentialPool;

  beforeAll(async () => {
    iso = await createIsolatedSchema(DDL, "cred_lifecycle");
    pool = new CredentialPool(iso.db, { encryptionKey: TEST_KEY });
  });

  afterAll(async () => {
    await iso.drop();
  });

  /** Poll for a cc_profile_events row (emitEvent is fire-and-forget). */
  async function waitForEvent(
    profileId: string,
    eventType: string,
    attempts = 25,
  ): Promise<{ eventType: string; sessionId: string | null } | null> {
    for (let i = 0; i < attempts; i++) {
      const rows = await iso.db
        .select()
        .from(ccProfileEvents)
        .where(
          and(
            eq(ccProfileEvents.profileId, profileId),
            eq(ccProfileEvents.eventType, eventType),
          ),
        );
      if (rows.length > 0) {
        return { eventType: rows[0]!.eventType, sessionId: rows[0]!.sessionId };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    return null;
  }

  it("persists a cc_profile_events row on BOTH lease and release", async () => {
    const name = `acct-lifecycle-${randomUUID().slice(0, 8)}`;
    const outcome = await pool.add({
      id: randomUUID(),
      name,
      type: "oauth",
      value_plaintext: oauthValue,
    });
    expect(outcome).toBe("inserted");

    // Lease → emits a "leased" event carrying the lessee.
    const leased = await pool.lease("oauth", "sess-lifecycle");
    expect(leased).not.toBeNull();
    const credentialId = leased!.id;

    const leasedEvent = await waitForEvent(credentialId, "leased");
    expect(leasedEvent).not.toBeNull();
    expect(leasedEvent!.sessionId).toBe("sess-lifecycle");

    // Release → emits a "released" event for the same credential.
    const released = await pool.release(credentialId);
    expect(released).toBe(true);

    const releasedEvent = await waitForEvent(credentialId, "released");
    expect(releasedEvent).not.toBeNull();
    expect(releasedEvent!.eventType).toBe("released");
  });
});
