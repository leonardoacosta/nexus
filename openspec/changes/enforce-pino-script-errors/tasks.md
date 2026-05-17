# Tasks: enforce-pino-script-errors

- [ ] 1.1 Drizzle migration: CREATE TABLE script_errors
- [ ] 1.2 Implement Pino DB transport in `packages/core/src/node/pino-db-transport.ts`
- [ ] 1.3 Wire transport into `createLogger` factory
- [ ] 1.4 Implement `withErrorCapture` wrapper helper
- [ ] 1.5 Audit all scripts; replace `console.*` with `createLogger`-derived loggers
- [ ] 1.6 Wrap each script's `main()` with `withErrorCapture`
- [ ] 1.7 Unit tests: transport batching, log levels, error capture
