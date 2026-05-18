# Stack-Toolchain Audit (nx-eg47m)

**Date**: 2026-05-18
**Epic**: nx-u6ce2 (`[CAPABILITY] stack-toolchain-extensibility`)
**Followups**: nx-51k5q (DECISION), nx-d8l1t (IMPLEMENTATION-SCAFFOLD)
**Auditor**: read-only pass over 8 listed files in `~/.claude/` + the canonical `stack-detect.sh` library

---

## Executive Summary

The current toolchain handles stacks as a **scattered hardcoded switch-case set with two competing detection implementations**, not as a registry. The shape is partially extensible — `stacks.md` documents the contract for adding a new profile and gates the dispatch via a single `$STACK` variable — but the actual wiring lives in three independent places that must be edited in lockstep (detection library, dispatch case-statement in `apply/all.md`, gate case-statement in `stacks.md`). The biggest extension hazard is a **drift between the canonical shell library `~/.claude/scripts/lib/stack-detect.sh` and the inline `detect_stack()` in `stacks.md`**: the library already returns 9 stack identifiers (`t3-turbo`, `t3-docker`, `effect`, `meta`, `go-cli`, `dotnet-next`, `terraform`, `bash-infra`, `bash`) while the dispatch logic only branches on 3 (`t3`, `effect`, `meta`). Adding a new stack like `swift-bun-hybrid` is mechanically possible in <3 hours of edits, but the system has no schema-enforced registry that prevents the next contributor from introducing the same drift again.

---

## Inventory

| File | Role | Stack-handling surface |
|---|---|---|
| `~/.claude/scripts/lib/stack-detect.sh` | **Canonical detection library**. Sourced by `phase1-bootstrap`. Returns single string. | `detect_stack()` shell function — 11-priority filesystem signal cascade. Returns 9 identifiers including `t3-turbo` (NOT `t3`). |
| `~/.claude/scripts/bin/phase1-bootstrap` | Phase 1.5–1.9 data-producer. Calls `detect_stack` via shell-out. | `phase_stack_detection()` at lines 178–192 — sources the lib, runs `detect_stack .`, returns trimmed string or `None`. |
| `~/.claude/scripts/bin/wave-plan-build` | Phase classifier + wave planner. **Stack-agnostic**. | `PHASE_HEADERS` dict (lines 28–33) — hardcoded `## DB Batch` / `## API Batch` / `## UI Batch` / `## E2E Batch` map. No DOC. Path regex (`KNOWN_PATH_EXTENSIONS`, lines 56–61) is stack-neutral but assumes T3 conventions (`apps/`, `packages/`, `.ts`/`.tsx`/`.sql`). |
| `~/.claude/scripts/bin/deferred-specs` | Scanner for unchecked tasks. Stack-agnostic — reads `tasks.md` markdown only. | None. Pure markdown parsing. |
| `~/.claude/commands/apply.md` | Single-spec dispatcher. **Stack-blind** at orchestrator level. | None directly — delegates Phase 3 stack handling to `references/stacks.md` via execution-model. Phase 4 archive shells out to `pnpm tsc` (line 405) + `pnpm turbo run build` (line 408) — **hardcoded t3 assumption**. |
| `~/.claude/commands/apply/all.md` | Multi-spec wave orchestrator. **Stack-aware** at one site. | Lines 79 — `--stack=*` arg parse. Lines 403–404 — validation: `t3, t3-turbo, t3-docker, effect, meta`. Lines 611–627 — hardcoded `case "$STACK"` for `phaseAgentType` (3 branches only). Lines 670–680 — hardcoded `case "$STACK"` for gate dispatch (delegates to stacks.md § Step 3d). |
| `~/.claude/commands/apply/references/stacks.md` | **Stack profile registry doc**. Switch-case-as-prose. | Section per stack: `## Profile: t3` (lines 106–127), `## Profile: effect` (130–183), `## Profile: meta` (186–239). Each declares (a) detection signal, (b) phase→agent map, (c) phase→gate map, (d) spec-tag mapping. Lines 281–290 declare a `PROFILE_AGENT_MAP[$STACK][$PHASE]` lookup contract — **not actually implemented**, prose only. Lines 322–413 contain the **executable** per-stack gate `case` statement. |
| `~/.claude/commands/apply/references/phases.md` | Phase philosophy + per-stack translation table. | Lines 64–110 — three translation tables (t3 / effect / meta) mapping universal Foundation/Interface/Consumer/Verification names to T3 labels + per-stack artifacts. Lines 185–198 — "Adding a new stack profile" checklist (manual; no enforcement). |
| `~/.claude/commands/apply/references/execution-model.md` | Per-phase agent dispatch rules + classification keywords. | Lines 95–110 — owner-patterns table (t3 default). Lines 222–238 — `PHASE_KEYWORDS` Python dict for classification — **hardcoded T3 vocabulary** (`drizzle`, `trpc`, `playwright`). Lines 239 — file-path fallback (schemas/→DB, routers/→API, components/→UI) **T3-only**. Lines 442–446 — phase-specific prompt additions per phase (T3-only language). |

---

## Stack Profile Registration

**Q1: How does the toolchain know about `t3`, `t3-turbo`, `effect`, `meta`? Where would a new profile plug in?**

Registration is **split across three artifacts**, all of which must be hand-edited:

| Artifact | What it declares | Drift surface |
|---|---|---|
| `scripts/lib/stack-detect.sh` `detect_stack()` (lines 28–87) | Filesystem signal cascade → string ID | Returns `t3-turbo` etc.; `apply/all.md` validates against `t3, t3-turbo, t3-docker, effect, meta` (line 403) — **ID renaming hazard** |
| `commands/apply/all.md` § Phase 3 Step 3c (lines 611–627) | `case "$STACK"` → `phaseAgentType` per phase | Only 3 branches (`t3`, `effect`, `meta`). t3-turbo/t3-docker silently fall through to default — no explicit handling |
| `commands/apply/references/stacks.md` § Profile sections + § Step 3d (lines 322–413) | Gate `case "$STACK"` + agent/gate map prose | Only 3 branches. Same fall-through risk |

**Mechanism**: switch-case at three call sites. The "registry" claim in `stacks.md` lines 281–290 (`PROFILE_AGENT_MAP[$STACK][$PHASE]`) is **aspirational prose**, not a real lookup table — there is no shared shell associative array or JSON file the three sites read from.

**Adding `swift-bun-hybrid`** today requires:

1. Add filesystem signal block to `scripts/lib/stack-detect.sh` priority cascade.
2. Add `## Profile: swift-bun-hybrid` section to `stacks.md` with 5-row phase table.
3. Add `case swift-bun-hybrid` branch to `apply/all.md` lines 611–627 (agent map) and stacks.md § Step 3d (gate map).
4. Update validation allowlist at `apply/all.md` line 403.
5. Add translation row to `phases.md` § Per-stack translations.
6. Audit `PHASE_KEYWORDS` and file-path fallback in `execution-model.md` to confirm they still classify Swift tasks correctly (likely they don't — see Q6).

No automated test prevents a contributor from doing 1+5 without 2+3+4, leaving the stack detectable but un-dispatchable.

**File:line evidence**:
- `scripts/lib/stack-detect.sh:32-87` — actual implementation, 11-priority cascade
- `commands/apply/all.md:611-627` — agent dispatch switch (3 branches)
- `commands/apply/all.md:403` — stack name allowlist
- `commands/apply/references/stacks.md:38-78` — **competing duplicate** `detect_stack()` (registry-based, returns only t3/effect/meta) — **drift hazard**

**Drift confirmation**: `stacks.md` `detect_stack()` returns `"t3"` (line 77) while `stack-detect.sh` returns `"t3-turbo"` (line 73). The canonical library is the one wired into `phase1-bootstrap`. The inline shell in `stacks.md` is dead code that disagrees.

---

## Phase Classification Map

**Q2: Where does `wave-plan-build` map file paths to phases (DB/API/UI/E2E)? Is this hardcoded per-stack or driven by config?**

**`wave-plan-build` does NOT classify by file path.** It classifies tasks by reading `## DB Batch | ## API Batch | ## UI Batch | ## E2E Batch` headers in `tasks.md` and assigning the section content to that phase. File paths are extracted for the **conflict matrix** (which specs share files → cannot wave together), not for phase classification.

| Map | Where | Hardcoded per-stack? |
|---|---|---|
| Tasks → phase | `wave-plan-build:28-33` `PHASE_HEADERS = {"## DB Batch": "DB", ...}` | **Hardcoded labels.** Not stack-aware. `phases.md` (lines 113–123) explicitly says strict labels are by design; non-T3 stacks reuse the labels as display-name aliases |
| Conflict-matrix files | `wave-plan-build:43-49` `PATH_RE` + `KNOWN_PATH_EXTENSIONS:56-61` | **Stack-neutral but T3-flavored**: matches `apps|packages|tooling|scripts|commands|skills|agents|rules|openspec|docs|infrastructure|infra` directory prefixes. Swift paths like `apps/swift/nexus-mac/` would match the `apps/` prefix but a hypothetical `swift/` top-level dir would not. |
| Keyword → phase fallback | `execution-model.md:222-238` `PHASE_KEYWORDS` dict | **Hardcoded T3 vocabulary**: includes `drizzle`, `trpc`, `playwright`, `vitest`. No swift/bun/xcode/cargo terms. |
| Path-pattern fallback | `execution-model.md:239` `schemas/ → DB`, `routers/ → API`, `components/ → UI`, `e2e/ → E2E` | **Hardcoded T3 paths.** Swift conventions (`Sources/`, `Tests/`, `*.swift`) get no signal. |

**Net assessment**: phase assignment is driven by `## X Batch` headers in `tasks.md`, so spec authors carry the translation burden manually. The classification heuristics in `execution-model.md` are only used by `apply.md` Pattern detection (Pattern A vs B vs C etc., lines 78–90 of execution-model.md) — they don't drive the wave-plan classifier. A new stack adding a Swift codebase would need the spec author to write `## DB Batch` for Swift model types — that translation is documented in `phases.md` but enforced only by social convention.

---

## Engineer-Agent Dispatch

**Q3: How does `/apply:all` Phase 3 choose which engineer-type to spawn per phase? Per-stack map? Where would `swift-engineer` slot in?**

The dispatch is **per-stack, per-phase, hand-wired** at `apply/all.md:611-627`:

```bash
case "$STACK" in
  t3)
    case "$PHASE" in
      DB)  phaseAgentType="db-engineer" ;;
      API) phaseAgentType="api-engineer" ;;
      UI)  phaseAgentType="ui-engineer" ;;
      E2E) phaseAgentType="test-writer" ;;
      DOC) phaseAgentType="general-purpose" ;;
    esac ;;
  effect)
    case "$PHASE" in
      DOC) phaseAgentType="general-purpose" ;;
      *)   phaseAgentType="effect-engineer" ;;
    esac ;;
  meta) phaseAgentType="general-purpose" ;;
esac
```

A `swift-engineer` would slot in via:

```bash
swift-bun-hybrid)
  case "$PHASE" in
    DB)  phaseAgentType="swift-engineer" ;;    # NexusShared models
    API) phaseAgentType="bun-engineer" ;;       # agent daemon (Bun)
    UI)  phaseAgentType="swift-engineer" ;;    # SwiftUI apps
    E2E) phaseAgentType="general-purpose" ;;   # XCUITest / bun test
    DOC) phaseAgentType="general-purpose" ;;
  esac ;;
```

**Friction points**:

1. **No registry abstraction.** The `case` lives in `apply/all.md` (orchestrator command, not a library), so the orchestrator-resident context size grows with every new stack.
2. **DOC frontmatter override exists** (`stacks.md:243-265` + `execution-model.md:907-934`) — per-spec `doc_agent:` frontmatter, but only for the DOC phase. Other phases have no per-spec override.
3. **Stack profiles ostensibly declare an `EligibleAgents` set** (e.g. T3: `db-engineer` + `db-*`, see execution-model.md:108). The wildcard is not enforced — the dispatch picks ONE agent per phase.
4. **`apply/all.md:611-627` and `stacks.md:282-296` describe the same map twice** — drift hazard. The "lookup contract" prose in stacks.md says `PROFILE_AGENT_MAP[$STACK][$PHASE]` but no such object exists.

**Best plug-in point** for `swift-engineer`: add the `case swift-bun-hybrid)` branch in `apply/all.md` Step 3c AND the parallel section in `stacks.md`. There is no single-source extension.

---

## Per-Phase Gate Sequence

**Q4: How does `/apply:all` pick which gate runs after each phase? Where do new gates attach?**

Gate selection is **stack-aware** and lives in **`stacks.md` § Apply:all Step 3d — Per-Stack Gate Implementation** (lines 322–413). This is the executable copy referenced (not duplicated) by `apply/all.md:670-680`.

The structure is a nested case:

```bash
case "$STACK" in
  t3)     case "$PHASE" in DB) gate_typecheck && gate_db_drift ;; API|UI) ... ;; E2E) ... ;; DOC) ... ;; esac ;;
  effect) case "$PHASE" in DB) bun typecheck --filter=... ;; ... ;; esac ;;
  meta)   # universal: bash -n + openspec validate per phase ;;
esac
```

**Attachment point for new gates**:

| New gate | Add to |
|---|---|
| `xcodegen-spec-check` (Swift) | New `swift-bun-hybrid)` branch in stacks.md § Step 3d |
| Per-phase override of an existing gate | Edit the inner `case "$PHASE"` for the right stack |
| Cross-stack pre-gate (e.g. lockfile-freshness) | No current hook — would need a new "wave start" step before the case statement, or invented as a "Phase 0" gate at orchestrator level |

**Coupling observations**:

- T3 gates pull from shared helpers (`gate_typecheck`, `gate_db_drift`, `gate-output-summarizer`). These are extracted to libraries — good reuse.
- Effect/meta gates are inline shell — direct `bun typecheck --filter ...` and `bash -n + openspec validate` calls. **Not extracted to helpers.**
- DOC gate is duplicated three times (once per stack, lines 343–352, 362–367, 401–408) — same content (`openspec validate <spec> --strict`). This is dead-simple deduplication waiting to happen.

The gate system is the **most refactor-friendly** of the four surfaces: gates already live in extractable shell functions, the case statement is concise, and adding a new stack's gate is one block of shell.

---

## Skill Loading

**Q5: Where in the codebase do skills get auto-loaded per phase/agent? Is there a skill→stack mapping table?**

**No skill→stack mapping exists in the apply pipeline**. The pipeline:

1. Dispatches an engineer agent via `Agent({subagent_type: ...})`.
2. The engineer agent's `.md` definition (e.g. `~/.claude/agents/backend/api-engineer.md`) declares which skills it loads on demand via `Skill({ skill: "..." })`.
3. Skills are loaded **inside the engineer**, not in the orchestrator.

This means stack-specific patterns are loaded **transitively through agent choice**, not through any explicit table:

- T3 dispatch → `api-engineer` → loads `t3-code-patterns`, `trpc-patterns`, `state-handling` (per `rules/TOOLING.md` § Agent-Skill Mapping)
- Effect dispatch → `effect-engineer` → loads effect-specific skills (per its own .md)
- Meta dispatch → `general-purpose` → loads whatever the prompt mentions

**Indirect mapping table**: `rules/TOOLING.md` § Agent-Skill Mapping (referenced from CLAUDE.md), and `rules/PATTERNS.md` § Pattern Routing Table (maps domains → skills). Neither is per-stack-keyed.

**For `swift-engineer`** to load Swift-specific patterns, the workflow would be:

1. Create `agents/backend/swift-engineer.md` with `Skill({ skill: "swift-code-patterns" })` invocations.
2. Create `skills/swift-code-patterns/SKILL.md`.
3. The agent picks up the skill when dispatched — no pipeline edit needed.

**This is actually the cleanest extension surface** in the entire system. The apply pipeline doesn't know about skills; it just picks an agent. The agent picks its skills. The indirection is clean.

**File:line evidence**:
- `~/.claude/rules/TOOLING.md` — Agent-Skill Mapping table (load on demand)
- `~/.claude/rules/PATTERNS.md` § Pattern Routing Table — domain → skill (no stack column)
- No file under `commands/apply/` references skills directly except per-phase prompt template prose

---

## Cross-Stack Assumptions (Friction Points)

**Q6: Find code that ASSUMES a stack. These are the "extension friction" points.**

Highest-impact friction first:

| File:line | Hardcoded assumption | Recommended generalization |
|---|---|---|
| `commands/apply.md:405,408,410` | `pnpm tsc --noEmit`, `pnpm turbo run build --filter="...[origin/$BASE_BRANCH]"`, fallback `pnpm build` | Phase 4 single-spec verification is **t3-only**. Should delegate to a per-stack `verify_full` function (currently the per-stack gate logic in stacks.md § Step 3d only fires in `/apply:all`, not `/apply` single-spec). |
| `commands/apply.md:413` | `rm -rf .next` (Next.js cache invalidation) | Per-stack cache cleanup. Swift would need `rm -rf ~/Library/Developer/Xcode/DerivedData/...`; meta needs nothing. Generalize via per-stack `clean_cache()` helper. |
| `commands/apply/references/execution-model.md:222-238` | `PHASE_KEYWORDS` includes `drizzle`, `trpc`, `playwright`, `vitest` — no swift/bun/effect terms | Move to per-stack JSON keyword files (e.g. `stack-profiles/<stack>/keywords.json`) consumed by the classifier. Default falls back to T3 vocab. |
| `commands/apply/references/execution-model.md:239` | File-path fallback `schemas/→DB, routers/→API, components/→UI, e2e/→E2E` is T3-only | Per-stack path-glob registry. The `effect` profile already overrides this via `stacks.md:152-161` (spec-tag mapping table) but the data lives in prose, not code. |
| `commands/apply/references/execution-model.md:442-446` | Phase-specific prompt additions table uses `drizzle-kit generate`, `@{workspace}/db/client`, `queryOptions()`, `@{workspace}/ui` — T3-only language injected into agent prompts | Per-stack prompt fragment library; orchestrator picks the fragment by `$STACK` before agent dispatch. Currently the slim-prompt pattern (execution-model.md:280-303) makes the agent load its own slice, so this T3 language only appears in the agent's worldview if the agent's `.md` declares it. **Lower friction than it looks** — the orchestrator already passes only wave-plan + phase + wave number. |
| `scripts/bin/wave-plan-build:43-49` `PATH_RE` regex top-level dirs | Limited to `apps|packages|tooling|scripts|commands|skills|agents|rules|openspec|docs|infrastructure|infra` | Add `swift|Sources|Tests|...` or generalize to "any top-level dir with a recognized file extension". |
| `scripts/bin/wave-plan-build:56-61` `KNOWN_PATH_EXTENSIONS` | Extension list omits `.swift`, `.gradle`, `.kt`, `.go` (go.mod paths leak through though) | Add per-stack extensions or detect at runtime from a stack-profile manifest. |
| `commands/apply.md:407` | `pnpm tsc --noEmit` for full verification | Same as row 1 — single-spec Phase 4 is t3-pinned. |
| `commands/apply/all.md:403` | Validation allowlist `t3, t3-turbo, t3-docker, effect, meta` | Should derive from `stack-detect.sh` valid return values OR from a `~/.claude/stack-profiles/index.json` registry. Drift is inevitable today. |
| `scripts/bin/stack-detect.sh:36-37,41-42` | Returns `t3-turbo`/`t3-docker` while dispatch only knows `t3` | **The most acute drift.** Either `apply/all.md` and `stacks.md` need to learn `t3-turbo` as the canonical name, OR `stack-detect.sh` needs to normalize. |
| `commands/apply/all.md:1067-1072` (Phase 6 validation table) | `pnpm tsc --noEmit`, `rm -rf .next` | Stack-agnostic Phase 6 = per-stack `verify_full` library. Same as apply.md:405. |

**Indirect assumption**: the proposal-pattern detection (`execution-model.md:39-90`) lists Patterns A–F based on T3 vocabulary. Adding a Swift-only stack profile would not invalidate this, but the heuristic "Pattern C = config/infra" catches Swift-only proposals only by accident.

---

## Documentation Health

**Q7: Are there docs that already describe how to ADD a new stack profile?**

**Yes — three documents, partially complete, partially out-of-sync:**

| Doc | Coverage | Accuracy |
|---|---|---|
| `commands/apply/references/stacks.md:298-302` "Adding a new stack" | 3-step checklist: add profile section, extend `detect_stack()`, verify T3 backward-compat | **Accurate but underspecified.** Doesn't mention: `apply/all.md:611-627` switch, validation allowlist, `execution-model.md` keyword updates, phases.md translation table. Three steps where there should be six. |
| `commands/apply/references/phases.md:185-198` "Adding a new stack profile" | 5-bullet checklist for documentation update + sister-change discipline (Foundation/Interface/Consumer/Verification artifact mapping) | **Accurate for the philosophical layer**, doesn't cover the executable wiring. Says "enforcement is by review checklist, not automated" — acknowledges the gap. |
| `commands/apply/references/stacks.md:280-296` "Profile lookup contract" | Describes `PROFILE_AGENT_MAP[$STACK][$PHASE]` as a key-lookup abstraction | **Aspirational** — no such object exists in code. The actual implementation is a switch-case. Misleading. |

**Gaps in existing docs**:

1. No doc lists ALL the call sites that need updating (the cross-reference is missing).
2. The "Profile lookup contract" claim creates a false impression of registry-driven dispatch.
3. The stack-detect drift (canonical lib returns `t3-turbo`, dispatch expects `t3`) is undocumented.
4. No test scaffolding documented — "verify backward compatibility" (stacks.md:301) is a manual instruction.

**How to author a correct doc**: a single `commands/apply/references/adding-a-stack.md` consolidating the 6-step real checklist (detection + dispatch + gate + validation + classification + phase-translation + skill-loading-by-agent), with file:line cross-references, and a test recipe (run `phase1-bootstrap` against a synthetic project, assert detected stack matches expected dispatch).

---

## Refactor vs Extend Decision Surface

Three viable approaches for the toolchain extensibility work:

### Option A: Extend in place

**What changes**:
- Append `## Profile: swift-bun-hybrid` section to `stacks.md`.
- Add detection block to `scripts/lib/stack-detect.sh`.
- Add `case swift-bun-hybrid)` branches to (i) `apply/all.md:611-627`, (ii) `stacks.md:322-413`, (iii) validation allowlist `apply/all.md:403`.
- Add translation row to `phases.md`.
- Audit `execution-model.md` keyword/path fallbacks; add Swift terms if needed.

**Risk**:
- **Drift propagates.** Every new stack widens the case statements across 3+ files. The 11-project T3 fleet must keep working — any rename of `t3` → `t3-turbo` is a blast radius event.
- **No regression test.** Today nothing prevents a contributor from updating `stack-detect.sh` without updating the dispatch allowlist.
- **Documentation rot.** `stacks.md` "Adding a new stack" checklist is 3 steps; the actual work is 6.

**Estimated effort**: 2–3 hours per new stack (Swift-Bun-Hybrid would be ~3 since Swift conventions don't match T3 path/keyword patterns).

### Option B: Refactor into dedicated stack-profiles skill (or `~/.claude/stack-profiles/`)

**What changes**:
- Extract stack detection signal cascade into `~/.claude/stack-profiles/<stack>/detect.sh` (each profile owns its own probe).
- Extract per-stack phase→agent map + gate command into `~/.claude/stack-profiles/<stack>/profile.json` consumed by both `apply/all.md` and the gate runner.
- Replace `case "$STACK"` switches with `profile_lookup "$STACK" agent "$PHASE"` shell helper.
- `stacks.md` becomes prose-only doc referencing the JSON registries.
- Validation allowlist auto-derives from `ls ~/.claude/stack-profiles/`.
- Add a regression test: `tests/stack-profiles.bats` asserting every profile defines DB/API/UI/E2E/DOC rows and that `phase1-bootstrap` returns a valid profile ID for each canonical project shape.

**Risk**:
- **Blast radius is wide.** Every `/apply` and `/apply:all` invocation passes through the new lookup helper; bug there breaks the 11-project T3 fleet.
- **Backward compat for T3.** Must guarantee the `t3` profile behaves identically post-migration. Probably needs a behavioral-diff test suite.
- **Effect/meta stack profiles must also be migrated** — small risk but real work.

**Estimated effort**: 1–2 days (1 day to extract + migrate t3/effect/meta to JSON profiles, 0.5 day for the regression test, 0.5 day for cross-reference updates and helper wiring).

### Option C: Ship as standalone opt-in skill

**What changes**:
- Create `~/.claude/skills/stack-profile-swift/SKILL.md` declaring the Swift profile.
- Modify the orchestrator to optionally consult `Skill({ skill: "stack-profile-<detected>" })` when `$STACK` is in a known-extension set.
- T3 / Effect / Meta stay in `stacks.md` switch (zero migration risk).
- New stacks live as skills; documentation discoverability via the skill catalog.

**Risk**:
- **Discoverability problem.** Projects must explicitly opt in (or detection must know to look up the skill).
- **Two parallel registration paths** (core stacks in `stacks.md`, opt-in stacks as skills). Engineers must remember the split.
- **Skill-loading happens inside agents, not orchestrator.** Plumbing the stack profile from orchestrator-side detection into per-phase dispatch via a skill is awkward — skills are tooling for agents, not configuration data for orchestrators.

**Estimated effort**: half day for the skill scaffold, but the orchestrator integration is non-trivial; likely results in worse coupling than Option A.

---

## Recommendation

**Pick Option B (refactor into a registry).** The current system has all the symptoms of a switch-case grown beyond its capacity: two competing detection implementations, an aspirational "lookup contract" in prose that has no executable backing, three places to edit when adding a stack, and a 3-step doc checklist describing 6 actual steps. The friction will compound — every additional stack expands the case statements and widens the drift surface. Option A keeps shipping technical debt; Option C creates a two-path discoverability problem. Option B is one focused day of work that converts the implicit registry-as-switch-case into an explicit JSON-backed registry with regression coverage, and the T3 fleet behavior is preserved by construction (the t3 profile JSON encodes exactly what the current case statement does). The DECISION child (nx-51k5q) should additionally consider whether `stack-detect.sh` returning `t3-turbo` while dispatch expects `t3` is a hot bug worth a hot-patch before the refactor lands — that drift is reachable today and silently routes T3-Docker projects through the t3-default branch.
