# Design Notes — add-elevenlabs-credential

## Why a design.md
This change touches three subsystems (DB schema with crypto, agent runtime that already has a fragile env-driven path, dashboard page with masked-input semantics) and reuses three patterns from older capabilities. Capturing the reasoning here prevents the implementation pass from re-litigating decisions that were made deliberately.

## Schema decisions

### Mirror the `credentials` table, do not extend it
The existing `credentials` table is OAuth-shaped: `subscriptionType`, `rateLimitTier`, `expiresAt`, `accountIdentifier`, etc. ElevenLabs uses bearer-token auth with a quota meter, not refresh tokens. Folding ElevenLabs into the same table would force every column to be nullable for one provider or the other and would make the per-row semantics confusing.

A separate `elevenlabs_credentials` table:
- Reuses `value_encrypted` + `encryption_key_id` column names so it's instantly recognizable to anyone who has read the existing schema
- Avoids the `type` discriminator pattern that would push us toward a row-polymorphic table no one likes maintaining
- Sets up cleanly for the next slice (`elevenlabs-usage`) which adds quota poll history without bloating the OAuth `credentials` table

### Single row per agent, not a pool
For the homelab use case there's one user, one ElevenLabs account, one quota meter. Modeling this as a pool with primary-selection logic would solve a problem no one has and burn a week on plumbing. If we ever add multi-account ElevenLabs, the migration is trivial: drop the unique constraint on `agent_id`, add a `is_primary` column, and reuse the `credential-pool` watcher pattern.

### Voice metadata stored alongside the key
We could split this into a separate `elevenlabs_voice_settings` table, but the voice ID has identical lifetime semantics to the API key (changes only when the user opens the dashboard). Storing both in the same row keeps reads to a single SELECT and avoids JOINs in the hot TTS dispatch path.

## Crypto reuse

### Why not invent new helpers
`apps/agent/src/credentials/encryption.ts` already provides `encrypt(plaintext, key) -> base64String` and `decrypt(ciphertext, key) -> plaintext` using AES-256-GCM with a per-record nonce. The format is `base64(nonce ‖ ciphertext ‖ authTag)`. Adopting it as-is means:
- Operators who already understand the existing crypto don't need to learn a second pattern
- Master key rotation (when we eventually do it) flows through one code path, not two
- The `encryption_key_id` column gives us forward-compatibility with future key versions for free

### Master key resolution path
`startServer()` accepts `options.encryptionKey: Buffer` and threads it through `initCredentialRoutes`. We extend the same pattern: a `getElevenlabsCredentialPool()` factory holds a reference to the same key buffer. No new env var is introduced — the existing `NEXUS_ENCRYPTION_KEY` covers both pools.

## Agent live-reload semantics

### No in-memory cache of the API key
The simplest reactive pattern would be to subscribe to a `lifecycleBus.emit("CredentialsChanged")` event from PATCH and invalidate an in-memory cache. We're explicitly NOT doing that.

Rationale:
- TTS dispatches fire <1/min in normal use; the cost of reading one indexed row is negligible (~1ms)
- Eliminating the cache eliminates an entire class of staleness bugs ("I rotated the key but synth still uses the old one")
- The cache adds plumbing (subscribe, invalidate, race conditions on concurrent rotations) for zero observable latency improvement

If we ever measure DB pressure from this, we can add a 5-second TTL cache without changing the spec.

### What about restart-without-restart for the env-var path?
The env-var fallback is read on every dispatch via `process.env.ELEVENLABS_API_KEY` directly — Node's process.env is mutable but never mutated by anyone in this codebase. So the env-fallback path is also implicitly hot-reloadable in the (unlikely) case the operator wants to `kill -SIGUSR1` and reload secrets.

## Endpoint shape decisions

### GET masks the key entirely
The masked GET response includes `hasKey: boolean` rather than `apiKeyPreview: string`. Showing the last 4 characters is a common pattern but offers little real security benefit and gives a phisher a fingerprint. The tradeoff in UX is minor: the dashboard shows "•••••••" until the user pastes a new value.

### POST /test instead of GET /test
A test against ElevenLabs is a side-effecting operation (it consumes one API call against the user's account, even though `/v1/user` doesn't burn character quota). REST semantics call for POST when the operation has side effects. The body is empty; the action is on the resource itself.

### Voice list is cached at the agent, not the dashboard
A 1-hour in-memory cache at the agent layer means the dashboard never has to know whether to show a stale list. The agent owns the truth, the dashboard renders what the agent gives it. This matches the existing pattern where the credentials page reads from `/credentials/active` rather than the dashboard caching the raw `~/.config/nexus/credentials/` directory listing.

## Dashboard surface

### Why /integrations/elevenlabs (not /settings or /credentials)
- `/credentials` is the existing Anthropic OAuth page — overloading it would conflate two unrelated credential models
- `/settings` is for agent-level toggles (notification settings, agent management, command editor)
- `/integrations` is greenfield and matches the pattern that the next two specs (`elevenlabs-usage`, `elevenlabs-dashboard`) will extend with `/integrations/elevenlabs/usage` and richer detail views

### Masked input over visible-with-toggle
A "show password" toggle is appropriate for forms where the user typed the value into the same form. In our case the user is inspecting a value they pasted in some prior session — there's no scenario where they need to read it back. A pure-mask input is simpler and removes a small foot-gun (clicking "show" before sharing the screen).

## What's deferred (and why)

| Deferred | Lands in | Reason |
|----------|----------|--------|
| Quota timeline + `tts_usage_polls` | `add-elevenlabs-usage` | Needs the credential row to exist first. Splitting keeps the credential PR small enough to review carefully. |
| Notification-history filtered to TTS deliveries | `add-elevenlabs-dashboard` | Needs both credential row + usage table. The third spec is the thinnest of the three because by then the data layer is done. |
| Multi-key pool + auto-rotation | Maybe never | One user, one account, one quota meter. YAGNI. |
| Voice preview / sample synthesis | Not scheduled | Costs ~5 chars per click against the user's quota. Add only if the empty-state UX feels janky after launch. |
| Cross-agent management from a single dashboard | Not scheduled | Each agent currently owns its own page state. Cross-agent flows are a different problem (federation, auth) that this spec deliberately doesn't open. |
