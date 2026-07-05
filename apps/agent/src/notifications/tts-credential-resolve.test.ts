/**
 * TTS ElevenLabs credential resolution (add-elevenlabs-credential task 2.6).
 *
 * Verifies the precedence the TTS channel applies before synthesis:
 *   - DB row (decrypted) WINS over the ELEVENLABS_API_KEY env var
 *   - env var is used when no DB row exists (unmigrated agents)
 *   - null (→ signal-only) when neither source has a key
 *
 * Drives the real encryption helpers via a stub NEXUS_ENCRYPTION_KEY.
 *
 * Spec: openspec/changes/add-elevenlabs-credential/
 */

import { describe, expect, it, beforeEach, afterAll, mock } from "bun:test";
import type { Db } from "@nexus/db";
import * as coreNode from "@nexus/core/node";

// mock.module is PROCESS-GLOBAL; spread the real barrel so sibling suites keep
// every other @nexus/core/node export (nx-jlx1c).
mock.module("@nexus/core/node", () => ({
  ...coreNode,
  logger: {
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  },
  createLogger: () => ({
    info: mock(() => {}),
    warn: mock(() => {}),
    error: mock(() => {}),
    debug: mock(() => {}),
  }),
  getAgentId: mock(() => "test-agent"),
}));

import { resolveElevenLabsCredential } from "./router";
import { encrypt } from "../credentials/encryption";

const STUB_KEY = Buffer.alloc(32, 7);
const savedEnvKey = process.env.NEXUS_ENCRYPTION_KEY;
const savedApiKey = process.env.ELEVENLABS_API_KEY;
const savedVoiceId = process.env.ELEVENLABS_VOICE_ID;

function fakeDbWithRow(
  row: { valueEncrypted: string | null; voiceId: string | null } | null,
): Db {
  return {
    query: {
      elevenlabsCredentials: {
        findFirst: mock(async () => row ?? undefined),
      },
    },
  } as unknown as Db;
}

beforeEach(() => {
  process.env.NEXUS_ENCRYPTION_KEY = STUB_KEY.toString("hex");
  delete process.env.ELEVENLABS_API_KEY;
  delete process.env.ELEVENLABS_VOICE_ID;
});

afterAll(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("NEXUS_ENCRYPTION_KEY", savedEnvKey);
  restore("ELEVENLABS_API_KEY", savedApiKey);
  restore("ELEVENLABS_VOICE_ID", savedVoiceId);
});

describe("resolveElevenLabsCredential", () => {
  it("DB row wins over the env var", async () => {
    process.env.ELEVENLABS_API_KEY = "BBB";
    const db = fakeDbWithRow({
      valueEncrypted: encrypt("AAA", STUB_KEY),
      voiceId: "voice-db",
    });
    const cred = await resolveElevenLabsCredential(db);
    expect(cred).not.toBeNull();
    expect(cred!.apiKey).toBe("AAA");
    expect(cred!.voiceId).toBe("voice-db");
  });

  it("falls back to the env var when no DB row exists", async () => {
    process.env.ELEVENLABS_API_KEY = "CCC";
    process.env.ELEVENLABS_VOICE_ID = "voice-env";
    const db = fakeDbWithRow(null);
    const cred = await resolveElevenLabsCredential(db);
    expect(cred).not.toBeNull();
    expect(cred!.apiKey).toBe("CCC");
    expect(cred!.voiceId).toBe("voice-env");
  });

  it("returns null (signal-only) when neither DB row nor env var has a key", async () => {
    const db = fakeDbWithRow(null);
    const cred = await resolveElevenLabsCredential(db);
    expect(cred).toBeNull();
  });

  it("falls back to env when the stored key cannot be decrypted", async () => {
    process.env.ELEVENLABS_API_KEY = "DDD";
    const db = fakeDbWithRow({
      valueEncrypted: Buffer.from("garbage").toString("base64"),
      voiceId: null,
    });
    const cred = await resolveElevenLabsCredential(db);
    expect(cred).not.toBeNull();
    expect(cred!.apiKey).toBe("DDD");
  });
});
