# Design: Provider-Keyed Integration Credential Registry

## Why a design doc
This spans four systems (DB schema, a new agent-side registry pattern, generic HTTP routes, and
a dashboard route) and introduces a pattern future providers are expected to follow — worth
pinning down the descriptor shape once rather than re-deriving it per implementer.

## ProviderDescriptor shape (agent-side, not shared to the browser)

```ts
// apps/agent/src/integrations/registry.ts
interface ProviderDescriptor {
  provider: string;                 // registry key, e.g. "telegram"
  metadataSchema: ZodSchema;        // validates the JSONB `metadata` column on PATCH
  testProbe: (
    secret: string,
    metadata: Record<string, unknown>,
  ) => Promise<{ ok: boolean; statusCode: number | null }>;
}

const PROVIDER_DESCRIPTORS: Record<string, ProviderDescriptor> = {
  telegram: {
    provider: "telegram",
    metadataSchema: integrationMetadataSchemas.telegram, // from @nexus/core
    testProbe: async (secret) => {
      const res = await fetchWithTimeout(
        `https://api.telegram.org/bot${secret}/getMe`,
        { method: "GET", timeout: 5_000 },
      );
      return { ok: res.ok, statusCode: res.status };
    },
  },
};
```

`testProbe` is a function and therefore lives agent-side only — it is never sent to the browser.
The dashboard doesn't need it: the generic route already runs it server-side and returns
`{ ok, statusCode }`.

## What crosses to the dashboard vs. what stays agent-side

| Concern | Lives in | Why |
|---|---|---|
| Wire shapes (`GET`/`PATCH` request/response Zod schemas) | `packages/core/src/types/integrations.ts` | Shared contract, same convention as `packages/core/src/types/elevenlabs.ts` |
| `metadataSchema` per provider | `packages/core` (imported by both the agent registry and, where useful, client-side form validation) | Pure data — no functions, safe to share |
| `testProbe` implementation | `apps/agent/src/integrations/registry.ts` only | Calls an upstream API with the decrypted secret; must never run in the browser |
| Which React panel renders for a given provider | `apps/web/src/app/integrations/[provider]/PROVIDER_UI_REGISTRY` | Client-side routing concern; deliberately NOT auto-generated from `metadataSchema` — see below |

## Why the UI stays a per-provider component, not a schema-driven form generator

The tempting "fully generic" version renders a form directly from `metadataSchema` (walk the Zod
shape, emit an input per field). Rejected for this pass: with exactly one registered provider
(Telegram) there is no second data point to design a form-schema interpreter against, and a
schema-driven form generator is real speculative complexity (violates the Reader Gate's
"no abstraction to prepare for future changes" bar) with only one caller. The generic surface
that *is* justified — because it has two real, pre-existing consumers (ElevenLabs's shipped
`MaskedKeyInput` pattern and Telegram's new panel) — is: one dynamic route file, one small
`PROVIDER_UI_REGISTRY` lookup, and hand-authored panels that reuse shared field components. When
a third provider lands, if its panel turns out to be structurally identical to Telegram's, *that*
is the trigger to extract a shared form component — not before.

## Sequencing note

DB schema (new table) has no dependency on anything else in this change and can be generated
first. The registry (`apps/agent/src/integrations/registry.ts`) depends on the `packages/core`
wire types existing (for `metadataSchema` reuse) but not on the routes. The routes depend on both
the schema and the registry. The Telegram channel change in `notifications/router.ts` depends only
on the schema + decrypt helper (not on the HTTP routes) and can be built in parallel with the UI
once the schema lands. The UI depends on the routes being live to fetch against.
