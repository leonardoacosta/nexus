# safe-spawn-wrapper Specification

## Purpose
TBD - created by archiving change finalize-audit-cleanup. Update Purpose after archive.
## Requirements
### Requirement: Binary allowlist

`@nexus/core/safe-spawn` SHALL expose a `safeSpawn(binary, args, opts)` function that rejects any `binary` not in the `ALLOWED_BINARIES` constant. The allowlist SHALL include `tmux`, `git`, `claude`, `ssh`, `bash`, `cat`, `nexus`.

#### Scenario: Allowed binary

- **WHEN** `safeSpawn('tmux', ['new-session', '-d'])` is called
- **THEN** the function SHALL return a `SafeSpawnHandle`
- **AND** the spawned process SHALL be running

#### Scenario: Disallowed binary

- **WHEN** `safeSpawn('rm', ['-rf', '/'])` is called
- **THEN** the function SHALL throw a `DisallowedBinaryError`
- **AND** the error message SHALL reference the `ALLOWED_BINARIES` constant location

### Requirement: Arg validation

`safeSpawn` SHALL reject any argument containing shell metacharacters (`; & | $ \` \n \r`) unless the caller passes `opts.trustArgs === true`.

#### Scenario: Clean args

- **WHEN** `safeSpawn('tmux', ['new-session', '-s', 'my-project'])` is called
- **THEN** the spawn SHALL succeed

#### Scenario: Arg contains shell metacharacter

- **WHEN** `safeSpawn('tmux', ['new-session', '-s', 'proj;rm -rf /'])` is called without `trustArgs`
- **THEN** the function SHALL throw an `UnsafeArgError`
- **AND** the error SHALL identify the rejected arg

#### Scenario: trustArgs escape hatch

- **WHEN** `safeSpawn('bash', ['-c', userScript], { trustArgs: true })` is called
- **THEN** the spawn SHALL succeed regardless of metacharacters
- **AND** callers using `trustArgs` SHALL be findable by grep for audit purposes

### Requirement: Handle shape

`safeSpawn` SHALL return a `SafeSpawnHandle` with `pid`, `stdout`, `stderr`, `stdin`, `exitCode` (Promise), and `abort(signal?)` method.

#### Scenario: Consumer reads stdout incrementally

- **GIVEN** a long-running PTY process spawned via `safeSpawn`
- **WHEN** the caller reads from `handle.stdout` in a loop
- **THEN** each chunk SHALL arrive as the process writes it
- **AND** `handle.exitCode` SHALL resolve only when the process terminates

#### Scenario: Consumer cancels via abort

- **GIVEN** a running process spawned via `safeSpawn`
- **WHEN** the caller invokes `handle.abort()`
- **THEN** the process SHALL receive SIGTERM
- **AND** `handle.exitCode` SHALL resolve within 5 seconds

### Requirement: Production site migration

All production-path `exec/spawn` calls in `apps/agent/` SHALL migrate to `safeSpawn`. Test files MAY continue to use `child_process` directly (covered by `autoSkipTestFiles`).

#### Scenario: pty-source migrated

- **GIVEN** `apps/agent/src/terminal/pty-source.ts`
- **WHEN** the file is read
- **THEN** it SHALL import from `@nexus/core/safe-spawn`
- **AND** SHALL NOT contain any direct `child_process.spawn` or `exec` call

