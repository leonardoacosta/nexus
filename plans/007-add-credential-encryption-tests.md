# Plan 007: Characterization tests exist for the credential AES-256-GCM encryption module

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 64a206ff..HEAD -- apps/agent/src/credentials/encryption.ts`
> If `encryption.ts` changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (this is a PREREQUISITE for plan 008)
- **Category**: tests
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

`apps/agent/src/credentials/encryption.ts` is the crypto boundary protecting
every stored Anthropic/ElevenLabs credential at rest, and it has ZERO tests. It
is imported by 12 modules (`credentials/pool/pool-core.ts`,
`cc-credential-manager.ts`, `server.ts`, ...) and the in-flight
`add-elevenlabs-credential` change reuses these helpers as-is. A silent break in
the storage format (`base64(nonce||ciphertext||authTag)`), the key
length/encoding parsing, or the GCM auth-tag handling would corrupt or expose
credentials with nothing to catch it. This plan adds a pure-additive
characterization test file that locks in the current, correct behavior so plan
008 can build on a verified foundation.

## Current state

- `apps/agent/src/credentials/encryption.ts` (116 lines) — the module under
  test. Exports four functions, no tests exist for it. Key facts:
  - `encrypt(plaintext: string, key: Buffer): string` — AES-256-GCM. Generates a
    random 12-byte nonce, returns `base64(nonce[12] || ciphertext[n] || authTag[16])`.
  - `decrypt(ciphertext: string, key: Buffer): string` — inverse of `encrypt`.
    Throws `"decrypt: ciphertext too short — invalid or corrupted"` when the
    decoded buffer is shorter than `NONCE_BYTES + AUTH_TAG_BYTES` (28 bytes).
    Otherwise throws on GCM auth failure (wrong key or tampered bytes) via
    `decipher.final()`.
  - `loadEncryptionKey(): Buffer` — reads env var **`NEXUS_ENCRYPTION_KEY`**
    (name only; never print or hardcode a value). Accepts a **64-char hex**
    string (`/^[0-9a-fA-F]{64}$/`) OR a **44-char base64** string
    (`/^[A-Za-z0-9+/]{43}=$/`), both decoding to exactly 32 bytes. Throws if the
    var is absent, malformed, or not exactly 32 bytes.
  - `loadPrerotateThreshold(): number` — reads env var
    **`NEXUS_PREROTATE_THRESHOLD`**. Returns `0.85` when unset. Parses with
    `parseFloat`; throws when the value is `NaN`, `<= 0.0`, or `> 1.0`.

  Load-bearing excerpts (confirm these match before writing tests):

  ```ts
  // encryption.ts:24-34 — encrypt
  export function encrypt(plaintext: string, key: Buffer): string {
    const nonce = randomBytes(NONCE_BYTES);            // NONCE_BYTES = 12
    const cipher = createCipheriv(ALGO, key, nonce);   // ALGO = "aes-256-gcm"
    const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();               // AUTH_TAG_BYTES = 16
    const combined = Buffer.concat([nonce, encrypted, authTag]);
    return combined.toString("base64");
  }

  // encryption.ts:67-99 — loadEncryptionKey (env var name only)
  const raw = process.env.NEXUS_ENCRYPTION_KEY;
  if (raw.length === 64 && /^[0-9a-fA-F]{64}$/.test(raw)) key = Buffer.from(raw, "hex");
  else if (raw.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(raw)) key = Buffer.from(raw, "base64");
  else throw new Error("NEXUS_ENCRYPTION_KEY is malformed. ...");

  // encryption.ts:107-118 — loadPrerotateThreshold
  const raw = process.env.NEXUS_PREROTATE_THRESHOLD;
  if (!raw) return 0.85;
  const value = parseFloat(raw);
  if (isNaN(value) || value <= 0.0 || value > 1.0) throw new Error(...);
  ```

- `apps/agent/src/credentials/credential-watcher.test.ts` — the **structural
  pattern** to match. Note its conventions:
  - Imports from `bun:test`: `import { describe, test, expect } from "bun:test";`
    (this repo uses `test`, not `it`).
  - Top-of-file JSDoc block explaining what the suite locks in.
  - `describe("<module> <function>", () => { ... })` grouping, one `test(...)`
    per case with `expect(...)` assertions.

- Repo conventions:
  - Runtime is **Bun**; tests run via `bun test` (never `tsc`/`vitest`).
  - Generate throwaway 32-byte keys **inside the test** with Node crypto:
    `import { randomBytes } from "node:crypto";` then `randomBytes(32)`.
    NEVER hardcode, read, or print a real production key value.
  - `encrypt`/`decrypt` take a `Buffer` key directly, so most tests do NOT need
    the env var at all — pass `randomBytes(32)`. Only the `loadEncryptionKey`
    tests touch `process.env.NEXUS_ENCRYPTION_KEY`, and they must restore/delete
    it afterward so they do not leak into sibling tests.

## Commands you will need

| Purpose   | Command                                                          | Expected on success        |
|-----------|-----------------------------------------------------------------|----------------------------|
| Install   | `pnpm install`                                                  | exit 0                     |
| Run test  | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/encryption.test.ts` | all pass, 0 fail          |

Notes on the env for the run:
- `NEXUS_ATTACH_SECRET=test` is set defensively per the repo's test convention;
  this module does not read it, but the agent test harness may.
- Do NOT set `NEXUS_ENCRYPTION_KEY` on the command line — the `loadEncryptionKey`
  tests manage that var themselves inside the test body.

## Scope

**In scope** (the only file you should create/modify):
- `apps/agent/src/credentials/encryption.test.ts` (create)
- `plans/README.md` (status row update only)

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/credentials/encryption.ts` — the module under test. This is a
  characterization test of existing behavior; if a test fails, the test is wrong
  (or the code drifted — a STOP condition), not the source.
- `apps/agent/src/credentials/credential-watcher.test.ts` — read for pattern only.
- Any other `credentials/*` module or `plan 008` work.

## Git workflow

- Branch: `advisor/007-encryption-tests`
- Commit style: conventional commits, e.g. `test(agent): add characterization tests for credential encryption module`
- Do NOT push or open a PR.

## Steps

### Step 1: Create the test file skeleton

Create `apps/agent/src/credentials/encryption.test.ts` with a top-of-file JSDoc
block (mirroring `credential-watcher.test.ts`), the `bun:test` imports, and the
Node crypto import for throwaway keys:

```ts
import { describe, test, expect } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  encrypt,
  decrypt,
  loadEncryptionKey,
  loadPrerotateThreshold,
} from "./encryption";
```

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/encryption.test.ts`
→ runs without a module-resolution error (0 tests is acceptable at this step).

### Step 2: Round-trip tests

Add `describe("encryption round-trip", ...)`. For each representative plaintext,
assert `decrypt(encrypt(x, key), key) === x`. Generate `const key = randomBytes(32)`
once at the top of the describe or per test.

Cases (one `test(...)` each, or a loop):
- short ASCII: `"hunter2"`
- empty string: `""`
- unicode: `"héllo-世界-🔐"`
- long: a 10_000-char string, e.g. `"a".repeat(10_000)`

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/encryption.test.ts`
→ all round-trip tests pass.

### Step 3: Wrong-key rejection

Add a test: encrypt with `keyA = randomBytes(32)`, attempt
`decrypt(ciphertext, keyB)` with a DIFFERENT valid `keyB = randomBytes(32)`.
Assert it **throws** (must not silently return garbage). Use
`expect(() => decrypt(ciphertext, keyB)).toThrow();`.

**Verify**: same test command → the wrong-key test passes.

### Step 4: Tamper rejection (GCM auth failure)

Add a test: encrypt a plaintext, decode the base64 to a Buffer, flip one byte in
the ciphertext region (an index between `NONCE_BYTES=12` and
`buf.length - AUTH_TAG_BYTES`), re-encode to base64, and assert
`decrypt(tampered, key)` **throws**. Add a second variant that flips a byte
inside the last 16 bytes (the auth tag) and assert it also throws.

Byte-flip shape:

```ts
const buf = Buffer.from(encrypt("secret", key), "base64");
buf[13] ^= 0xff;                        // flip a ciphertext byte (index 12..len-16)
const tampered = buf.toString("base64");
expect(() => decrypt(tampered, key)).toThrow();
```

**Verify**: same test command → both tamper tests pass.

### Step 5: Key-loading tests (`loadEncryptionKey`)

These are the ONLY tests that touch `process.env.NEXUS_ENCRYPTION_KEY`. Save and
restore the original value so no state leaks:

```ts
describe("loadEncryptionKey", () => {
  const original = process.env.NEXUS_ENCRYPTION_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.NEXUS_ENCRYPTION_KEY;
    else process.env.NEXUS_ENCRYPTION_KEY = original;
  });
  // ...
});
```

Remember to add `afterEach` to the `bun:test` import.

Cases:
- **hex and base64 load to the same 32-byte buffer**: generate one throwaway
  `const raw = randomBytes(32)`. Set `NEXUS_ENCRYPTION_KEY` to `raw.toString("hex")`
  (64 chars), call `loadEncryptionKey()`, assert `.length === 32` and
  `.equals(raw)`. Then set it to `raw.toString("base64")` (44 chars), call again,
  assert the returned buffer `.equals()` the hex-loaded buffer. This proves both
  encodings decode to the identical key.
- **invalid-length key is rejected**: set `NEXUS_ENCRYPTION_KEY` to a too-short
  string (e.g. `"deadbeef"`, length 8) and assert `loadEncryptionKey()` **throws**.
- **absent var is rejected**: `delete process.env.NEXUS_ENCRYPTION_KEY` and assert
  it throws.

Never print the key value in a test message; assert on `.length`/`.equals` only.

**Verify**: same test command → all `loadEncryptionKey` tests pass.

### Step 6: `loadPrerotateThreshold` tests

Same save/restore pattern for `process.env.NEXUS_PREROTATE_THRESHOLD`. Cases:
- default: with the var unset, assert `loadPrerotateThreshold() === 0.85`.
- valid override: set to `"0.5"`, assert returns `0.5`.
- invalid — out of range: set to `"1.5"`, assert **throws**.
- invalid — non-numeric: set to `"abc"`, assert **throws**.

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/encryption.test.ts`
→ ALL tests pass, 0 fail.

### Step 7: Commit

```
git checkout -b advisor/007-encryption-tests
git add apps/agent/src/credentials/encryption.test.ts plans/README.md
git commit -m "test(agent): add characterization tests for credential encryption module"
```

Do NOT push or open a PR.

## Test plan

New tests in `apps/agent/src/credentials/encryption.test.ts`, modeled
structurally on `apps/agent/src/credentials/credential-watcher.test.ts`
(`bun:test`, `describe`/`test`/`expect`). Coverage:
- Round-trip: short / empty / unicode / long plaintexts (step 2).
- Wrong-key rejection throws (step 3).
- Tamper rejection: flipped ciphertext byte AND flipped auth-tag byte throw (step 4).
- `loadEncryptionKey`: hex and base64 decode to the same 32-byte key; invalid
  length rejected; absent var rejected (step 5).
- `loadPrerotateThreshold`: default 0.85, valid override, out-of-range throw,
  non-numeric throw (step 6).

Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/encryption.test.ts`
→ all pass, 0 fail.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `apps/agent/src/credentials/encryption.test.ts` exists.
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/credentials/encryption.test.ts` exits 0, all tests pass, 0 fail.
- [ ] No files outside the in-scope list are modified (`git status` shows only
      `encryption.test.ts` and `plans/README.md`).
- [ ] `apps/agent/src/credentials/encryption.ts` is unchanged (`git diff --stat -- apps/agent/src/credentials/encryption.ts` is empty).
- [ ] No secret/key values are hardcoded or printed anywhere in the test file
      (all keys come from `randomBytes(32)`).
- [ ] `plans/README.md` status row for 007 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code in `encryption.ts` doesn't match the "Current state" excerpts (the
  function signatures, env var names, or storage format drifted since this plan
  was written).
- A round-trip or auth-failure test fails against the CURRENT source — that means
  the crypto boundary is already broken; report it rather than "fixing" the test
  to pass.
- A step's verification fails twice after a reasonable fix attempt.
- Making a test pass appears to require editing `encryption.ts` (out of scope —
  this is characterization of existing behavior only).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Plan 008 (`add-elevenlabs-credential`) reuses these helpers; if it changes the
  storage format or key parsing, these characterization tests will fail and MUST
  be updated deliberately alongside that change.
- A reviewer should scrutinize that: (a) no key value is hardcoded (all via
  `randomBytes(32)`), (b) the `loadEncryptionKey`/`loadPrerotateThreshold` tests
  restore the env vars they mutate, and (c) the tamper test flips a byte in the
  correct region (ciphertext vs auth-tag) so it genuinely exercises GCM auth.
- Deferred out of this plan: no test for `randomBytes` nonce uniqueness across
  calls and no fuzzing — the four representative plaintexts are sufficient for a
  characterization baseline.
