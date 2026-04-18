# infra-scaffold Specification

## Purpose
TBD - created by archiving change migrate-nx-terraform. Update Purpose after archive.
## Requirements
### Requirement: root package.json exposes `pnpm tf *` interface
Root `package.json` SHALL include a `"tf"` script pointing to `./infra/scripts/tf.sh` so engineers can run all Terraform operations from any directory in the monorepo without cd-ing into `infra/`.

#### Scenario: `pnpm tf plan` from repo root
- **WHEN** `pnpm tf plan` is run from the repo root
- **THEN** `tf.sh` resolves `infra/environments/prod/` as the working directory and runs `terraform plan -out=prod.tfplan`

#### Scenario: `pnpm tf plan` from a nested package directory
- **WHEN** `pnpm tf plan` is run from `apps/agent/`
- **THEN** the same `prod.tfplan` is produced in `infra/environments/prod/`

### Requirement: deploy hooks source `.tf-outputs.env` before service restart
`deploy/hooks/pre-push` and `deploy/hooks/post-merge` SHALL source `infra/.tf-outputs.env` when it exists and call `systemctl --user set-environment` to inject `POSTGRES_URL`, `NEXUS_ENCRYPTION_KEY`, and `NEXUS_ATTACH_SECRET` into the systemd session before restarting `nexus-agent`. If the file is absent the hook SHALL print a warning and continue non-blocking.

#### Scenario: hook injects env vars when `.tf-outputs.env` is present
- **WHEN** `git push origin main` triggers `pre-push` and `infra/.tf-outputs.env` exists
- **THEN** the hook calls `systemctl --user set-environment POSTGRES_URL=... NEXUS_ENCRYPTION_KEY=... NEXUS_ATTACH_SECRET=...` and then restarts `nexus-agent`

#### Scenario: hook continues without abort when `.tf-outputs.env` is absent
- **WHEN** `git push origin main` triggers `pre-push` and `infra/.tf-outputs.env` does not exist
- **THEN** the hook prints `WARNING: infra/.tf-outputs.env not found — run: pnpm tf apply` and does NOT exit non-zero

