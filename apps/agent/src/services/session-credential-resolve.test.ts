/**
 * Unit + live-PG tests for `resolveSessionAccountUsage`
 * (nexus-session-scoped-credentials-endpoint).
 *
 * Coverage:
 *   1. `sessions.credentialId` explicit binding wins when present (no
 *      `getAgentId()`/snapshot involvement needed).
 *   2. Same-machine live snapshot resolves when `credentialId` is null AND
 *      `session.machine === getAgentId()`.
 *   3. Different-machine session → `null` (no live signal for a remote host,
 *      even when the local snapshot has a fingerprint).
 *   4. No active-credential snapshot yet (fingerprint null) on the local
 *      machine → `null`.
 *   5. Local-machine match but the snapshot's fingerprint has no `credentials`
 *      row → `null` (never guesses).
 */

import {
  describe,
  it,
  expect,
  spyOn,
  beforeEach,
  afterEach,
  beforeAll,
  afterAll,
} from "bun:test";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { getAgentId, resetAgentIdCache } from "@nexus/core/node";
import * as credentialWatcherMod from "../credentials/credential-watcher";
import { resolveSessionAccountUsage } from "./session-credential-resolve";
import {
  createIsolatedSchema,
  type IsolatedSchema,
} from "../testing/isolated-pg-schema";
import { hasLivePg as hasPg } from "../testing/live-pg";

const CREDENTIALS_DDL = `
  CREATE TABLE "credentials" (
    "id" text PRIMARY KEY NOT NULL,
    "name" text NOT NULL,
    "type" text NOT NULL,
    "value_encrypted" text,
    "encryption_key_id" text DEFAULT 'v1',
    "agent_id" text,
    "status" text DEFAULT 'available' NOT NULL,
    "leased_by" text,
    "leased_at" timestamp,
    "cooldown_until" timestamp,
    "rate_limit_count" integer DEFAULT 0 NOT NULL,
    "fingerprint" text DEFAULT '' NOT NULL,
    "duplicate_group_id" text,
    "is_primary" boolean DEFAULT false NOT NULL,
    "subscription_type" text,
    "rate_limit_tier" text,
    "expires_at" timestamp with time zone,
    "account_email" text,
    "account_name" text,
    "account_uuid" text,
    "org_name" text,
    "org_uuid" text,
    "mcp_providers" text,
    "usage_5h_used" integer,
    "usage_5h_limit" integer,
    "usage_5h_reset_at" timestamp with time zone,
    "usage_7d_used" integer,
    "usage_7d_limit" integer,
    "usage_7d_reset_at" timestamp with time zone,
    "usage_polled_at" timestamp with time zone,
    "created_at" timestamp DEFAULT now() NOT NULL,
    "updated_at" timestamp DEFAULT now() NOT NULL
  );
`;

const FIVE_H_RESET = new Date("2026-07-14T18:00:00.000Z");
const SEVEN_D_RESET = new Date("2026-07-20T00:00:00.000Z");

describe.skipIf(!hasPg)(
  "resolveSessionAccountUsage (requires live PG)",
  () => {
    let iso: IsolatedSchema;
    let db: Db;
    let snapSpy:
      | ReturnType<typeof spyOn<typeof credentialWatcherMod, "getActiveCredentialSnapshot">>
      | undefined;

    beforeAll(async () => {
      iso = await createIsolatedSchema(CREDENTIALS_DDL, "sesscred");
      db = iso.db;

      await db.insert(credentials).values({
        id: "cred-bound",
        name: "bound-directly",
        type: "anthropic",
        fingerprint: "fp-bound",
        isPrimary: true,
        usage5hUsed: 5,
        usage5hLimit: 50,
        usage5hResetAt: FIVE_H_RESET,
        usage7dUsed: 100,
        usage7dLimit: 500,
        usage7dResetAt: SEVEN_D_RESET,
      });

      await db.insert(credentials).values({
        id: "cred-snapshot",
        name: "snapshot-matched",
        type: "anthropic",
        fingerprint: "fp-snapshot",
        isPrimary: true,
        usage5hUsed: 10,
        usage5hLimit: 100,
        usage5hResetAt: FIVE_H_RESET,
        usage7dUsed: 200,
        usage7dLimit: 1000,
        usage7dResetAt: SEVEN_D_RESET,
      });
    });

    afterAll(async () => {
      await iso.drop();
    });

    beforeEach(() => {
      // NEXUS_CONFIG_DIR points nowhere + cache reset (same convention as
      // db/agent-registry.test.ts). NOTE: some sibling suites install a
      // process-global `getAgentId` mock (`testing/mock-core-node.ts`,
      // `mock.module` — leaks forward across files in the full-suite run,
      // nx-509z5). Rather than assume a specific resolved value (which
      // breaks under that leak), every test below calls `getAgentId()`
      // itself and uses THAT value for `session.machine` — self-consistent
      // with whatever the resolver-under-test's own `getAgentId()` call
      // sees, mocked or real.
      resetAgentIdCache();
      process.env.NEXUS_CONFIG_DIR = "/tmp/nexus-nonexistent-for-test";
    });

    afterEach(() => {
      snapSpy?.mockRestore();
      resetAgentIdCache();
    });

    it("resolves via sessions.credentialId when explicitly bound", async () => {
      const acct = await resolveSessionAccountUsage(db, {
        credentialId: "cred-bound",
        machine: "some-other-machine",
      });
      expect(acct).toEqual({
        accountId: "cred-bound",
        fiveHour: { used: 5, limit: 50, resetsAt: FIVE_H_RESET.toISOString() },
        sevenDay: { used: 100, limit: 500, resetsAt: SEVEN_D_RESET.toISOString() },
      });
    });

    it("resolves via the local active-credential snapshot when the session's machine matches this process", async () => {
      snapSpy = spyOn(
        credentialWatcherMod,
        "getActiveCredentialSnapshot",
      ).mockReturnValue({
        fingerprint: "fp-snapshot",
        resolvedPath: "/home/x/.claude/.credentials.json",
        observedAt: new Date().toISOString(),
      });

      const acct = await resolveSessionAccountUsage(db, {
        credentialId: null,
        machine: getAgentId(),
      });
      expect(acct).toEqual({
        accountId: "cred-snapshot",
        fiveHour: { used: 10, limit: 100, resetsAt: FIVE_H_RESET.toISOString() },
        sevenDay: { used: 200, limit: 1000, resetsAt: SEVEN_D_RESET.toISOString() },
      });
    });

    it("returns null for a session on a different machine, even with a local snapshot fingerprint", async () => {
      snapSpy = spyOn(
        credentialWatcherMod,
        "getActiveCredentialSnapshot",
      ).mockReturnValue({
        fingerprint: "fp-snapshot",
        resolvedPath: "/home/x/.claude/.credentials.json",
        observedAt: new Date().toISOString(),
      });

      const acct = await resolveSessionAccountUsage(db, {
        credentialId: null,
        // Guaranteed to differ from whatever getAgentId() resolves to
        // (real or mocked) — see the beforeEach note above.
        machine: `${getAgentId()}-a-totally-different-machine`,
      });
      expect(acct).toBeNull();
    });

    it("returns null when the local snapshot has no fingerprint yet", async () => {
      snapSpy = spyOn(
        credentialWatcherMod,
        "getActiveCredentialSnapshot",
      ).mockReturnValue({
        fingerprint: null,
        resolvedPath: null,
        observedAt: new Date().toISOString(),
      });

      const acct = await resolveSessionAccountUsage(db, {
        credentialId: null,
        machine: getAgentId(),
      });
      expect(acct).toBeNull();
    });

    it("returns null when the snapshot fingerprint has no matching credentials row", async () => {
      snapSpy = spyOn(
        credentialWatcherMod,
        "getActiveCredentialSnapshot",
      ).mockReturnValue({
        fingerprint: "fp-unknown-to-db",
        resolvedPath: "/home/x/.claude/.credentials.json",
        observedAt: new Date().toISOString(),
      });

      const acct = await resolveSessionAccountUsage(db, {
        credentialId: null,
        machine: getAgentId(),
      });
      expect(acct).toBeNull();
    });
  },
);
