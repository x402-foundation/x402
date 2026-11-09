#!/usr/bin/env bash
# Detect which protocol families can run based on catalog-required wallet env vars.
# Prints a comma-separated list (e.g. evm,svm) to stdout.
# Exits 1 when no family has all required secrets.
#
# Reads from the current shell environment. When unset, loads e2e/.env
# (same variables as pnpm test / CI) without overriding existing exports.
# Family gates come from e2e/config/mechanisms_*.json via ci-select-families.ts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$E2E_DIR/.env"

load_env_file() {
  local file=$1
  [[ -f "$file" ]] || return 0

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue

    if [[ "$line" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      local key="${BASH_REMATCH[1]}"
      local val="${BASH_REMATCH[2]}"
      # Strip optional surrounding quotes
      if [[ "$val" =~ ^\"(.*)\"$ ]]; then
        val="${BASH_REMATCH[1]}"
      elif [[ "$val" =~ ^\'(.*)\'$ ]]; then
        val="${BASH_REMATCH[1]}"
      fi
      if [[ -z "${!key:-}" ]]; then
        export "$key=$val"
      fi
    fi
  done < "$file"
}

load_env_file "$ENV_FILE"

cd "$E2E_DIR"
exec pnpm exec tsx scripts/ci-select-families.ts
