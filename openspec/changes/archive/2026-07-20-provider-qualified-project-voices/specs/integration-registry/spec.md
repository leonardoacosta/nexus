# integration-registry — Delta

## ADDED Requirements

### Requirement: Providers MAY expose a generic voice listing endpoint
A `ProviderDescriptor` MAY supply an optional `listVoices(secret, metadata)` async function
returning `{ ok: boolean, statusCode: number | null, voices: unknown[] }` that never throws.
The agent MUST expose `GET /integrations/:provider/voices`, generically dispatched off the
registry: a descriptor without `listVoices` returns HTTP 404; a provider whose listing needs
stored metadata but has no row returns HTTP 400. The `kokoro` descriptor MUST implement
`listVoices` via `GET {baseUrl}/v1/audio/voices` with a 5-second timeout. The bespoke
ElevenLabs voice proxy (`elevenlabs-voices.ts`) is out of scope and unchanged.

#### Scenario: Kokoro voices proxy through the generic endpoint
Given a `kokoro` row exists with a reachable `baseUrl`
When GET `/integrations/kokoro/voices` is called
Then the response contains the voice list returned by `{baseUrl}/v1/audio/voices`

#### Scenario: Provider without voice listing returns 404
Given the `telegram` descriptor has no `listVoices`
When GET `/integrations/telegram/voices` is called
Then the response is HTTP 404

#### Scenario: Missing row returns 400
Given no `kokoro` row exists for the agent
When GET `/integrations/kokoro/voices` is called
Then the response is HTTP 400 and no upstream request is made
