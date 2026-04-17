/**
 * Credential routes — barrel re-export.
 *
 * The implementation was split into `./credentials/` (task 1.4 of
 * split-b4-large-files) grouped by concern: init, CRUD, lease, promote,
 * health/usage, swap. This file preserves the original import path so
 * every consumer of `./routes/credentials` continues to resolve the same
 * public surface without changing its import.
 */

export * from "./credentials/index";
