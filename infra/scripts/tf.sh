#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="$SCRIPT_DIR/.."
SECRETS_FILE="$INFRA_DIR/.secrets.env"
OUTPUTS_FILE="$INFRA_DIR/.tf-outputs.env"
TF_ENV_DIR="$INFRA_DIR/environments/prod"

# ── Secrets bootstrap ─────────────────────────────────────────────

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "nexus-tf: creating $SECRETS_FILE — fill in token/URL values before running init/plan/apply"
  cat > "$SECRETS_FILE" <<'SECRETS'
# Terraform variable overrides — sourced by tf.sh, never committed.
# Fill in real values then run: pnpm tf init

export TF_VAR_cloudflare_api_token=""

# Postgres superuser password — falls back to CX_POSTGRES_PASSWORD if set in env.
# Leave blank if CX_POSTGRES_PASSWORD is already exported in your shell.
export TF_VAR_pg_superuser_password=""
SECRETS
  chmod 600 "$SECRETS_FILE"
  echo "nexus-tf: edit $SECRETS_FILE then re-run the command"
  exit 1
fi

# Source secrets
# shellcheck source=/dev/null
source "$SECRETS_FILE"

# Fall back to CX_POSTGRES_PASSWORD if pg_superuser_password not explicitly set
if [[ -z "${TF_VAR_pg_superuser_password:-}" && -n "${CX_POSTGRES_PASSWORD:-}" ]]; then
  export TF_VAR_pg_superuser_password="$CX_POSTGRES_PASSWORD"
fi

# ── Command dispatch ──────────────────────────────────────────────

CMD="${1:-help}"

_tf() {
  terraform -chdir="$TF_ENV_DIR" "$@"
}

_write_outputs() {
  local tmp
  tmp="$(mktemp)"
  _tf output -json > "$tmp"

  {
    echo "# Written by pnpm tf apply — $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "export NEXUS_ENCRYPTION_KEY=$(jq -r '.nexus_encryption_key.value // ""' "$tmp")"
    echo "export NEXUS_ATTACH_SECRET=$(jq -r '.nexus_attach_secret.value // ""' "$tmp")"
    echo "export POSTGRES_URL=$(jq -r '.postgres_url.value // ""' "$tmp")"
    echo "export HOMELAB_IP=$(jq -r '.homelab_ip.value // ""' "$tmp")"
  } > "$OUTPUTS_FILE"

  chmod 600 "$OUTPUTS_FILE"
  rm "$tmp"
  echo "nexus-tf: outputs written to $OUTPUTS_FILE"
}

case "$CMD" in
  init)
    _tf init "${@:2}"
    ;;
  plan)
    _tf plan "${@:2}"
    ;;
  apply)
    _tf apply "${@:2}"
    _write_outputs
    ;;
  destroy)
    _tf destroy "${@:2}"
    ;;
  output)
    _tf output "${@:2}"
    ;;
  fmt)
    _tf fmt -recursive "$INFRA_DIR" "${@:2}"
    ;;
  validate)
    _tf validate "${@:2}"
    ;;
  *)
    echo "Usage: pnpm tf <init|plan|apply|destroy|output|fmt|validate>"
    echo ""
    echo "Commands:"
    echo "  init      Initialize providers and TF Cloud backend"
    echo "  plan      Show execution plan"
    echo "  apply     Apply changes and write infra/.tf-outputs.env"
    echo "  destroy   Destroy managed resources"
    echo "  output    Print current output values"
    echo "  fmt       Format all .tf files"
    echo "  validate  Validate configuration"
    exit 1
    ;;
esac
