# Plan 014: Pin the Swift `Session` Codable model to the agent's `/sessions` wire payload with a fixture-based contract test

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> `git diff --stat 64a206ff..HEAD -- apps/swift/NexusShared/Models/Session.swift apps/swift/NexusSharedTests/SessionDecodingTests.swift apps/agent/src/testing/stub-agent.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `64a206ff`, 2026-07-03

## Why this matters

The two ends of the `/sessions` wire contract drift silently. The agent's DB row
(`sessions.$inferSelect`) is serialized verbatim by `JSON.stringify(rows)` in
`apps/agent/src/routes/sessions.ts:179`, but the Swift `Session` Codable model
(`apps/swift/NexusShared/Models/Session.swift`) hand-declares a subset of
`CodingKeys` and **omits six columns the agent already writes**:
`spec`, `credentialId`, `credentialFingerprint`, `rateLimitUtilization`,
`parentSessionId`, `childRole` — the last two being the subagent-tree columns
the dashboard's "Subagent tree" journey needs. No codegen links the two ends
(a grep for `@generated`/`quicktype`/`DO NOT EDIT` across the Swift models and
`packages/core/src/types` returns nothing), and the DB↔schema drift detector in
`packages/db` does not cover the TS↔Swift seam. A field added to the agent JSON
is invisible to the Swift dashboard until someone hand-edits `CodingKeys`, with
no CI guard.

When this lands: the six drifted fields decode into `Session`, and a shared
fixture (already the convention here) asserts they surface as real values — so a
stale Swift model fails a test instead of silently emptying a dashboard column.

## Current state

The facts the executor needs, inlined.

### The wire is the raw DB row (camelCase JSON)

`apps/agent/src/routes/sessions.ts:179` returns the session list as:

```ts
return new Response(JSON.stringify(rows), { status: 200, ... });
```

`rows` is `SessionRow[]` = `typeof sessions.$inferSelect`
(`apps/agent/src/db/sessions.ts:41`). `JSON.stringify` emits the **camelCase JS
property names** as keys (Drizzle maps `snake_case` columns to camelCase JS
fields). So the wire keys are `parentSessionId`, `credentialId`, etc. — NOT
snake_case. The existing Swift model already decodes camelCase (`projectId`,
`tmuxTarget`), confirming this.

### The DB columns on the wire (`packages/db/src/schema/sessions.ts`)

Every column becomes a wire key. The ones **missing from Swift `CodingKeys`**:

- `spec` — `text("spec")`  → wire `spec: string | null`
- `rateLimitUtilization` — `real("rate_limit_utilization")` → wire `rateLimitUtilization: number | null`
- `credentialId` — `text("credential_id")` → wire `credentialId: string | null`
- `credentialFingerprint` — `text("credential_fingerprint")` → wire `credentialFingerprint: string | null`
- `parentSessionId` — `text("parent_session_id")` → wire `parentSessionId: string | null`
- `childRole` — `text("child_role")` → wire `childRole: string | null`

(Also on the wire but intentionally ignored by the Swift model per its
"unknown keys are ignored" contract: `stopReason`, `errorDetails`,
`rateLimitResetAt`. Leave those alone — see Out of scope.)

### NOT on this wire — do not add these

`apps/agent/src/session-manager.ts:126-156` builds the **domain** `Session`
(with `command`, `agent`, `rateLimitType`), but those three are
`SessionRuntimeFields` in `packages/core/src/types/session.ts:87-119` — computed,
**no DB column**, so they are absent from `sessions.$inferSelect` and therefore
absent from the `/sessions` payload. Do **NOT** add `command`, `agent`
(already present as a tolerated optional), or `rateLimitType` to the fixture or
assert them — they never appear on this route. (This corrects the finding, which
conflated the domain type with the wire payload.)

### The Swift model today (`apps/swift/NexusShared/Models/Session.swift`)

Three edit sites, all of which must be updated together for the file to compile:

1. **Stored properties** (after `sessionType`, ~line 76): declare the six new
   `public var`s.
2. **`CodingKeys`** (lines 78-102): currently ends `...totalCostUsd`,
   `idleSince`, `sessionType`. Add the six new cases.
3. **`init(from decoder:)`** (lines 104-140): add `decodeIfPresent` lines.
4. **Memberwise `init(...)`** (lines 142-188): Swift requires every stored
   property be assigned; add the six params (with `nil` defaults, so existing
   call sites stay compiling) and their assignments.

The model's header contract (lines 4-11): "We decode only the fields
cross-platform Apple targets need; unknown keys are ignored." Adding these six is
consistent — they are fields the dashboard needs, not speculative.

### The shared fixture already exists — reuse it, do not fork it

`apps/swift/NexusSharedTests/SessionDecodingTests.swift` is the Session-specific
decode test file. It already owns a canonical `/sessions` fixture:

- `stubSessionRowJSON` (lines 73-102) — "byte-identical to what the shared
  stub-agent serves for `GET /sessions`", i.e. `SESSIONS_FIXTURE[0]` after
  `JSON.stringify`.
- `testDecodesFullStubSessionsWireRow` (line 108) decodes the full row but only
  asserts the projected subset; the six drifted fields sit in the fixture as
  `null` and are currently **ignored**.
- Its header (lines 58-69) **explicitly forbids** forking this into a
  client-only fixture: *"Do NOT fork this into a divergent client-only fixture
  (design.md 'no divergent fixtures' / mock-drift mitigation)."*

The TS source of truth is `apps/agent/src/testing/stub-agent.ts:100-132`,
`SESSIONS_FIXTURE: SessionRow[]`. Because it is **typed `SessionRow[]`**, adding
a new column to the schema forces a TypeScript build break here until the fixture
is updated — that is the TS-side drift guard. The Swift `stubSessionRowJSON` is
hand-kept in sync with it.

> **File-placement note (interpretation — read before starting)**: The finding
> suggested extending `PayloadDecodeTests.swift`. This plan places the new test
> in **`SessionDecodingTests.swift`** instead, because that file already owns the
> `/sessions` Session fixture and its header rule forbids a divergent fixture —
> extending `PayloadDecodeTests` would require duplicating the Session fixture and
> violate the codebase's own mock-drift rule. This is a deliberate override of
> the suggestion, grounded in the reuse rule. Do not create a second Session
> fixture anywhere.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 |
| TS fixture tests | `NEXUS_ATTACH_SECRET=test bun test apps/agent/src/testing/stub-agent.test.ts` | all pass |
| TS agent suite (regression) | `NEXUS_ATTACH_SECRET=test bun test apps/agent/src/testing apps/agent/src/routes/sessions.test.ts` | all pass |
| Swift project regen (Mac) | `cd apps/swift && xcodegen generate` | writes `nexus.xcodeproj` |
| Swift test (Mac ONLY) | `cd apps/swift && xcodebuild test -scheme NexusShared -only-testing:NexusSharedTests/SessionDecodingTests` | test suite passes |
| List Swift schemes (if unsure) | `cd apps/swift && xcodebuild -list` | shows target/scheme names |

- `NEXUS_ATTACH_SECRET=test` is required for the Bun agent tests (per project
  memory `feedback_test_env_vars`).
- **The Swift step cannot run on Linux.** `xcodebuild` requires macOS. If you are
  on the Linux host, you CANNOT verify the Swift side locally — follow the
  Mac-verification handoff in Done criteria and STOP conditions.

## Suggested executor toolkit

- If a `swift-engineer` agent is available, dispatch the Swift edits to it — it
  knows the Linux→Mac headless build contract (`ssh mac` + `swiftc -typecheck` +
  `xcodegen`) and the Codable wire-model conventions.
- Model the new test after the existing `testDecodesFullStubSessionsWireRow` in
  the same file (line 108) — same decode helper, same fixture style.

## Scope

**In scope** (the only files you should modify):

- `apps/swift/NexusShared/Models/Session.swift` — add the six fields at all
  three/four edit sites (stored props, `CodingKeys`, `init(from:)`, memberwise
  `init`).
- `apps/swift/NexusSharedTests/SessionDecodingTests.swift` — add a populated
  child-session fixture string + a test asserting the six fields decode to real
  values.
- `apps/agent/src/testing/stub-agent.ts` — append a second, **populated**
  `SESSIONS_FIXTURE` row (the child) that the Swift fixture mirrors, keeping the
  shared source-of-truth contract.
- `plans/README.md` — status row (create the file if absent; see Step 5).

**Out of scope** (do NOT touch, even though they look related):

- `apps/agent/src/routes/sessions.ts` — the serializer is already correct
  (`JSON.stringify(rows)`); nothing to change.
- `packages/core/src/types/session.ts` and `packages/db/src/schema/sessions.ts`
  — the TS/DB ends already carry every field; the drift is Swift-only.
- The `command`, `agent`, `rateLimitType` fields — runtime-only, not on this
  wire (see Current state).
- `stopReason`, `errorDetails`, `rateLimitResetAt` — intentionally ignored by the
  Swift model; adding them is out of scope for this plan.
- `PayloadDecodeTests.swift` — do not fork the Session fixture into it.
- Any codegen tool (quicktype/etc.) — explicitly the higher-risk alternative,
  not chosen here (see Maintenance notes).

## Git workflow

- Branch: `advisor/014-swift-wire-contract-test`
- Conventional commits. Example message: `test(swift): pin Session model to /sessions wire payload`
  (a second commit `feat(swift): decode subagent-tree + credential Session fields`
  for the model change is fine if you prefer per-logical-unit commits).
- Stage only the in-scope paths with explicit `git add <path>` — never `git add .`.
- Do NOT push or open a PR.

## Steps

### Step 1: Add the six fields to `Session.swift`

In `apps/swift/NexusShared/Models/Session.swift`:

1. **Stored properties** — after `public var sessionType: String?` (~line 76),
   add:

   ```swift
   /// OpenSpec proposal slug the session is working on (`sessions.spec`).
   public var spec: String?
   /// Rate-limit utilization fraction 0.0–1.0 (`sessions.rate_limit_utilization`).
   public var rateLimitUtilization: Double?
   /// Active credential id / fingerprint for this session — subagent-tree +
   /// credential columns the agent writes (add-subagent-tree-columns).
   public var credentialId: String?
   public var credentialFingerprint: String?
   /// Sub-agent tree linkage: the parent session id and this child's role.
   /// Both nil for a top-level session. Drives the Subagent-tree dashboard.
   public var parentSessionId: String?
   public var childRole: String?
   ```

2. **`CodingKeys`** — after `case sessionType` (line 101), add:

   ```swift
   case spec
   case rateLimitUtilization
   case credentialId
   case credentialFingerprint
   case parentSessionId
   case childRole
   ```

3. **`init(from decoder:)`** — after the `self.sessionType = ...` line (line 139),
   add:

   ```swift
   self.spec                  = try c.decodeIfPresent(String.self, forKey: .spec)
   self.rateLimitUtilization  = try c.decodeIfPresent(Double.self, forKey: .rateLimitUtilization)
   self.credentialId          = try c.decodeIfPresent(String.self, forKey: .credentialId)
   self.credentialFingerprint = try c.decodeIfPresent(String.self, forKey: .credentialFingerprint)
   self.parentSessionId       = try c.decodeIfPresent(String.self, forKey: .parentSessionId)
   self.childRole             = try c.decodeIfPresent(String.self, forKey: .childRole)
   ```

4. **Memberwise `init(...)`** — add six trailing params with `nil` defaults after
   `sessionType: String? = nil` (line 164), and the matching `self.x = x`
   assignments after `self.sessionType = sessionType` (line 187):

   ```swift
   // params:
   spec: String? = nil,
   rateLimitUtilization: Double? = nil,
   credentialId: String? = nil,
   credentialFingerprint: String? = nil,
   parentSessionId: String? = nil,
   childRole: String? = nil
   // assignments:
   self.spec = spec
   self.rateLimitUtilization = rateLimitUtilization
   self.credentialId = credentialId
   self.credentialFingerprint = credentialFingerprint
   self.parentSessionId = parentSessionId
   self.childRole = childRole
   ```

**Verify (Mac)**: `cd apps/swift && xcodegen generate && xcodebuild build -scheme NexusShared` → build succeeds.
**Verify (Linux fallback)**: cannot build; confirm by inspection that all four
edit sites are updated and each of the six names appears in exactly: 1 stored
prop, 1 `CodingKeys` case, 1 `init(from:)` line, 1 init param + 1 assignment.
`grep -c 'parentSessionId' apps/swift/NexusShared/Models/Session.swift` → `5`
(prop + key + decode + param + assignment).

### Step 2: Append a populated child row to the TS fixture

In `apps/agent/src/testing/stub-agent.ts`, add a **second** object to
`SESSIONS_FIXTURE` (after the existing row, before the closing `];` at line 132).
It represents a subagent (child of `stub-sess-1`) and populates the six drifted
fields with non-null values. Because the array is typed `SessionRow[]`, include
**every** column (copy the shape of row 0, change the values below):

```ts
{
  id: "stub-sess-2-child",
  projectId: null,
  machine: "stub-machine",
  status: "active",
  startedAt: new Date(FIXED_NOW),
  lastActivity: new Date(FIXED_NOW),
  endedAt: null,
  stopReason: null,
  errorDetails: null,
  pid: 4243,
  cwd: "/tmp/stub",
  branch: null,
  sessionType: "ad_hoc",
  model: "claude",
  rateLimitUtilization: 0.42,
  totalCostUsd: null,
  rateLimitResetAt: null,
  idleSince: null,
  ccSessionId: null,
  tmuxSession: null,
  tmuxTarget: null,
  spec: "add-subagent-tree-columns",
  credentialId: "cred-personal",
  credentialFingerprint: "fp-aaaa",
  gitProvider: null,
  gitOwnerRepo: null,
  agentState: null,
  parentSessionId: "stub-sess-1",
  childRole: "explore",
},
```

`stub-agent.test.ts:57` compares the served payload to `SESSIONS_FIXTURE` by value
(self-referential `toEqual`), so it tolerates the extra row. If any other test
hard-codes the row count, update it to match.

**Verify**: `NEXUS_ATTACH_SECRET=test bun test apps/agent/src/testing/stub-agent.test.ts`
→ all pass. Then the broader regression command in the table → all pass.

### Step 3: Mirror the populated row in the Swift fixture + assert it decodes

In `apps/swift/NexusSharedTests/SessionDecodingTests.swift`, add a new private
fixture string mirroring the TS child row (dates as the ISO8601 form
`JSON.stringify` emits — match the string style of `stubSessionRowJSON`), then a
test. Model it on `testDecodesFullStubSessionsWireRow` (line 108):

```swift
/// Child subagent row — mirrors stub-agent SESSIONS_FIXTURE[1]. Populates the
/// previously-drifted columns so a stale Swift model (missing a CodingKey)
/// decodes nil here and FAILS the assertions below.
private static let stubChildSessionRowJSON = """
{
  "id": "stub-sess-2-child",
  "projectId": null,
  "machine": "stub-machine",
  "status": "active",
  "startedAt": "2026-05-19T11:04:02.740Z",
  "lastActivity": "2026-05-19T11:04:02.740Z",
  "endedAt": null,
  "pid": 4243,
  "cwd": "/tmp/stub",
  "branch": null,
  "sessionType": "ad_hoc",
  "model": "claude",
  "rateLimitUtilization": 0.42,
  "totalCostUsd": null,
  "rateLimitResetAt": null,
  "idleSince": null,
  "ccSessionId": null,
  "tmuxSession": null,
  "tmuxTarget": null,
  "spec": "add-subagent-tree-columns",
  "credentialId": "cred-personal",
  "credentialFingerprint": "fp-aaaa",
  "gitProvider": null,
  "gitOwnerRepo": null,
  "parentSessionId": "stub-sess-1",
  "childRole": "explore"
}
"""

/// Contract: the six previously-drifted columns
/// (spec / rateLimitUtilization / credentialId / credentialFingerprint /
/// parentSessionId / childRole) MUST decode to their wire values. A Swift model
/// missing any CodingKey decodes that field to nil and fails here — this is the
/// TS↔Swift wire-drift guard.
func testDecodesSubagentTreeAndCredentialFields() throws {
    let data = Self.stubChildSessionRowJSON.data(using: .utf8)!
    let s = try JSONDecoder().decode(Session.self, from: data)
    XCTAssertEqual(s.parentSessionId, "stub-sess-1", "parent linkage must decode")
    XCTAssertEqual(s.childRole, "explore")
    XCTAssertEqual(s.credentialId, "cred-personal")
    XCTAssertEqual(s.credentialFingerprint, "fp-aaaa")
    XCTAssertEqual(s.spec, "add-subagent-tree-columns")
    XCTAssertEqual(s.rateLimitUtilization ?? -1, 0.42, accuracy: 0.001)
}
```

**Verify (Mac)**:
`cd apps/swift && xcodegen generate && xcodebuild test -scheme NexusShared -only-testing:NexusSharedTests/SessionDecodingTests`
→ the new test passes; all sibling tests still pass.
**Verify (Linux fallback)**: cannot run. Confirm the test file references
`stubChildSessionRowJSON`, the six field names appear in assertions, and the JSON
keys exactly match the TS row from Step 2 (same keys, same values). This is the
STOP-and-handoff point (see Done criteria).

### Step 4: Sanity-check the drift guard actually bites (Mac, optional but recommended)

Temporarily comment out one new `CodingKeys` case (e.g. `case childRole`) and
re-run the Step 3 Swift test. Expected: `testDecodesSubagentTreeAndCredentialFields`
FAILS on the `childRole` assertion (decodes nil). Restore the case. This proves
the test is a real guard, not a tautology. Skip on Linux (cannot run); note it in
the handoff for the Mac verifier.

### Step 5: Update `plans/README.md`

If `plans/README.md` does not exist, create it with the index header from the
plan template and a single status row for this plan. If it exists, add/update the
014 row. Set status to `IN PROGRESS` until Mac verification lands (see Done
criteria), then `DONE`.

## Test plan

- **New Swift test**: `testDecodesSubagentTreeAndCredentialFields` in
  `SessionDecodingTests.swift` — asserts all six drifted fields decode to their
  wire values from the mirrored child fixture. Covers: the exact regression this
  plan fixes (fields silently dropped by missing `CodingKeys`).
- **Structural pattern to follow**: `testDecodesFullStubSessionsWireRow` in the
  same file.
- **TS regression**: `stub-agent.test.ts` must still pass with the second fixture
  row (self-referential `toEqual` tolerates it).
- **Verification**:
  - TS: `NEXUS_ATTACH_SECRET=test bun test apps/agent/src/testing/stub-agent.test.ts` → all pass.
  - Swift (Mac): `xcodebuild test -scheme NexusShared -only-testing:NexusSharedTests/SessionDecodingTests` → all pass including the 1 new test.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `NEXUS_ATTACH_SECRET=test bun test apps/agent/src/testing/stub-agent.test.ts` exits 0 (fixture consumers pass with the new row).
- [ ] `apps/swift/NexusShared/Models/Session.swift` declares all six fields at every edit site: `grep -c 'parentSessionId' apps/swift/NexusShared/Models/Session.swift` → `5`; likewise `credentialFingerprint`, `spec`, `rateLimitUtilization`, `credentialId`, `childRole` each appear the expected number of times (prop/key/decode/param/assignment).
- [ ] `SessionDecodingTests.swift` contains `testDecodesSubagentTreeAndCredentialFields` referencing `stubChildSessionRowJSON`, and the fixture's JSON keys/values match the TS `SESSIONS_FIXTURE[1]` row exactly.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row updated.
- [ ] **Swift runtime verification (Mac only)**: `xcodebuild test -scheme NexusShared -only-testing:NexusSharedTests/SessionDecodingTests` passes.
  - If you are on the Linux host and cannot run `xcodebuild`, the Swift-side Done
    criterion is **source-level** (the file edits + assertions above) PLUS a
    **STOP-and-handoff**: report that the change is source-complete and needs Mac
    verification. Per project conventions, Mac verification runs via `ssh mac`
    (git fast-forward to this branch, then `xcodebuild test ...`), and the
    `deploy/hooks.d/pre-push/01-deploy` Darwin gate runs `xcodebuild test`
    automatically on push from a Mac. Do not mark the plan `DONE` until a human
    or a Mac-capable agent confirms the Swift test passed; leave it `IN PROGRESS`
    with a one-line note "awaiting Mac xcodebuild verification".

## STOP conditions

Stop and report back (do not improvise) if:

- The drift check shows `Session.swift`, `SessionDecodingTests.swift`, or
  `stub-agent.ts` changed since commit `64a206ff` and the "Current state"
  excerpts no longer match — the codebase has drifted.
- Adding the six `CodingKeys` / stored properties changes decoding behavior for
  existing shipped clients in a way that looks breaking (e.g. a sibling test that
  previously passed now fails on an unrelated field, or a field name collides).
  **Wire-compat is a maintainer decision** — surface it, do not force it.
- The TS regression suite fails on a hard-coded fixture row count you cannot
  resolve by a one-line count update.
- You are on Linux and cannot run `xcodebuild`: complete the source edits, then
  STOP at the Mac-verification handoff (see Done criteria) — do not claim the
  Swift test passes without runtime evidence.
- The fix appears to require touching an out-of-scope file (e.g. the route
  serializer, the DB schema, or `PayloadDecodeTests.swift`).

## Maintenance notes

For the human/agent who owns this code after the change lands:

- **The guard is only as good as the shared fixture pair.** The TS
  `SESSIONS_FIXTURE` (typed `SessionRow[]`) breaks the Bun build when a schema
  column is added — that is the TS-side ratchet. The Swift `stubChildSessionRowJSON`
  is **hand-kept** in sync; there is no automated byte-identity check between them.
  When you add a `sessions` column that the dashboard needs, update BOTH fixtures
  and add a Swift assertion, exactly as this plan did. A lightweight follow-up
  (a test that diff-checks the Swift fixture keys against `SESSIONS_FIXTURE`) would
  close the hand-sync gap — deferred here to keep this plan's blast radius small.
- **Alternative considered and rejected: codegen.** Generating the Swift structs
  from the TS/Drizzle types (quicktype or a custom emitter) would eliminate the
  hand-sync entirely, but it is the higher-effort/higher-risk option: it adds a
  build-time toolchain, a generated-file review burden, and couples the Swift
  build to a TS codegen step across a Linux→Mac boundary. Not chosen — the
  fixture-based contract test is the lower-risk fix and matches the existing
  `PayloadDecodeTests`/`SessionDecodingTests` convention already in the repo.
- **Reviewer scrutiny**: confirm the six new `CodingKeys` are camelCase (matching
  the Drizzle JS field names, not snake_case), that the memberwise-init params
  default to `nil` (so no existing `Session(...)` call site breaks), and that the
  Swift child fixture is byte-faithful to `SESSIONS_FIXTURE[1]`.
- **Interacts with**: the "Subagent tree" dashboard journey — once `parentSessionId`
  / `childRole` decode, any Swift view that renders the spawn tree can rely on
  these being populated for child rows.
