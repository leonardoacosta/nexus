## ADDED Requirements

### Requirement: Cache revalidation on mutation

All Server Actions in `apps/nextjs/src/app/actions/` that perform mutations against the agent HTTP API MUST call `revalidatePath()` (or `revalidateTag()` if a tag scheme is adopted) for every route that renders the mutated data, BEFORE returning to the caller. Revalidation MUST only fire when the underlying mutation succeeds — failures must propagate to the caller without invalidating cache.

#### Scenario: Project tag update reflects in UI immediately

- **GIVEN** a user updates a project tag via the dashboard's project detail page
- **WHEN** the Server Action `updateProject` returns successfully
- **THEN** the next render of `/projects` and `/projects/[name]` MUST display the new tag without requiring a hard navigation

#### Scenario: Agent config add reflects in settings UI immediately

- **GIVEN** a user adds or removes an agent config in the dashboard's settings page
- **WHEN** the Server Action `saveAgentConfig` returns successfully
- **THEN** the next render of `/settings` MUST display the updated agent list

#### Scenario: Failed mutation does NOT invalidate cache

- **GIVEN** a Server Action mutation that fails (HTTP non-2xx or network error)
- **WHEN** the action returns or throws
- **THEN** `revalidatePath` MUST NOT have been called, and the cache MUST remain valid for the prior data
