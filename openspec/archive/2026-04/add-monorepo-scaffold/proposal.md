# Add Monorepo Scaffold

## Why
Nexus v2 replaces the Rust Cargo workspace with a T3 Turbo monorepo (pnpm + Turborepo) to unify the Bun agent, Next.js dashboard, shared core types, and Rust file watcher under one build graph. Without this scaffold, no v2 code has a home.

## What Changes
Initialize a pnpm workspace with four packages: `apps/agent` (Bun), `apps/dashboard` (Next.js App Router), `packages/core` (shared TypeScript types), and `packages/watcher` (Rust binary build scripts). Configure Turborepo task pipelines, ESLint flat config, Prettier, root tsconfig, and standard dev scripts.

## Specs
See specs/ directory (if applicable).
