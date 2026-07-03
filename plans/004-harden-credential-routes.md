# Plan 004: Guard the decrypted-credential lease route, de-trust audit attribution, and fix the stale WS-auth comment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/agent/src/routes/credentials apps/agent/src/server-auth.ts apps/agent/src/server-websocket.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

The `POST /credentials/lease` route returns a **decrypted** credential (a Claude
OAuth token or API key — decrypted in the pool before it leaves the process),
yet it is the *only* mutating credential route with **no TLS/loopback gate**.
The far-less-sensitive `POST /credentials` (add) route *does* gate. So the most
dangerous route is the least guarded: any client that can reach `:7400` (every
Tailscale peer + loopback) can POST a lease and receive a plaintext token,
fully bypassing encryption-at-rest. Separately, the audit trail records
*who* leased/deleted a credential from **client-spoofable** headers/body fields,
so attribution is attacker-controlled; and a comment in `server-auth.ts` still
claims WebSocket auth "uses a token ... that surface is untouched" when the
`?token=` gate was in fact removed — misleading the next security reviewer.

**Decided tradeoff (do not over-reach):** Nexus deliberately uses Tailscale
network ACLs as its primary trust boundary, **not** per-request tokens (see
`.claude/CLAUDE.md`). This plan does **NOT** add general request auth. It only
(A) closes the asymmetry where the decrypted-token route is less guarded than
the add route, (B) stops the audit log from presenting spoofable values as
trustworthy, and (C) corrects one stale security comment.

## Current state

Files in play (all under `apps/agent/src/`):

- `routes/credentials/handlers-lease.ts` — `POST /credentials/lease`; returns the decrypted value; **no TLS gate**.
- `routes/credentials/handlers-crud.ts` — add/list/delete; the add path **has** the TLS gate to copy.
- `routes/credentials/shared.ts` — `checkTlsEnforcement`, `extractCallerIp`, `emitAudit`, and the `CredentialAuditEntry` type.
- `routes/credentials/handlers-promote.ts`, `handlers-swap.ts`, `handlers-health-usage.ts` — other `emitAudit` call sites that share the same `CredentialAuditEntry` type (renaming its fields forces these to update — TypeScript enforces it).
- `server-auth.ts` — stale WS-auth comment.
- `server-websocket.ts` — proof the WS `?token=` gate is gone (read-only reference; do NOT edit).

### (A) The lease route returns a decrypted token with no gate

`handlers-lease.ts:54-56` — the leased row's `valueEncrypted` field is **already
decrypted** by the pool (see `credentials/pool/pool-core.ts:409-416`,
`decrypt(result.valueEncrypted, key)`), and is returned to the caller verbatim:

```ts
  // Strip encrypted storage column — caller receives decrypted value via valueEncrypted
  const { valueEncrypted: _e, ...safe } = credential;
  return jsonResponse({ ...safe, value: credential.valueEncrypted });
```

The add path gates itself right after the pool-null guard — `handlers-crud.ts:32-34`:

```ts
  // TLS enforcement: reject non-loopback HTTP requests with 426
  const tlsErr = checkTlsEnforcement(request);
  if (tlsErr) return tlsErr;
```

`checkTlsEnforcement` (in `shared.ts:88-103`) returns a `426` Response for
`http://` requests from non-loopback hosts, and `null` (pass) for loopback
(`127.0.0.1`, `::1`, `localhost`) or `https://`. The lease handler
(`handlers-lease.ts:16-20`) currently has **only** the pool-null guard, no TLS
check:

```ts
export async function handleLeaseCredential(request: Request): Promise<Response> {
  const pool = poolRef.current;
  if (!pool) {
    return jsonResponse({ error: "credential system not initialized" }, 500);
  }
  // ... straight to request.json(), no checkTlsEnforcement
```

**Caller inventory (verified at plan time):** no in-repo production client
(TS/Swift/shell) calls `POST /credentials/lease` — the only callers are the
tests in `routes/credentials.test.ts`, which all use
`http://127.0.0.1:7400/credentials/lease` (loopback → exempt). So adding the
gate does not break any known caller. See STOP conditions for the
undocumented-remote-caller case.

### (B) Audit attribution comes from client-spoofable inputs

`shared.ts:33-45` — `extractCallerIp` trusts the `x-forwarded-for` header first
(client-spoofable), falling back to the URL host:

```ts
export function extractCallerIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  // ... URL hostname fallback
```

`handlers-crud.ts:225-229` — the delete actor is read from client headers:

```ts
  const ip = extractCallerIp(request);
  const actor =
    request.headers.get("x-nexus-actor") ??
    request.headers.get("x-forwarded-user") ??
    "system";
```

`handlers-lease.ts:45-52` — lease audit actor is the caller-supplied `leased_by`
body field:

```ts
  emitAudit({
    event: "credential.leased",
    credential_id: credential.id,
    actor: leased_by as string,
    ip,
    timestamp_iso: new Date().toISOString(),
    detail: { type: credential.type },
  });
```

The shared type — `shared.ts:20-31`:

```ts
export type CredentialAuditEntry = {
  event: string;
  credential_id: string;
  actor: string;
  ip: string;
  timestamp_iso: string;
  detail?: Record<string, unknown>;
};

export function emitAudit(entry: CredentialAuditEntry): void {
  auditLogger.info(entry, entry.event);
}
```

`emitAudit` only reads `entry.event` (as the log message); every other field is
a structured log key. No code in or out of the repo parses `actor`/`ip` by name
(`grep -rn "credential.leased\|audit.credential"` outside `apps/agent/src` +
docs/beads returns nothing), so renaming the keys is log-cosmetic and safe.

**Decision for this plan (uniform rename, defended):** the handlers do **not**
receive Bun's `server` object (the dispatcher `tryHandleCredentialRoute(request,
url)` in `server-routes-credentials.ts` is called without it), so the real
WireGuard socket peer (`server.requestIP(request)`) is **not** reachable here
without threading `server` through `server-request-handler.ts` +
`server-routes-credentials.ts` — both **out of scope** (see Maintenance notes
for that deferred stronger option). The in-scope, honest fix is to rename the
two spoofable audit fields to a `claimed_` provenance prefix — `actor` →
`claimed_actor`, `ip` → `claimed_ip` — so the audit schema stops presenting
caller-asserted values as verified identity. The prefix is uniformly correct:
`extractCallerIp` is *always* header/URL-derived (never verified), and every
`actor` value is a claim the handler records without an auth layer to check it
(by the decided Tailscale-ACL tradeoff). Uniform rename = one type change +
mechanical key renames at every call site, fully TypeScript-verified.

### (C) Stale WebSocket-auth comment

`server-auth.ts:12-13`:

```ts
 * WebSocket auth still uses a token (header or query-string) and lives in
 * `server-websocket.ts` — that surface is untouched by the HTTP-gate removal.
```

This is false. `server-websocket.ts:10-13` documents the gate was removed, and
the upgrade path (`server-websocket.ts:219-254`, `handleWsUpgrade`) does only a
`SESSION_ID_RE` format check + a `MAX_CONCURRENT_CONNECTIONS` cap — **no token**:

```ts
    if (!SESSION_ID_RE.test(sessionId)) {
      return new Response("Bad Request", { status: 400 });
    }
    if (state.allSockets.size >= MAX_CONCURRENT_CONNECTIONS) {
      return new Response("Too Many Requests", { status: 429 });
    }
```

### Conventions to match

- **Runtime**: Bun. Never `tsc` for execution.
- **Route handler shape**: pool-null guard first, then `checkTlsEnforcement`,
  then body parse — exactly as `handleAddCredential` (`handlers-crud.ts:26-56`).
- **Commits**: Conventional Commits. Use `security(agent): ...` for the gate/
  audit changes and `fix(agent): ...` (or `docs(agent): ...`) for the comment.
  Example from `git log`: `feat(notifications): add telegram channel ...`.
- **Handling secrets**: never write a credential *value* anywhere — reference
  the credential *type* (Claude OAuth token / API key) and `file:line` only.

## Commands you will need

| Purpose   | Command | Expected on success |
|-----------|---------|---------------------|
| Install   | `pnpm install` | exit 0 |
| Typecheck | `pnpm typecheck` | exit 0, no errors |
| Lint      | `pnpm lint` | exit 0 |
| Agent unit tests (crud) | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials/handlers-crud.test.ts` | all pass |
| Agent unit tests (audit) | `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts` | all pass |

Notes:
- `pnpm typecheck` / `pnpm lint` run via turbo from the repo root.
- `NEXUS_ATTACH_SECRET=test` is set defensively per the repo's test-env
  convention; the tests here do not exercise a secret gate, but keep it for
  parity with the rest of the agent suite.
- `bun test <path>` matches by file path substring — run from `apps/agent`.

## Scope

**In scope** (the only files you should modify):
- `apps/agent/src/routes/credentials/handlers-lease.ts` — add the TLS gate; rename audit keys.
- `apps/agent/src/routes/credentials/shared.ts` — rename `CredentialAuditEntry` fields; update the doc comment on `extractCallerIp`.
- `apps/agent/src/routes/credentials/handlers-crud.ts` — rename audit keys at the delete call site.
- `apps/agent/src/routes/credentials/handlers-promote.ts` — rename audit keys (3 `emitAudit` sites).
- `apps/agent/src/routes/credentials/handlers-swap.ts` — rename audit keys (2 `emitAudit` sites).
- `apps/agent/src/routes/credentials/handlers-health-usage.ts` — rename audit keys (1 `emitAudit` site).
- `apps/agent/src/server-auth.ts` — correct the WS-auth comment.
- `apps/agent/src/routes/credentials/handlers-crud.test.ts` — add the lease TLS-gate test (see Test plan).
- `apps/agent/src/routes/credentials.test.ts` — add/adjust the audit-provenance assertion (see Test plan).

**Out of scope** (do NOT touch, even though they look related):
- `apps/agent/src/server-websocket.ts` — the WS gate removal is an intentional,
  already-shipped maintainer decision; this plan only *documents* it, does not
  restore a token.
- `apps/agent/src/server-request-handler.ts` and
  `apps/agent/src/server-routes-credentials.ts` — threading the real socket peer
  IP (`server.requestIP`) through the dispatcher is a separate, larger change
  (see Maintenance notes). Do NOT rewire the dispatcher here.
- `apps/agent/src/credentials/pool/pool-core.ts` — the decrypt-on-lease behavior
  is by design; do not change what the pool returns.
- Do NOT add any per-request token / secret header gate — that contradicts the
  decided Tailscale-ACL trust model.

## Git workflow

- Branch: `advisor/004-harden-credential-routes`
- Commit per logical unit (gate / audit-rename / comment); Conventional Commits,
  e.g. `security(agent): gate the credential-lease route behind TLS/loopback`.
- Do NOT push or open a PR.

## Steps

### Step 1: Gate the lease route with `checkTlsEnforcement` (sub-fix A)

In `apps/agent/src/routes/credentials/handlers-lease.ts`:

1. Add `checkTlsEnforcement` to the import from `./shared` (currently imports
   `emitAudit, extractCallerIp, jsonResponse, poolRef` — lines 8-13). Result:

   ```ts
   import {
     checkTlsEnforcement,
     emitAudit,
     extractCallerIp,
     jsonResponse,
     poolRef,
   } from "./shared";
   ```

2. Immediately after the pool-null guard (after line 20, before the
   `request.json()` block), insert the same gate the add handler uses:

   ```ts
     // TLS enforcement: the lease response returns a DECRYPTED credential
     // (Claude OAuth token / API key). Gate it at least as strictly as the
     // add route — reject non-loopback HTTP with 426. Loopback + TLS pass.
     const tlsErr = checkTlsEnforcement(request);
     if (tlsErr) return tlsErr;
   ```

Match the ordering in `handlers-crud.ts:27-34` exactly (pool guard → TLS gate →
body parse).

**Verify**: `pnpm typecheck` → exit 0, no errors.

### Step 2: Rename the audit provenance fields in the shared type (sub-fix B)

In `apps/agent/src/routes/credentials/shared.ts`:

1. In `CredentialAuditEntry` (lines 20-27), rename `actor: string;` →
   `claimed_actor: string;` and `ip: string;` → `claimed_ip: string;`. Add a
   one-line comment above the two fields:

   ```ts
   /** Structured audit log entry for credential operations. */
   export type CredentialAuditEntry = {
     event: string;
     credential_id: string;
     // `claimed_*` = caller-asserted, NOT verified. Nexus has no per-request
     // auth (Tailscale ACL is the trust boundary), so actor/IP here are
     // spoofable via body/headers and must not be read as proven identity.
     claimed_actor: string;
     claimed_ip: string;
     timestamp_iso: string;
     detail?: Record<string, unknown>;
   };
   ```

2. Update the doc comment on `extractCallerIp` (lines 33-34) to note the value
   is caller-claimed (the `x-forwarded-for` header is client-spoofable), e.g.
   change `/** Extract caller IP from request headers or socket. */` to:

   ```ts
   /**
    * Extract the caller-CLAIMED IP from request headers (x-forwarded-for) or
    * the URL host. This is NOT a verified socket peer — treat as untrusted
    * (audit entries store it as `claimed_ip`).
    */
   ```

`pnpm typecheck` will now fail at every `emitAudit({...})` call site until
Step 3 — that is expected.

**Verify**: `grep -n "claimed_actor\|claimed_ip" apps/agent/src/routes/credentials/shared.ts` → shows the renamed fields.

### Step 3: Update every `emitAudit` call site to the new keys (sub-fix B)

Rename the object keys `actor:` → `claimed_actor:` and `ip:` → `claimed_ip:` at
**every** `emitAudit({...})` call (values unchanged). The complete list
(TypeScript will flag any you miss):

- `handlers-lease.ts` — 1 call (currently `actor: leased_by as string, ip,` at lines 48-49). After Step 2's import change is already done here.
- `handlers-crud.ts` — 1 call, delete handler (`actor,\n    ip,` at lines 254-255).
- `handlers-promote.ts` — 3 calls (`emitAudit` at ~lines 63, 113, 122; each has `actor` + `ip`).
- `handlers-swap.ts` — 2 calls (`emitAudit` at ~lines 66, 75; each has `actor` + `ip`).
- `handlers-health-usage.ts` — 1 call (`emitAudit` at ~line 59; has `actor` + `ip`).

Because `ip` is passed as a shorthand property (`ip,`) in several sites, you must
change it to `claimed_ip: ip,` (the local variable stays named `ip`). Likewise
`actor,` shorthand becomes `claimed_actor: actor,`. Where the value is inline
(e.g. `actor: leased_by as string`) just rename the key:
`claimed_actor: leased_by as string`.

**Verify**:
- `grep -rn "actor:\|actor,\| ip,\|ip:" apps/agent/src/routes/credentials --include=*.ts | grep -v claimed | grep emitAudit` returns nothing in `emitAudit` blocks (spot-check the surrounding lines).
- `pnpm typecheck` → exit 0, no errors.

### Step 4: Correct the stale WebSocket-auth comment (sub-fix C)

In `apps/agent/src/server-auth.ts`, replace lines 12-13:

```ts
 * WebSocket auth still uses a token (header or query-string) and lives in
 * `server-websocket.ts` — that surface is untouched by the HTTP-gate removal.
```

with:

```ts
 * The WebSocket `?token=` / header gate was ALSO removed (by
 * `drop-attach-secret-gate`); `server-websocket.ts` now only format-checks the
 * session id and caps concurrent connections. WS reachability, like the HTTP
 * routes, rests entirely on the network bind layer (loopback + Tailscale).
 * Restoring a WS token is a separate maintainer decision, not implied here.
```

**Verify**: `pnpm typecheck` → exit 0 (comment-only; must not change behavior).

### Step 5: Add tests (see Test plan)

Then run the full gate sequence.

**Verify**: `pnpm typecheck && pnpm lint` → both exit 0, and both bun test
suites pass (Test plan).

## Test plan

Two new/adjusted tests, mirroring existing structure.

1. **Lease TLS-gate rejection** — add to
   `apps/agent/src/routes/credentials/handlers-crud.test.ts` (this suite already
   drives handlers directly with a stubbed `poolRef.current`; model the new test
   after its `installFakePool` pattern, or install a minimal pool exposing
   `lease`). Assert:
   - A non-loopback **http** lease request is rejected `426`, exactly as the add
     handler would be: build `new Request("http://10.0.0.5:7400/credentials/lease", { method: "POST", headers: {"Content-Type":"application/json"}, body: JSON.stringify({ type: "anthropic", leased_by: "attacker" }) })`, call `handleLeaseCredential(req)`, expect `res.status === 426`. Import `handleLeaseCredential` from `./handlers-lease`.
   - (Optional companion) a loopback `http://127.0.0.1:7400/credentials/lease`
     request is **not** `426` (the gate passes; it may 500/409 from the fake
     pool — assert `res.status !== 426`).

2. **Audit provenance key** — in
   `apps/agent/src/routes/credentials.test.ts` (the audit-trail suite), assert
   the emitted audit entry uses the untrusted-provenance key and carries the
   caller-supplied actor as `claimed_actor` (not a verified field). Use
   `spyOn` on the audit path or the pattern already in that file; the load-
   bearing assertion is that a **forged** `x-nexus-actor` / `leased_by` shows up
   under `claimed_actor` / `claimed_ip`, documenting it as claimed rather than
   trusted. If the existing suite asserts on `actor`/`ip` keys anywhere, update
   those references to `claimed_actor`/`claimed_ip`.

Structural pattern to copy: `handlers-crud.test.ts` (fake-pool install +
`new Request(...)` + `handle*(req)` + `res.status`/`res.json()` assertions).

**Verification**:
- `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials/handlers-crud.test.ts` → all pass, including the new 426 test.
- `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts` → all pass, including the provenance assertion.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials/handlers-crud.test.ts` passes, with the new lease-426 test present
- [ ] `cd apps/agent && NEXUS_ATTACH_SECRET=test bun test src/routes/credentials.test.ts` passes, with the `claimed_actor`/`claimed_ip` assertion present
- [ ] `grep -n "checkTlsEnforcement" apps/agent/src/routes/credentials/handlers-lease.ts` shows the gate is imported and called
- [ ] `grep -rn "\bactor:\|\bip:" apps/agent/src/routes/credentials/shared.ts` returns nothing (fields are now `claimed_actor`/`claimed_ip`)
- [ ] `grep -n "?token=" apps/agent/src/server-auth.ts` — the corrected comment no longer claims the WS token gate is active
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at the locations in "Current state" doesn't match the excerpts (the
  codebase has drifted since `64a206ff`).
- You discover an **in-repo or documented remote client** that leases
  credentials over plain `http://` from a non-loopback host — the TLS gate would
  break it. Do NOT weaken the gate; report the caller and let the maintainer
  decide (mTLS, a loopback-only bind for that caller, or an explicit exemption).
  At plan time the only lease callers were loopback tests, so this is not
  expected — but verify before shipping.
- Adding the gate to the lease handler causes an existing lease test to fail for
  a reason other than a missing/updated assertion (i.e. a loopback request is
  wrongly rejected `426`) — that would mean `checkTlsEnforcement`'s loopback
  detection regressed; investigate before proceeding.
- A verification command fails twice after a reasonable fix attempt.
- The fix appears to require touching an out-of-scope file (e.g. you conclude
  you must thread `server.requestIP` through the dispatcher to satisfy sub-fix
  B — it is explicitly deferred; the `claimed_*` rename is the in-scope answer).

## Maintenance notes

For whoever owns this code next:

- **Deferred stronger sub-fix B (real socket peer).** The honest fix here renames
  the spoofable audit fields to `claimed_*`. A stronger version records the
  WireGuard-verified socket peer instead. That requires threading Bun's
  `server.requestIP(request)` from the fetch handler
  (`server-request-handler.ts:207-210`, where `server` is in scope) through
  `tryHandleCredentialRoute` (`server-routes-credentials.ts:31`, which currently
  takes only `(request, url)`) into the handlers, then storing it as a separate
  verified field alongside `claimed_ip`. That is a multi-file dispatcher change,
  intentionally out of scope for this plan. File it as a follow-up if verified
  attribution is wanted.
- **Credential rotation.** If `:7400` was ever reachable without a Tailscale ACL
  in front of it (i.e. exposed to an untrusted network before this gate landed),
  any Claude OAuth token / API key in the pool may have been leased in
  plaintext. Recommend rotating the credential pool keys as a precaution — the
  gate prevents future leakage, not past.
- **WS token, deliberately not restored.** Sub-fix C only corrects the comment.
  If a maintainer later wants a WebSocket auth gate back, that is a separate
  decision — do not infer it from this plan.
- **Reviewer focus.** Confirm (1) the lease 426 test actually fails without the
  Step 1 gate (RED before GREEN), (2) no `emitAudit` call site still uses the
  old `actor`/`ip` keys, and (3) the `server-auth.ts` comment matches the actual
  `server-websocket.ts` behavior.
