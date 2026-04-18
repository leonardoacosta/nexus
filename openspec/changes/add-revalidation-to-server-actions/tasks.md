# Implementation Tasks

<!-- beads:epic:nx-stcy -->

## DB Batch

(none)

## API Batch

- [x] [1.1] [P-1] Add revalidatePath('/projects') and revalidatePath(`/projects/${name}`) to updateProject in apps/nextjs/src/app/actions/projects.ts after the HTTP call succeeds [owner:api-engineer] [beads:nx-8go0]
- [x] [1.2] [P-1] Add revalidatePath('/settings') to saveAgentConfig add and delete branches in apps/nextjs/src/app/actions/settings.ts after the HTTP call succeeds [owner:api-engineer] [beads:nx-83kj]
- [x] [1.3] [P-2] Verify both action routes use dynamic rendering (force-dynamic or noStore-bounded fetches); if statically prerendered, add `export const dynamic = 'force-dynamic'` to the page or wrap data fetches in `unstable_noStore()` [owner:api-engineer] [beads:nx-sn7y]

## UI Batch

(none)

## E2E Batch

- [ ] [2.1] Add unit test in apps/nextjs/src/app/actions/projects-mutation.test.ts asserting updateProject calls revalidatePath with the correct paths after success [owner:e2e-engineer] [beads:nx-g4wd]
- [ ] [2.2] Add unit test in apps/nextjs/src/app/actions/settings-mutation.test.ts asserting saveAgentConfig calls revalidatePath('/settings') after success and on the delete branch [owner:e2e-engineer] [beads:nx-6h29]
- [ ] [2.3] Verify revalidate is NOT called when the underlying HTTP call fails (errors should propagate without fake-success cache invalidation) [owner:e2e-engineer] [beads:nx-sac6]
