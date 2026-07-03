# Plan 003: Stop logging verbatim terminal keystrokes/pastes at INFO on the takeover path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 64a206ff..HEAD -- apps/agent/src/terminal/tmux-pty-source.ts`
> If `apps/agent/src/terminal/tmux-pty-source.ts` changed since this plan was
> written, compare the "Current state" excerpts against the live code before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

When a user takes over an attached terminal, every keystroke and paste written
to the tmux pane is currently logged **verbatim at INFO level** by a diagnostic
added under tag `NXPTY-DIAG (mx-rkir.13)`. Because anything typed into a
taken-over shell flows through this path — including credentials pasted or typed
at a prompt — those values are written in cleartext into the agent's structured
logs and any downstream log shipper / OTel sink (`packages/core/src/logger.ts`
forwards to an OTLP receiver when `OTEL_EXPORTER_OTLP_ENDPOINT` is set). Logs
outlive the session, so this is a persistent secret-disclosure exposure to
anyone who can read them. This is a defensive-maintenance fix: drop the
content-bearing log fields while keeping the byte-count so the diagnostic
("did a keystroke reach the pane?") still works.

## Current state

- `apps/agent/src/terminal/tmux-pty-source.ts` — the tmux PTY source. Its
  `write(data: Uint8Array)` method (lines 491–521) decodes the incoming bytes to
  `text`, spawns `tmux send-keys -l <text>` to inject them into the pane, and
  logs twice at INFO. The two logs are the exposure.
- The `logger` used here is the shared singleton imported at
  `apps/agent/src/terminal/tmux-pty-source.ts:37`:
  `import { logger } from "@nexus/core/node";` (constructed in
  `packages/core/src/logger.ts:101`).
- Input reaches `write()` from the interact/takeover socket path — remote client
  input is forwarded into the pane, so the logged `text` is attacker/operator
  free-text, not a fixed control string.

The exact code as it exists today (`apps/agent/src/terminal/tmux-pty-source.ts:491-521`):

```ts
  write(data: Uint8Array): void {
    if (this.closed) return;
    const text = new TextDecoder().decode(data);
    if (text.length === 0) return;
    const argv = ["tmux", "send-keys", "-t", this.target, "-l", text];
    try {
      const proc = this.spawn.spawn(argv, {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      // NXPTY-DIAG (mx-rkir.13): log the exact send-keys argv + exit code so we
      // can confirm a received keystroke actually reaches the tmux pane. JSON-
      // stringify the literal text so control bytes (0x0d / 0x0c) are visible.
      logger.info(
        { target: this.target, bytes: data.length, literal: JSON.stringify(text) },
        "NXPTY tmux send-keys spawned",
      );
      void proc.exited.then((code) => {
        logger.info(
          { target: this.target, exitCode: code, argv: argv.map((a) => JSON.stringify(a)) },
          "NXPTY tmux send-keys exited",
        );
      });
    } catch (err) {
      logger.debug(
        { target: this.target, error: err instanceof Error ? err.message : String(err) },
        "tmux send-keys threw",
      );
    }
  }
```

Two content-bearing fields must be removed:
1. `literal: JSON.stringify(text)` in the `"NXPTY tmux send-keys spawned"` log —
   the verbatim keystroke/paste text.
2. `argv: argv.map((a) => JSON.stringify(a))` in the `"NXPTY tmux send-keys exited"`
   log — `argv` contains `["...", "-l", text]`, i.e. the same verbatim text.

Fields to KEEP: `target`, `bytes` (byte-count preserves the diagnostic), and
`exitCode`. The `argv` local is still needed for the `spawn()` call — only the
`argv` **log field** is removed.

**Test convention.** Tests for this file live in
`apps/agent/src/terminal/tmux-pty-source.test.ts` and use `bun:test`
(`import { describe, expect, it } from "bun:test";`). The suite builds a
recording mock spawn adapter (`makeRecorder()`) whose fake subprocess returns
`exited: Promise.resolve(0)`, and constructs the source as
`new TmuxPtySource(TARGET, { spawn: rec.adapter })`. There is already a `write()`
test group tagged `[1.3]` (e.g. "write() of empty bytes emits no send-keys",
`apps/agent/src/terminal/tmux-pty-source.test.ts:161`). Model the new test after
those. `spyOn` is available from `bun:test` and used throughout the repo
(e.g. `apps/agent/src/routes/credentials.test.ts:318`); use it to spy on
`logger.info`. Import the same singleton the source uses:
`import { logger } from "@nexus/core/node";`.

## Commands you will need

| Purpose   | Command                                                        | Expected on success   |
|-----------|---------------------------------------------------------------|-----------------------|
| Install   | `pnpm install`                                                | exit 0                |
| Typecheck | `pnpm typecheck`                                              | exit 0, no errors     |
| Lint      | `pnpm lint`                                                   | exit 0                |
| Tests     | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test tmux-pty-source` | all pass        |

Note: the agent test suite requires `NEXUS_ATTACH_SECRET=test` in the
environment (per project memory). Run the test command from `apps/agent`.

## Scope

**In scope** (the only files you should modify):
- `apps/agent/src/terminal/tmux-pty-source.ts`
- `apps/agent/src/terminal/tmux-pty-source.test.ts`
- `plans/README.md` (status row only)

**Out of scope** (do NOT touch, even though they look related):
- `packages/core/src/logger.ts` — the logger is fine; the fix is at the call
  site, not in logging infrastructure.
- The `argv` construction / `spawn()` call itself — `tmux send-keys -l <text>`
  must still be spawned with the real text; only the *log fields* change.
- Any other `logger.info`/`logger.debug` call in `tmux-pty-source.ts` — leave
  the geometry / pipe-pane / read-loop diagnostics untouched.
- The interact/socket-server forwarding path — the fix belongs at the single
  shared sink (`write()`), not in every caller.

## Git workflow

- Branch: `advisor/003-redact-keystroke-logging` (create from current HEAD if it
  does not exist: `git checkout -b advisor/003-redact-keystroke-logging`).
- One commit for the change. Message style: conventional commits — this repo
  uses `feat(scope): ...` / `fix(scope): ...` (e.g. `d445b33b feat(iopen): ...`,
  `4ed023d2 fix(ios-presence-reporter): ...`). Use a security-framed subject:
  `fix(agent): stop logging verbatim terminal keystrokes on takeover path`.
- Stage only the in-scope files by explicit path (`git add apps/agent/src/terminal/tmux-pty-source.ts apps/agent/src/terminal/tmux-pty-source.test.ts plans/README.md`).
  NEVER `git add .` / `-A`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Remove the two content-bearing log fields

In `apps/agent/src/terminal/tmux-pty-source.ts`, edit the `write()` method:

1. In the `"NXPTY tmux send-keys spawned"` log, delete the `literal` field.
   The object becomes `{ target: this.target, bytes: data.length }`.
2. In the `"NXPTY tmux send-keys exited"` log, delete the `argv` field.
   The object becomes `{ target: this.target, exitCode: code }`.
3. Update the `NXPTY-DIAG (mx-rkir.13)` comment so it no longer claims to log
   "the exact send-keys argv" / "the literal text" — reword to reflect that only
   `target` + `bytes` + `exitCode` are logged (the byte-count confirms a
   keystroke reached the pane without disclosing its content). Do not change the
   comment's `mx-rkir.13` tag.

Target shape:

```ts
      // NXPTY-DIAG (mx-rkir.13): log target + byte-count + exit code so we can
      // confirm a received keystroke actually reaches the tmux pane. The literal
      // text is intentionally NOT logged — it can contain pasted secrets.
      logger.info(
        { target: this.target, bytes: data.length },
        "NXPTY tmux send-keys spawned",
      );
      void proc.exited.then((code) => {
        logger.info(
          { target: this.target, exitCode: code },
          "NXPTY tmux send-keys exited",
        );
      });
```

Leave the `const argv = [...]` line and the `this.spawn.spawn(argv, ...)` call
unchanged — `argv` is still passed to `spawn()`.

**Verify**:
- `grep -n "literal:" apps/agent/src/terminal/tmux-pty-source.ts` → no output.
- `grep -n "argv: argv" apps/agent/src/terminal/tmux-pty-source.ts` → no output.
- `grep -n "argv.map" apps/agent/src/terminal/tmux-pty-source.ts` → no output.
- `pnpm typecheck` → exit 0 (confirms `argv` is still used for the spawn and no
  unused-variable error was introduced).

### Step 2: Add a regression test asserting no content field is logged

In `apps/agent/src/terminal/tmux-pty-source.test.ts`:

1. Add `spyOn` to the `bun:test` import and add
   `import { logger } from "@nexus/core/node";` at the top (match existing import
   style in the file).
2. Add a test in the `[1.3]` `write()` group. Spy on `logger.info`, call
   `source.write(new TextEncoder().encode("some-typed-text"))`, then assert the
   "spawned" log call recorded `target` and `bytes` but **no** `literal` key. Do
   NOT put any real-looking secret in the test string — use a plain marker like
   `"some-typed-text"`. Restore the spy after (`.mockRestore()`), and `source.close()`.

Target shape (adapt names to the file's existing helpers):

```ts
  it("[1.3] write() does not log the literal keystroke text", () => {
    const rec = makeRecorder();
    const source = new TmuxPtySource(TARGET, { spawn: rec.adapter });
    const infoSpy = spyOn(logger, "info");

    source.write(new TextEncoder().encode("some-typed-text"));

    const spawnedCall = infoSpy.mock.calls.find(
      (c) => c[1] === "NXPTY tmux send-keys spawned",
    );
    expect(spawnedCall).toBeDefined();
    const fields = spawnedCall![0] as Record<string, unknown>;
    expect(fields).toHaveProperty("target");
    expect(fields).toHaveProperty("bytes");
    expect(fields).not.toHaveProperty("literal");
    // Belt-and-suspenders: the raw text must not appear in any logged field.
    expect(JSON.stringify(fields)).not.toContain("some-typed-text");

    infoSpy.mockRestore();
    source.close();
  });
```

If the mock's `write()` path or logger singleton makes a `spyOn(logger, "info")`
assertion infeasible (e.g. the spy records nothing), do NOT force it — fall back
to the grep-based Done criteria below and note in your report that the automated
assertion was not added and why.

**Verify**: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test tmux-pty-source`
→ all pass, including the new test.

## Test plan

- New test in `apps/agent/src/terminal/tmux-pty-source.test.ts`, `[1.3]` group:
  asserts `write()` logs the `"NXPTY tmux send-keys spawned"` record with
  `target` + `bytes` present and `literal` absent, and that the raw typed text
  does not appear anywhere in the logged fields.
- Structural pattern: model after the existing `[1.3]` `write()` tests
  (`apps/agent/src/terminal/tmux-pty-source.test.ts:161-181`) and the repo's
  `spyOn` usage (`apps/agent/src/routes/credentials.test.ts:318`).
- The async `"exited"` log's `argv` removal is covered by the grep Done-criteria
  check rather than a timing-sensitive async assertion.
- Verification: `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test tmux-pty-source`
  → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "literal:" apps/agent/src/terminal/tmux-pty-source.ts` returns no matches
- [ ] `grep -n "argv: argv\|argv.map" apps/agent/src/terminal/tmux-pty-source.ts` returns no matches
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test tmux-pty-source` exits 0; the new `[1.3]` test exists and passes (or, if the spy assertion was infeasible, the two greps above still pass and this is noted in the report)
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The `write()` method in `apps/agent/src/terminal/tmux-pty-source.ts` does not
  match the "Current state" excerpt (the codebase drifted since `64a206ff`) —
  in particular if the `literal` / `argv` log fields are already gone or the log
  messages were renamed.
- Removing the `argv` log field triggers an unused-variable lint/type error on
  `argv` — this would mean the `spawn()` call was also changed; investigate
  rather than deleting the `argv` local.
- `pnpm typecheck` or `pnpm lint` fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (e.g. the interact
  socket path or `packages/core/src/logger.ts`).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- Any future re-introduction of keystroke content into these logs (for
  debugging) MUST be gated behind an explicit, off-by-default debug flag AND
  redacted — never logged verbatim at INFO. The default remains: byte-count only.
- A reviewer should confirm no *other* log site on the input/takeover path logs
  decoded pane input. This plan fixes the single shared sink (`write()`); if new
  callers add their own logging of the same `text`, the exposure returns.
- The byte-count (`bytes`) is deliberately retained so the "did a keystroke
  reach the pane" diagnostic still functions without content disclosure.
