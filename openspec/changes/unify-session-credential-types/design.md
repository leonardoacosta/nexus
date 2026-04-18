# Design: unify-session-credential-types — Type Drift Audit

> Investigation deliverable for the API phase. Produced by the DB phase agent.
> Sources read: `packages/db/src/schema/sessions.ts`, `packages/db/src/schema/credentials.ts`,
> `packages/db/src/index.ts`, `packages/core/src/types/session.ts`,
> `packages/core/src/types/account.ts`

---

## Session

### DB shape (`packages/db/src/schema/sessions.ts` → `$inferSelect`)

From `typeof sessions.$inferSelect`, exported from `packages/db/src/index.ts` as `Session`:

| Column (TS name) | Drizzle inferred type |
|---|---|
| `id` | `string` |
| `projectId` | `string \| null` |
| `machine` | `string` |
| `status` | `string` |
| `startedAt` | `Date` |
| `lastActivity` | `Date` |
| `endedAt` | `Date \| null` |
| `pid` | `number \| null` |
| `cwd` | `string \| null` |
| `branch` | `string \| null` |
| `sessionType` | `string \| null` |
| `model` | `string \| null` |
| `rateLimitUtilization` | `number \| null` |
| `totalCostUsd` | `number \| null` |
| `rateLimitResetAt` | `Date \| null` |
| `idleSince` | `Date \| null` |
| `ccSessionId` | `string \| null` |
| `tmuxSession` | `string \| null` |
| `tmuxTarget` | `string \| null` |
| `spec` | `string \| null` |
| `credentialId` | `string \| null` |
| `credentialFingerprint` | `string \| null` |

**Total: 22 columns**

Note: `agentId` is NOT a column. The agent FK is expressed as a soft relation via `machine` (joined to `agents.id`).

### Domain shape (`packages/core/src/types/session.ts`)

| Field | Type |
|---|---|
| `id` | `string` |
| `pid` | `number` |
| `project` | `string \| null` (optional) |
| `projectId` | `string \| null` |
| `machine` | `string \| null` |
| `cwd` | `string` |
| `branch` | `string \| null` |
| `startedAt` | `Date` |
| `lastHeartbeat` | `Date` |
| `endedAt` | `Date \| null` |
| `status` | `SessionStatus` (`"active" \| "idle" \| "ended" \| "stale" \| "errored"`) |
| `spec` | `string \| null` |
| `command` | `string \| null` |
| `agent` | `string \| null` |
| `tmuxSession` | `string \| null` |
| `ccSessionId` | `string \| null` |
| `tmuxTarget` | `string \| null` |
| `rateLimitUtilization` | `number \| null` |
| `rateLimitType` | `string \| null` |
| `totalCostUsd` | `number \| null` |
| `model` | `string \| null` |
| `credentialId` | `string \| null` |
| `credentialFingerprint` | `string \| null` |
| `sessionType` | `SessionType` (`"ad_hoc" \| "managed" \| "pooled"`) |

**Total: 24 fields**

### Key categorisation

#### Shared keys (same name, directly mappable from DB)

These fields exist in both DB and domain with compatible types. The domain type can `Pick` these directly:

| Key | DB type | Domain type | Notes |
|---|---|---|---|
| `id` | `string` | `string` | Exact match |
| `projectId` | `string \| null` | `string \| null` | Exact match |
| `machine` | `string` (NOT NULL) | `string \| null` | DB is non-null; domain widens to nullable — safe, no cast needed |
| `cwd` | `string \| null` | `string` | **Mismatch**: DB nullable; domain non-null. Mapper must guard. |
| `branch` | `string \| null` | `string \| null` | Exact match |
| `startedAt` | `Date` | `Date` | Exact match |
| `endedAt` | `Date \| null` | `Date \| null` | Exact match |
| `pid` | `number \| null` | `number` | **Mismatch**: DB nullable; domain non-null. Mapper must assert or default. |
| `spec` | `string \| null` | `string \| null` | Exact match |
| `tmuxSession` | `string \| null` | `string \| null` | Exact match |
| `ccSessionId` | `string \| null` | `string \| null` | Exact match |
| `tmuxTarget` | `string \| null` | `string \| null` | Exact match |
| `rateLimitUtilization` | `number \| null` | `number \| null` | Exact match |
| `totalCostUsd` | `number \| null` | `number \| null` | Exact match |
| `model` | `string \| null` | `string \| null` | Exact match |
| `credentialId` | `string \| null` | `string \| null` | Exact match |
| `credentialFingerprint` | `string \| null` | `string \| null` | Exact match |

**17 shared keys**

#### DB-only keys (no domain equivalent)

These columns exist in the DB row but are NOT surfaced in the domain `Session` type. They are available for mappers but are intentionally excluded from the public domain shape:

| Key | DB type | Reason absent from domain |
|---|---|---|
| `status` | `string` | Widened to union literal in domain; overlapping but typed differently |
| `sessionType` | `string \| null` | Widened to union literal in domain; overlapping but typed differently |
| `lastActivity` | `Date` | Renamed to `lastHeartbeat` in domain |
| `rateLimitResetAt` | `Date \| null` | Not surfaced in domain `Session`; may be embedded elsewhere |
| `idleSince` | `Date \| null` | Not surfaced in domain `Session` |

Note: `status` and `sessionType` are not truly DB-only — they appear in domain too, but with narrowed union types. They are listed here because the DB column type (`text` / `string`) does not match the domain union literal, so a direct Pick would lose type safety.

#### Domain-only computed keys (must NOT be in Pick)

These fields exist in the domain `Session` but have no direct column in `sessions`:

| Key | Domain type | Source / Derivation |
|---|---|---|
| `lastHeartbeat` | `Date` | Rename of `sessions.lastActivity` — mapper aliases it |
| `project` | `string \| null` (optional) | JOIN result from `projects.name`; not in row |
| `command` | `string \| null` | Not in DB at all — derived from external metadata or session events |
| `agent` | `string \| null` | Not in DB at all — derived from `agents` JOIN or runtime lookup |
| `rateLimitType` | `string \| null` | Not in DB at all — derived from credential or rate-limit event |

### Enum drift risks

| Field | DB column type | TS union literal |
|---|---|---|
| `status` | `text` with `.default("active")` — no CHECK constraint | `"active" \| "idle" \| "ended" \| "stale" \| "errored"` |
| `sessionType` | `text` — no CHECK constraint | `"ad_hoc" \| "managed" \| "pooled"` |

Both columns use unconstrained `text` in Postgres. Any string can be inserted. The mapper today uses `as Session["status"]` and `as Session["sessionType"]` — these are unsafe casts that bypass runtime validation.

**Mitigation required (E2E batch):** A unit test should assert that every member of each TS union has a concrete runtime example, and that an unknown DB string triggers a clear mapper error rather than silently propagating an invalid enum.

### Recommended derivation

```typescript
import type { sessions } from "@nexus/db";

// Step 1: Pick the directly safe columns from the DB row.
// Excludes: status (text → union cast needed), sessionType (text → union cast needed),
//           lastActivity (renamed), rateLimitResetAt/idleSince (not surfaced in domain).
type SessionDbBase = Pick<
  typeof sessions.$inferSelect,
  | "id"
  | "projectId"
  | "machine"
  | "cwd"
  | "branch"
  | "startedAt"
  | "endedAt"
  | "pid"
  | "spec"
  | "tmuxSession"
  | "ccSessionId"
  | "tmuxTarget"
  | "rateLimitUtilization"
  | "totalCostUsd"
  | "model"
  | "credentialId"
  | "credentialFingerprint"
>;

// Step 2: Override the fields whose DB type is wider than the domain wants.
type SessionDbOverrides = {
  // DB: string; domain: union literal — mapper must narrow at runtime
  status: SessionStatus;
  // DB: string | null; domain: union literal — mapper must narrow, fallback to "ad_hoc"
  sessionType: SessionType;
  // DB: string (NOT NULL); domain: string | null — widen is safe but keep explicit
  machine: string | null;
  // DB: string | null; domain: string (non-null) — mapper must provide fallback ""
  cwd: string;
  // DB: number | null; domain: number — mapper must provide fallback (e.g. 0 or -1)
  pid: number;
};

// Step 3: Computed fields that have no DB column.
export type SessionRuntimeFields = {
  /** Alias of sessions.lastActivity. */
  lastHeartbeat: Date;
  /** Human-readable project name from projects JOIN. Absent when no join performed. */
  project?: string | null;
  /** Not stored in DB — derived from external session metadata or events. */
  command: string | null;
  /** Not stored in DB — derived from agents JOIN or runtime config. */
  agent: string | null;
  /** Not stored in DB — derived from credential tier or rate-limit event. */
  rateLimitType: string | null;
};

// Final composed domain type
export type Session = Omit<SessionDbBase, keyof SessionDbOverrides> &
  SessionDbOverrides &
  SessionRuntimeFields;
```

---

## Credentials

### DB shape (`packages/db/src/schema/credentials.ts` → `$inferSelect`)

Exported from `packages/db/src/index.ts` as `Credential`:

| Column (TS name) | Drizzle inferred type |
|---|---|
| `id` | `string` |
| `name` | `string` |
| `type` | `string` |
| `valueEncrypted` | `string \| null` |
| `encryptionKeyId` | `string \| null` |
| `agentId` | `string \| null` |
| `status` | `string` |
| `leasedBy` | `string \| null` |
| `leasedAt` | `Date \| null` |
| `cooldownUntil` | `Date \| null` |
| `rateLimitCount` | `number` |
| `fingerprint` | `string` |
| `duplicateGroupId` | `string \| null` |
| `isPrimary` | `boolean` |
| `subscriptionType` | `string \| null` |
| `rateLimitTier` | `string \| null` |
| `expiresAt` | `Date \| null` |
| `accountEmail` | `string \| null` |
| `accountName` | `string \| null` |
| `accountUuid` | `string \| null` |
| `orgName` | `string \| null` |
| `orgUuid` | `string \| null` |
| `mcpProviders` | `string \| null` |
| `createdAt` | `Date` |
| `updatedAt` | `Date` |

**Total: 25 columns**

### Domain shapes (`packages/core/src/types/account.ts`)

The domain uses three distinct types rather than a single flat credential row. The nearest equivalent to the DB row is `CredentialFile`.

#### `CredentialFile` shape

| Field | Type |
|---|---|
| `id` | `string` |
| `name` | `string` |
| `status` | `string` |
| `type` | `string` |
| `fingerprint` | `string` |
| `duplicateGroupId` | `string` |
| `isPrimary` | `boolean` |
| `expiresAt` | `string \| null` |
| `rateLimitCount` | `number` |
| `leasedBy` | `string \| null` |
| `createdAt` | `string` |
| `updatedAt` | `string` |

**Total: 12 fields**

#### `Account` shape (aggregation — not directly from DB row)

| Field | Type | Source |
|---|---|---|
| `fingerprint` | `string` | `credentials.fingerprint` |
| `isActiveForCc` | `boolean` | Runtime — filesystem check |
| `usagePercent` | `number \| null` | External poller, not in DB |
| `resetsAt` | `string \| null` | External poller, not in DB |
| `plan` | `string \| null` | Mapped from `credentials.subscriptionType` |
| `tier` | `string \| null` | Mapped from `credentials.rateLimitTier` |
| `snapshots` | `CredentialFile[]` | GROUP BY fingerprint |

### Key categorisation

#### Shared keys (CredentialFile ↔ DB row)

| Key | DB type | Domain type | Notes |
|---|---|---|---|
| `id` | `string` | `string` | Exact match |
| `name` | `string` | `string` | Exact match |
| `status` | `string` | `string` | Both untyped strings — no narrowing today |
| `type` | `string` | `string` | Exact match |
| `fingerprint` | `string` | `string` | Exact match |
| `duplicateGroupId` | `string \| null` | `string` | **Mismatch**: DB nullable; domain non-null. Mapper must assert or provide sentinel. |
| `isPrimary` | `boolean` | `boolean` | Exact match |
| `rateLimitCount` | `number` | `number` | Exact match |
| `leasedBy` | `string \| null` | `string \| null` | Exact match |

**9 shared keys**

#### Timestamp type mismatch (critical)

| Key | DB type | Domain type | Impact |
|---|---|---|---|
| `expiresAt` | `Date \| null` | `string \| null` | **Serialization boundary**: DB returns `Date`; domain expects ISO-8601 string. Mapper must call `.toISOString()`. |
| `createdAt` | `Date` | `string` | Same serialization mismatch. |
| `updatedAt` | `Date` | `string` | Same serialization mismatch. |

All three timestamp fields go through an ISO-8601 conversion in the mapper. The DB columns use `{ mode: "date" }`, so Drizzle returns JavaScript `Date` objects. The domain spec says `string` (ISO-8601) for JSON transport. This is intentional but must be explicit in the mapper — it cannot be a simple `Pick`.

#### DB-only keys (not surfaced in CredentialFile)

These columns exist in the DB but are intentionally excluded from `CredentialFile` (either sensitive or aggregated elsewhere):

| Key | DB type | Reason absent |
|---|---|---|
| `valueEncrypted` | `string \| null` | **Sensitive** — must never appear in API responses |
| `encryptionKeyId` | `string \| null` | Internal key management — not a consumer concern |
| `agentId` | `string \| null` | Agent scoping — not needed on the per-file view |
| `leasedAt` | `Date \| null` | Lease timing — not surfaced in CredentialFile |
| `cooldownUntil` | `Date \| null` | Internal pool state — not surfaced |
| `subscriptionType` | `string \| null` | Remapped to `Account.plan` (renamed) |
| `rateLimitTier` | `string \| null` | Remapped to `Account.tier` (renamed) |
| `accountEmail` | `string \| null` | Not in CredentialFile — may be surfaced in Account future |
| `accountName` | `string \| null` | Not in CredentialFile |
| `accountUuid` | `string \| null` | Not in CredentialFile |
| `orgName` | `string \| null` | Not in CredentialFile |
| `orgUuid` | `string \| null` | Not in CredentialFile |
| `mcpProviders` | `string \| null` | Not in CredentialFile |

#### Domain-only computed keys (CredentialFile)

`CredentialFile` has no fields that don't derive from the DB row — every field maps to a DB column (with timestamp serialization transforms applied).

#### Domain-only computed keys (Account)

| Key | Source |
|---|---|
| `isActiveForCc` | Filesystem check — read `~/.claude/.credentials.json` fingerprint; not stored in DB |
| `usagePercent` | External Anthropic usage poller — not in DB |
| `resetsAt` | External Anthropic usage poller — not in DB |
| `plan` | Mapped rename from `credentials.subscriptionType` |
| `tier` | Mapped rename from `credentials.rateLimitTier` |
| `snapshots` | GROUP BY `fingerprint`, ordered with primary first |

### Recommended derivation for CredentialFile

```typescript
import type { credentials } from "@nexus/db";

// Step 1: Pick the directly safe string/number/boolean columns (no timestamp transform needed).
type CredentialFileDbBase = Pick<
  typeof credentials.$inferSelect,
  | "id"
  | "name"
  | "status"
  | "type"
  | "fingerprint"
  | "isPrimary"
  | "rateLimitCount"
  | "leasedBy"
>;

// Step 2: Override fields that need type narrowing or serialization.
type CredentialFileDbOverrides = {
  // DB: string | null; domain: string — mapper must fallback to fingerprint
  duplicateGroupId: string;
  // DB: Date | null; domain: string | null — mapper must call .toISOString()
  expiresAt: string | null;
  // DB: Date (notNull); domain: string — mapper must call .toISOString()
  createdAt: string;
  // DB: Date (notNull); domain: string — mapper must call .toISOString()
  updatedAt: string;
};

export type CredentialFile = Omit<CredentialFileDbBase, keyof CredentialFileDbOverrides> &
  CredentialFileDbOverrides;
```

---

## Key/value mismatches that will break consumers

1. **`sessions.cwd` nullable vs domain non-null**: The DB column is `text("cwd")` (no `.notNull()`), so `$inferSelect` gives `string | null`. The domain `Session.cwd` is typed `string`. Current mapper likely coerces with `?? ""` silently. The API phase mapper must make this explicit and documented.

2. **`sessions.pid` nullable vs domain non-null**: DB is `integer("pid")` without `.notNull()`. Domain requires `number`. Any session row without a pid will crash a consumer that dereferences it without a guard.

3. **`sessions.lastActivity` renamed to `lastHeartbeat`**: The DB column is `last_activity`; the domain field is `lastHeartbeat`. The mapper must alias, not copy. Any code that tries to `Pick` `lastActivity` from the DB row and call it `lastHeartbeat` will fail at the TypeScript level since `Pick` preserves key names.

4. **`sessions.status` unconstrained text**: The DB accepts any string for `status`. The mapper today uses `as Session["status"]` — a type assertion that bypasses runtime validation. If the DB ever holds `"sleeping"` (e.g., from an old agent version), TypeScript consumers silently receive an invalid `SessionStatus`. The E2E unit test is critical here.

5. **`sessions.sessionType` nullable vs domain required**: DB column is `text("session_type")` (nullable). Domain `Session.sessionType` is typed as `SessionType` (non-null union). The current mapper likely defaults to `"ad_hoc"` on null. This default must be codified explicitly in `computeSessionRuntimeFields`.

6. **`credentials.duplicateGroupId` nullable vs domain non-null**: `CredentialFile.duplicateGroupId` is typed `string` (non-null), but the DB column is nullable until the backfill runs. Mapper must fallback to `fingerprint` per the spec comment in the schema.

7. **`credentials` timestamp serialization boundary**: All three timestamp fields (`expiresAt`, `createdAt`, `updatedAt`) are `Date` in the DB row and `string` in `CredentialFile`. This transform must happen in the mapper — not in the component, not in the tRPC procedure, only in the credential-to-domain mapper function.

8. **`credentials.valueEncrypted` must never appear in API responses**: The DB `Credential` type (exported from `@nexus/db`) includes `valueEncrypted`. Any code that spreads a raw `Credential` row into an API response is a security issue. The `CredentialFile` derivation must `Omit` it explicitly, not rely on the mapper "just not setting it."

9. **`Account.plan` / `Account.tier` renamed from DB columns**: `subscriptionType` → `plan`, `rateLimitTier` → `tier`. These renames are easy to miss. If the API phase adds new fields to `Account`, it must check both the DB column name and the domain alias.

10. **`WireCredentialRow` (apps/nextjs/src/app/actions/credentials.ts:16)**: This type is currently defined inline in the Next.js app layer. Task [2.2] moves it to `packages/core/src/types/account.ts`. Until that move, any consumer outside the app will need its own copy — a duplication risk flagged for the API phase.
