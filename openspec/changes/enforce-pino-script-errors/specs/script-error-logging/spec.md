## ADDED Requirements

### Requirement: every script entrypoint SHALL use the shared Pino logger

All script entrypoints in `apps/`, `scripts/`, and `deploy/` SHALL import `createLogger` from `@nexus/core/node` and use the returned logger for all output. `console.log`, `console.error`, etc. SHALL NOT appear in any script.

#### Scenario: audit finds zero console.* calls
- **GIVEN** the audit is complete
- **WHEN** `grep -r 'console\\.\\(log\\|warn\\|error\\)' apps/ scripts/ deploy/`
- **THEN** zero matches

### Requirement: WARN+ log entries SHALL persist to script_errors table

A Pino transport SHALL write WARN+ log entries to the new `script_errors` table with columns `(ts, script, level, message, error_class, stack, context_json)`.

#### Scenario: warn entry creates a script_errors row
- **GIVEN** the DB transport is configured
- **WHEN** a logger emits `log.warn({foo: 'bar'}, 'something failed')`
- **THEN** one row appears in `script_errors` with `level='warn'`, `message='something failed'`, `context_json` containing `{foo: 'bar'}`

### Requirement: script main() SHALL be wrapped in withErrorCapture

Every script entrypoint SHALL invoke its `main()` via `withErrorCapture(async () => main())` from `@nexus/core/node`. Uncaught exceptions SHALL be persisted as ERROR-level `script_errors` rows before re-raising.

#### Scenario: script crash is queryable
- **GIVEN** withErrorCapture is wired
- **WHEN** a script throws an uncaught exception
- **THEN** one `script_errors` row exists with `level='error'`, `error_class` matching the exception type, and `stack` populated
