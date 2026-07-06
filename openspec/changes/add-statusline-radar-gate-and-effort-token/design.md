# Design — add-statusline-radar-gate-and-effort-token

## Context

`getRoadmapPulse` (`apps/nexus-statusline/src/index.ts`) serves a per-project cached line
(`~/.claude/scripts/state/roadmap-pulse.<code>.line`, 5-min stale-while-revalidate, detached
refresh spawn of cc's `roadmap-pulse --line`) and `renderStatusline` appends it verbatim as
trailing rows. Radar content reaches the statusline in two shapes, both produced cc-side:

| Shape | Example (live nx cache, 2026-07-05) | Lexically identifiable? |
| --- | --- | --- |
| Counts token | `7o,radar:stale` | Yes — exact token `radar:stale` in the comma-CSV counts row |
| Radar-sourced `next:` (rung 1: overdue human-waiting ask) | `next: reply Fireball/fireball (...` | No — the 28-char truncation cuts the `(Nd waiting)` signature; `next: reply ` prefix would false-positive on a bead titled "reply ..." |

## Goals / Non-Goals

- Goals: no radar-derived content on non-B&B projects; denser row one (model+effort token,
  absolute context usage); keep the statusline crash-safe and <2s render contract intact.
- Non-Goals: changing cc's roadmap-pulse in this repo; authoring B&B project.toml manifests;
  re-implementing pulse "next" precedence in nx.

## Decision 1 — Gating source: what marks a project as B&B?

| Option | Mechanics | Trade-off |
| --- | --- | --- |
| A. `project.toml` `[project].org` key only | Regex-parse `<projectDir>/.claude/project.toml` for `org = "bb"` (same no-TOML-dep regex approach as `getLocalAgentUrl` on `agents.toml`) | Right long-term signal, but the key does not exist in cc's schema today (`[project]` = `name`/`code`/`schema` only; "bb fleet" appears only in `[git].push` prose) and NONE of the 13 B&B repos has a project.toml (verified 2026-07-05) — gate would be dead on arrival |
| B. Hardcoded allowlist only | `ws fb dc se tb sc ba bo es ew ic lu pp` matched against the derived project code | Works today; but a new B&B repo requires an nx source edit + binary rebuild/redeploy |
| C. **Both: toml authoritative, allowlist fallback (RECOMMENDED)** | If the file exists and `[project].org` is present, `org == "bb"` decides; otherwise fall back to the allowlist | Ships working today on the allowlist, self-heals repo-by-repo as manifests land (no nx rebuild once a repo declares `org`), and the toml override lets a future repo opt in/out without touching nx |

**Chosen: C.** The org key becomes the durable contract; the allowlist is the bootstrap. The
`org` key itself is a proposed addition to cc's `project-toml-schema.md` (cross-repo note in
proposal Impact). Failure posture: unreadable/absent toml + code not in allowlist → non-B&B
(radar hidden by default; a false-hide on a B&B repo is low-cost, a false-show on a screen-shared
personal repo is the failure Leo is closing). All reads wrapped, never throw.

## Decision 2 — Gate application point: where does radar content get dropped?

| Option | Trade-off |
| --- | --- |
| a. Lexical filter of the cached `--line` text in nx | Only robust for the `radar:stale` token; the radar-sourced `next:` row has no stable signature post-truncation (see table above) — rejected as the sole mechanism |
| b. Switch the cache to `roadmap-pulse --json` and compose rows in nx (JSON has `next.source == "radar"` + structured `radar`/`openspec` blocks) | Robust attribution, BUT dropping a radar-sourced `next` consumer-side leaves non-B&B projects with NO `next:` at all — recomputing the fallback would mean re-implementing roadmap-pulse's 7-rung precedence in nx. Duplicating producer logic violates cc's scripts-as-data-producers convention. Rejected |
| c. **Producer-side skip via env flag + nx token guard (RECOMMENDED)** | nx passes `PULSE_RADAR=0/1` on the existing refresh spawn (the spawn already sets `cwd: projectDir`); cc's roadmap-pulse skips rung 1 + radar counts when `0`, so rungs 2-7 correctly backfill `next:`. nx additionally strips the exact `radar:stale` token at render — covers the 5-min stale-cache window and roadmap-pulse versions predating the flag |

**Chosen: c.** The producer is the only place that can drop radar AND still compute the next-best
suggestion. Honest limitation, stated in the proposal: until cc's script honors `PULSE_RADAR`,
a radar-sourced `next: reply ...` row can still leak on non-B&B projects; the `radar:stale`
token is hidden from day one. The cc follow-up is filed as a task (4.1), not assumed.

## Decision 3 — Model/effort token: replace or add alongside?

Current row one renders `shortenModel(display_name)` — just the version number (`"Fable 5"` →
`"5"`, runtime-verified) — and the pending `update-statusline-cc-metadata` change would add a
separate DIM effort tag (`xhigh`) next to it. Landing both plus a new `Fxh` token would say the
same thing three ways (`5 xhigh Fxh`).

**Chosen: the combined token REPLACES the model segment and supersedes the pending standalone
effort tag.** Leo specified the exact token format (`Fu`, `Fh`, `Ou`, `Om`, `Sxh` — no version
digit), and row-one budget is the scarce resource. The version number is dropped from the
statusline (still visible in `/status`). Alternative (keep `5` + add `Fh`) rejected as duplicate
signal.

Mapping:

- Letter from `model.id` family substring (`fable`→`F`, `opus`→`O`, `sonnet`→`S`, `haiku`→`H`),
  falling back to the first word of `display_name`; unknown family → first letter of
  `display_name` uppercased; no model → no token (effort alone never renders).
- Suffix from `effort.level`: `low`→`l`, `medium`→`m`, `high`→`h`, `xhigh`→`xh`, `max`→`u`
  (also map a literal `ultracode` → `u` defensively); absent or unrecognized → letter alone.
  The documented enum is `low, medium, high, xhigh, max` (cc-practices-current features.md,
  which also confirms "Status line stdin includes `effort.level`").

## Decision 4 — Context usage rendering

Extend the existing CTX gauge suffix (currently `NN%` remaining) with approximate absolute usage
when `context_window.context_window_size` is present:
`used_k = round(used_percentage / 100 x context_window_size / 1000)` rendered as
`84k/200k`. No new segment — same gauge, denser suffix. When `context_window_size` is absent,
the current %-only render is unchanged.

## Risks / Trade-offs

- Allowlist drift (new B&B repo missing) → radar hidden there until the list or a manifest is
  updated; low-cost failure direction (see Decision 1).
- `PULSE_RADAR` ignored by current roadmap-pulse → partial gate until the cc follow-up ships
  (Decision 2); the flag name is reserved by this spec so both sides converge on it.
- Derived token count is approximate (percentage rounding) → displayed with no decimal places;
  swap to a real field if CC ever ships one.

## Open Questions

1. **No direct used-token field in the CC payload.** The canonical statusline payload provides
   `context_window.used_percentage` and `context_window.context_window_size` only; the old
   `used_tokens`/`max_tokens` type members were never in any documented schema and are being
   removed by `update-statusline-cc-metadata`. Absolute usage is therefore derived
   (`used_percentage x context_window_size`), not read. If CC ships a real used-token count,
   replace the derivation.
2. **Wire value for the ultracode tier.** The settings enum documents `max` as the top level and
   `/effort ultracode` exists as a phrase; whether the statusline payload reports `max`,
   `ultracode`, or both is unverified — implementation task 2.4 must capture a real payload
   under ultracode and paste it as evidence. Both values map to `u` regardless.

   **Status (2026-07-06, wave-2 apply): UNCONFIRMED.** No live ultracode/max statusline stdin
   payload was available during implementation — statusline stdin is not persisted, and a scan
   of `~/.claude/scripts/state/` + `~/.claude/projects/*/*.jsonl` transcripts surfaced no
   `effort.level` wire value (the only `"effort"` hits are an unrelated audit-plan-bundle field
   carrying `L`/`M`). Per the no-fabrication rule, the observed value is left blank rather than
   guessed. The implementation defensively maps BOTH `max` and `ultracode` → `u`, so the token is
   correct regardless of which string CC actually emits; task 2.4 stays unchecked until a real
   payload is captured. To capture: run a `/effort ultracode` (or `max`) session and log the
   statusline stdin JSON, then paste the observed `effort.level` here.
3. **`[project].org` key does not exist yet** in cc's `project-toml-schema.md`, and no B&B repo
   has a `project.toml`. This change reserves the key shape (`org = "bb"`); schema addition +
   manifest authoring are cc-side follow-ups.
4. **cc `roadmap-pulse` `PULSE_RADAR` support** is a cross-repo dependency for hiding the
   radar-sourced `next:` row (Decision 2). Filed, not implemented here.
