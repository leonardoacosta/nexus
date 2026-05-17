/**
 * cc-credential-manager — Claude Code credential tracking (placeholder).
 *
 * This file is the interim landing pad for the `collapse-credentials-dir`
 * change (P1 consolidation). Full implementation arrives in P4.6
 * (`add-cc-credential-manager`) once P4.5 (`swift-owns-elevenlabs-synth`)
 * removes the ElevenLabs surface and the `credentials/` directory is
 * collapsible.
 *
 * Today the agent still routes credential management through
 * `apps/agent/src/credentials/` (pool, encryption, watchers, token-stream,
 * ElevenLabs runtime, HTTP routes). This stub exists so consumers can begin
 * migrating imports incrementally; it intentionally re-exports the active
 * surface from the legacy directory to avoid an all-or-nothing flip.
 *
 * Do NOT add new behavior here without coordinating with P4.6.
 */

// Re-export the active-credential watcher snapshot type and accessor — the
// most stable piece of the credentials surface. Other surfaces will migrate
// in P4.6 once their dependencies (DB schema, ElevenLabs removal) are gone.
export {
  getActiveCredentialSnapshot,
  type ActiveCredentialSnapshot,
} from "./credentials/active-credential-watcher";
