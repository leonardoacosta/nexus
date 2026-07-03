import { describe, expect, it } from "bun:test";
import type { Db } from "@nexus/db";
import { credentials } from "@nexus/db";
import { attributeTurnToCredential } from "./attribution";

type SessionRow = { credentialId: string | null; credentialFingerprint: string | null };
type CredRow = { fingerprint: string | null };

// Minimal fake of the drizzle chain used by attributeTurnToCredential:
// db.select(...).from(table).where(...).limit(1) resolving to an array of rows.
// .from() receives the real sessions/credentials table object, so we route on it.
function fakeDb(opts: { sessionRows?: SessionRow[]; credRows?: CredRow[] }): Db {
  return {
    select: () => {
      let rows: unknown[] = [];
      const b = {
        from(table: unknown) {
          rows = table === credentials ? (opts.credRows ?? []) : (opts.sessionRows ?? []);
          return b;
        },
        where() { return b; },
        limit() { return Promise.resolve(rows); },
      };
      return b;
    },
  } as unknown as Db;
}

describe("attributeTurnToCredential", () => {
  const ts = new Date("2026-07-03T00:00:00.000Z"); // _turnTs is currently unused

  it("(C) passes through when the session has id + fingerprint", async () => {
    const db = fakeDb({ sessionRows: [{ credentialId: "cred-1", credentialFingerprint: "fp-abc" }] });
    expect(await attributeTurnToCredential(db, "sess-1", ts))
      .toEqual({ credentialId: "cred-1", credentialFingerprint: "fp-abc" });
  });

  it("(B) looks up the fingerprint when the session has an id but no fingerprint", async () => {
    const db = fakeDb({
      sessionRows: [{ credentialId: "cred-2", credentialFingerprint: null }],
      credRows: [{ fingerprint: "fp-looked-up" }],
    });
    expect(await attributeTurnToCredential(db, "sess-2", ts))
      .toEqual({ credentialId: "cred-2", credentialFingerprint: "fp-looked-up" });
  });

  it("(B) returns null fingerprint when the credential row is missing", async () => {
    const db = fakeDb({
      sessionRows: [{ credentialId: "cred-3", credentialFingerprint: null }],
      credRows: [], // no matching credential
    });
    expect(await attributeTurnToCredential(db, "sess-3", ts))
      .toEqual({ credentialId: "cred-3", credentialFingerprint: null });
  });

  it("(A) returns nulls when the session is not found", async () => {
    const db = fakeDb({ sessionRows: [] });
    expect(await attributeTurnToCredential(db, "missing", ts))
      .toEqual({ credentialId: null, credentialFingerprint: null });
  });

  it("returns nulls when the session has no credential assigned", async () => {
    const db = fakeDb({ sessionRows: [{ credentialId: null, credentialFingerprint: null }] });
    expect(await attributeTurnToCredential(db, "sess-4", ts))
      .toEqual({ credentialId: null, credentialFingerprint: null });
  });
});
