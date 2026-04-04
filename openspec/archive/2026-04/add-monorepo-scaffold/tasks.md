## 1. Workspace Setup
- [x] [1.1] Init pnpm workspace with pnpm-workspace.yaml defining apps/* and packages/* [owner:engineer]
- [x] [1.2] Configure turbo.json with build, dev, lint, typecheck task pipelines [owner:engineer]
- [x] [1.3] Add root package.json with scripts: dev, build, lint, typecheck, test [owner:engineer]
- [x] [1.4] Add root tsconfig.json with shared compiler options and project references [owner:engineer]

## 2. App Scaffolds
- [x] [2.1] Scaffold apps/agent with Bun entry point (index.ts), tsconfig.json, and package.json (@nexus/agent) [owner:engineer]
- [x] [2.2] Scaffold apps/dashboard with create-next-app (App Router, no src dir) as @nexus/dashboard [owner:engineer]

## 3. Package Scaffolds
- [x] [3.1] Scaffold packages/core with shared type exports and package.json (@nexus/core) [owner:engineer]
- [x] [3.2] Scaffold packages/watcher with Cargo.toml, build script, and package.json (@nexus/watcher) [owner:engineer]

## 4. Tooling
- [x] [4.1] Configure ESLint flat config with shared rules [owner:engineer]
- [x] [4.2] Configure Prettier with consistent formatting rules [owner:engineer]
- [x] [4.3] Add .gitignore covering node_modules, .next, target/, dist/ [owner:engineer]

## 5. Validation
- [x] [5.1] Verify `pnpm install` resolves all workspace dependencies [owner:engineer]
- [x] [5.2] Verify `pnpm turbo build` runs across all packages without errors [owner:engineer]
