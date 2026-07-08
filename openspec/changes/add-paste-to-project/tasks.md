<!-- beads:epic:nx-zf1n9 -->
<!-- beads:feature:nx-4mkeb -->

# Tasks: add-paste-to-project

## API Batch

- [x] 1.1 Create `apps/agent/src/routes/paste.ts` — `POST /paste` handler. Parse JSON body (`project?`, `path?`, `filename`, `data_base64`). Validate: exactly one of `project`/`path` present, `filename` + `data_base64` present, base64 decodes, decoded size <= cap. Reuse `routes/capture.ts` for the loud-failure response shape. [beads:nx-j8l6s]
- [x] 1.2 Project resolution: given `project` (code or id), resolve to `cwd` via the projects layer (mirror how `routes/projects.ts` / `git-project-resolver.ts` read the projects table); destination dir = `<cwd>/docs/screenshots`. Unknown project -> 404. [beads:nx-8vsf8]
- [x] 1.3 Absolute-path resolution: given `path`, treat as the destination directory (or dir+filename); write `filename` under it. [beads:nx-mtpxt]
- [x] 1.4 Atomic write with no-clobber: `mkdir -p` the destination dir, write to a temp file then `rename` (mirror `routes/commands.ts` write-at-104); if the target basename exists, suffix `-1`/`-2`/... before writing. Return the written absolute path in the response. [beads:nx-d4dji]
- [x] 1.5 Wire the route into dispatch in `apps/agent/src/server-request-handler.ts` (add `POST /paste` alongside the existing route registrations; do NOT touch `POST /capture`). [beads:nx-j7h0p]
- [x] 1.6 Author `apps/agent/src/routes/paste.test.ts` (mirror `capture.test.ts`): project-mode lands under `docs/screenshots/`; absolute-path mode writes to the given path; collision suffixing leaves the existing file intact; unknown project -> 404; missing/undecodable/oversized payload -> 400; filesystem failure -> 500; write is atomic. Run with `NEXUS_ATTACH_SECRET=test` + `POSTGRES_URL` per project test-env convention. [beads:nx-z5of1]
- [x] 1.7 Author `docs/paste-shortcut.md` (mirror `docs/capture-shortcut.md`): Shortcut fetches `GET /projects`, presents a project picker or absolute-path prompt, base64-encodes the clipboard image, POSTs to the agent Tailscale URL, renders success/failure banners; rebuild-from-scratch complete. [beads:nx-21far]

## E2E Batch

- [ ] 2.1 [user] On-device end-to-end: rebuild the Shortcut on the phone from `docs/paste-shortcut.md` alone, drop a clipboard screenshot into a picked project, confirm it lands in `<project>/docs/screenshots/`, then stop the agent and confirm the documented failure banner. (searched: agent route vitest cannot drive a physical iPhone or execute an Apple Shortcut; no documented nx pattern automates on-device Shortcut runs.) [beads:nx-hehh2]
