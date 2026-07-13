/**
 * Shared model → family-letter mapping.
 *
 * Single canonical source for deriving the compact single-letter model family
 * tag (F/O/S/H) used by the statusline row and any nx consumer that renders a
 * session's model (Swift dashboard rows, `GET /statusline`). Ported verbatim
 * from `apps/nexus-statusline/src/render.ts` so there is one mapping, not two —
 * `render.ts` now imports this instead of keeping a local copy.
 *
 * Spec: openspec/changes/add-session-model-authority/
 */

/** Family letter keyed by substring found in model.id / display_name. */
const MODEL_FAMILIES: ReadonlyArray<readonly [string, string]> = [
  ["fable", "F"],
  ["opus", "O"],
  ["sonnet", "S"],
  ["haiku", "H"],
];

/**
 * Family letter for a model (from `model.id`, `display_name` fallback; unknown
 * family → uppercased `display_name` initial, falling back to `id`'s initial).
 * No model, or a model with neither `id` nor `display_name`, → `null`.
 */
export function modelFamilyLetter(
  model?: { id?: string; display_name?: string },
): string | null {
  if (!model) return null;
  const id = model.id ?? "";
  const dn = model.display_name ?? "";
  if (!id && !dn) return null;

  const hay = `${id} ${dn}`.toLowerCase();
  for (const [fam, l] of MODEL_FAMILIES) {
    if (hay.includes(fam)) return l;
  }
  const initial = dn.trim().charAt(0) || id.trim().charAt(0);
  return initial ? initial.toUpperCase() : null;
}
