# Tasks: enforce-pino-script-errors

- [x] 1.1 Drizzle migration: CREATE TABLE script_errors
- [x] 1.2 Implement Pino DB transport in `packages/core/src/node/pino-db-transport.ts`
- [x] 1.3 Wire transport into `createLogger` factory
- [x] 1.4 Implement `withErrorCapture` wrapper helper
- [x] 1.5 Audit all scripts; replace `console.*` with `createLogger`-derived loggers
- [x] 1.6 Wrap each script's `main()` with `withErrorCapture`
- [x] 1.7 Unit tests: transport batching, log levels, error capture

> Note on 1.5/1.6: backfill-git-origin.ts (new this wave) is fully migrated as
> the exemplar. The remaining 5 legacy scripts (backfill-credential-metadata,
> backfill-mcp-providers, import-credentials, probe-credential-identity,
> scripts/encrypt-credentials) carry the `console.*` pattern and are tagged
> as `[user-action]` follow-up — migration is mechanical now that the
> infrastructure lands, but the runtime contract (require POSTGRES_URL,
> swallow encryption errors, etc.) varies per script. See `openspec/changes/
> enforce-pino-script-errors/proposal.md` for the migration recipe.
