# paste-drop Specification

## Purpose
TBD - created by archiving change add-paste-to-project. Update Purpose after archive.
## Requirements
### Requirement: The agent SHALL serve `POST /paste` to write file bytes into a project or absolute path

nexus-agent SHALL serve `POST /paste` accepting a JSON body with base64-encoded file
bytes and a target selector. On success it writes the decoded bytes to a resolved
destination on disk and returns the written absolute path. The write SHALL be atomic
(temp file + rename) and SHALL NOT overwrite an existing file — a name collision is
resolved by suffixing the basename (`name-1.ext`, `name-2.ext`, ...).

The route is a distinct endpoint from the existing `POST /capture` mx-gateway proxy and
does not forward to the gateway.

#### Scenario: Project-mode drop lands in docs/screenshots
- **GIVEN** a registered project resolvable to a filesystem `cwd`
- **WHEN** a client posts `POST /paste {"project":"<code|id>","filename":"shot.png","data_base64":"<...>"}`
- **THEN** the decoded bytes are written to `<cwd>/docs/screenshots/shot.png`
- **AND** the response reports the written absolute path

#### Scenario: Absolute-path drop writes to the described path
- **WHEN** a client posts `POST /paste {"path":"/home/nyaptor/dev/nx/docs/screenshots","filename":"shot.png","data_base64":"<...>"}`
- **THEN** the bytes are written under that path with the given filename
- **AND** the response reports the written absolute path

#### Scenario: Name collision is suffixed, never clobbered
- **GIVEN** the resolved destination file already exists
- **WHEN** another `POST /paste` targets the same directory and filename
- **THEN** the new file is written with a numeric suffix and the existing file is left intact

### Requirement: The agent SHALL fail loudly on invalid input or write failure

`POST /paste` SHALL NOT return a fabricated success. Invalid targets, undecodable or
missing payloads, and filesystem failures SHALL surface as distinct error statuses.

#### Scenario: Unknown project returns 404
- **WHEN** `POST /paste` names a `project` that resolves to no registered project
- **THEN** the agent returns 404 and writes nothing

#### Scenario: Missing or undecodable payload returns 400
- **WHEN** `POST /paste` omits `data_base64`/`filename`, or `data_base64` is not valid base64, or the payload exceeds the configured size cap
- **THEN** the agent returns 400 and writes nothing

#### Scenario: Filesystem failure returns 500
- **GIVEN** the resolved destination directory cannot be created or written
- **WHEN** a valid `POST /paste` is processed
- **THEN** the agent returns 500 and no partial file remains

### Requirement: The repo SHALL carry a rebuild-from-scratch Apple Shortcut recipe

The repo SHALL carry `docs/paste-shortcut.md` documenting the Apple Shortcut that drives
`POST /paste`: fetching the project list from `GET /projects`, presenting a project picker
or an absolute-path prompt, base64-encoding the clipboard image, posting to the agent's
Tailscale URL, and rendering success/failure banners — sufficient to rebuild on a fresh
phone from the doc alone.

#### Scenario: Recipe is complete
- **WHEN** the Shortcut is rebuilt on a fresh device following only `docs/paste-shortcut.md`
- **THEN** a picked-project drop lands the pasted image in `<project>/docs/screenshots/`
- **AND** a stopped agent produces the documented failure banner

