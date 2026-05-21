# cleanup Specification

## Purpose
TBD - created by archiving change remove-orphaned-tmp-files. Update Purpose after archive.
## Requirements
### Requirement: Weekly reaper sweeps regenerable caches and build output

The system SHALL run a weekly maintenance reaper that reclaims disk space by
deleting OS/package-manager caches and age-gated regenerable build output,
without ever touching irreplaceable state. The destructive core SHALL be a
vendored bash script invoked as a child process; its destructive logic SHALL
NOT be reimplemented in TypeScript.

#### Scenario: Cache directories are cleaned

- **WHEN** the reaper runs on macOS
- **THEN** `~/.cache`, `~/Library/Caches`, the npm cache, the bun cache, the
  pnpm store, the dotnet NuGet cache, and the Homebrew cache are pruned via
  their native clean commands

#### Scenario: Linux parity

- **WHEN** the reaper runs on the Linux homelab
- **THEN** `~/.cache`, the npm cache, the bun cache, the yarn cache, and
  `~/.cargo/registry/cache` are pruned, achieving cross-platform parity with
  the macOS sweep

#### Scenario: node_modules and .git are never touched

- **WHEN** the reaper sweeps `~/dev` for stale build output
- **THEN** any directory named `node_modules` or `.git` is pruned from the
  traversal and never deleted, modified, or truncated

#### Scenario: Build-output sweep is age-gated to 7 days

- **GIVEN** a `.turbo`, `.next`, or `*.bun-build` artifact under `~/dev`
- **WHEN** the artifact has been untouched for 7 days or less
- **THEN** the reaper leaves it in place; only artifacts older than 7 days
  are removed

#### Scenario: Active logs are truncated, not deleted

- **GIVEN** a `*.log` file over the size threshold in a safelisted log
  directory that a running writer still holds open
- **WHEN** the reaper processes it
- **THEN** the file is truncated in place (inode and file descriptor
  preserved) so the writer keeps logging, and the file is never unlinked

#### Scenario: Stray crash-dump logs are deleted age-gated

- **GIVEN** a stray `*.Default.w*.log` Electron crash dump older than 7 days
  in `$HOME`
- **WHEN** the reaper runs
- **THEN** the file is deleted (these are per-session dumps, not append logs);
  a crash dump 7 days old or newer is left for investigation

### Requirement: Reaper supports a non-destructive dry-run mode

The reaper SHALL accept a `--dry-run` flag, forwarded by the TypeScript job
wrapper, that reports every action it would take without deleting,
truncating, or modifying any file. Dry-run SHALL be idempotent.

#### Scenario: Dry-run performs zero mutations

- **WHEN** the reaper job is invoked with dry-run enabled
- **THEN** the child process logs `would clean` / `would rm` / `would
  truncate` lines, performs zero filesystem mutations, and a verifying check
  confirms no targeted path was deleted or truncated

#### Scenario: Dry-run is idempotent

- **WHEN** the reaper dry-run is invoked twice in succession
- **THEN** both invocations report the same set of candidate actions and the
  filesystem is unchanged after each

### Requirement: Bloat radar surfaces adjacent dirs the reaper deliberately does not auto-clean

The reaper SHALL scan adjacent directories it intentionally does NOT
auto-delete (Xcode/Developer, CoreSimulator, iOS DeviceSupport, Claude
vm_bundles, colima, `.nuget`, the pnpm store, oversized `~/dev` repos > 8 GB,
and runaway Chrome profile `History` files > 300 MB) and report any that
exceed their threshold.

#### Scenario: Over-threshold dir is reported and spoken

- **GIVEN** a CoreSimulator directory larger than its 20 GB threshold
- **WHEN** the bloat radar runs at end-of-reap
- **THEN** the finding is written to the run log, included as a structured
  item in the completion notification, and a dedicated loud TTS warning is
  spoken separately from the routine summary

#### Scenario: Runaway Chrome History detected

- **GIVEN** a Chrome profile `History` file larger than 300 MB
- **WHEN** the bloat radar runs
- **THEN** the profile name and size are reported as a bloat finding and the
  user is warned that it is not auto-cleaned and needs their decision

#### Scenario: Clear when nothing trips

- **WHEN** no adjacent directory exceeds its threshold
- **THEN** the radar reports "clear" and emits no bloat TTS warning

