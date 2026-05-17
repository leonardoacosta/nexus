## ADDED Requirements

### Requirement: sessions table SHALL carry git repo identity columns

The sessions schema SHALL include `git_provider` (text, nullable) and `git_owner_repo` (text, nullable). A Drizzle migration adds these columns to existing tables; existing rows have NULL values.

#### Scenario: schema migration is idempotent
- **GIVEN** a sessions table without the new columns
- **WHEN** the migration runs
- **THEN** both columns are added with NULL defaults; subsequent migration runs are no-ops

### Requirement: session_start SHALL enrich with git repo identity when available

When `session_start` arrives with a `cwd`, the resolver SHALL execute `git -C $cwd remote get-url origin` and parse the result into `{provider, owner_repo}`. Supported URL forms: GitHub HTTPS, GitHub SSH, Azure DevOps HTTPS. If the cwd is not a git repo or parsing fails, both columns remain NULL.

#### Scenario: github HTTPS origin resolves
- **GIVEN** session_start with `cwd=/home/leo/dev/oo` where origin is `https://github.com/leonardoacosta/oo.git`
- **WHEN** the resolver runs
- **THEN** the sessions row has `git_provider='github'` and `git_owner_repo='leonardoacosta/oo'`

#### Scenario: github SSH origin resolves
- **GIVEN** session_start where origin is `git@github.com:leonardoacosta/oo.git`
- **WHEN** the resolver runs
- **THEN** sessions row has `git_provider='github'` and `git_owner_repo='leonardoacosta/oo'`

#### Scenario: azure devops origin resolves
- **GIVEN** session_start where origin is `https://dev.azure.com/org/project/_git/repo`
- **WHEN** the resolver runs
- **THEN** sessions row has `git_provider='azdo'` and `git_owner_repo='org/project/repo'`

#### Scenario: non-git directory leaves columns NULL
- **GIVEN** session_start with `cwd=/tmp/scratch` (not a git repo)
- **WHEN** the resolver runs
- **THEN** both columns remain NULL; no error is raised
