#!/usr/bin/env bash
# Detect which protocol families can run based on configured wallet env vars.
# Prints a comma-separated list (e.g. evm,svm) to stdout.
# Exits 1 when no family has all required secrets.
#
# Reads from the current shell environment. When unset, loads e2e/.env
# (same variables as pnpm test / CI) without overriding existing exports.
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

families=()

all_set() {
  for var in "$@"; do
    if [[ -z "${!var:-}" ]]; then
      return 1
    fi
  done
  return 0
}

if all_set SERVER_EVM_ADDRESS CLIENT_EVM_PRIVATE_KEY FACILITATOR_EVM_PRIVATE_KEY; then
  families+=("evm")
fi

if all_set SERVER_SVM_ADDRESS CLIENT_SVM_PRIVATE_KEY FACILITATOR_SVM_PRIVATE_KEY; then
  families+=("svm")
fi

if all_set SERVER_AVM_ADDRESS CLIENT_AVM_PRIVATE_KEY FACILITATOR_AVM_PRIVATE_KEY; then
  families+=("avm")
fi

if all_set SERVER_APTOS_ADDRESS CLIENT_APTOS_PRIVATE_KEY FACILITATOR_APTOS_PRIVATE_KEY; then
  families+=("aptos")
fi

if all_set \
  SERVER_HEDERA_ADDRESS \
  CLIENT_HEDERA_ACCOUNT_ID \
  CLIENT_HEDERA_PRIVATE_KEY \
  FACILITATOR_HEDERA_ACCOUNT_ID \
  FACILITATOR_HEDERA_PRIVATE_KEY; then
  families+=("hedera")
fi

if all_set SERVER_STELLAR_ADDRESS CLIENT_STELLAR_PRIVATE_KEY FACILITATOR_STELLAR_PRIVATE_KEY; then
  families+=("stellar")
fi

if all_set SERVER_TVM_ADDRESS CLIENT_TVM_PRIVATE_KEY FACILITATOR_TVM_PRIVATE_KEY; then
  families+=("tvm")
fi

if [[ ${#families[@]} -eq 0 ]]; then
  echo "No protocol families have all required wallet secrets configured." >&2
  echo "Set variables in e2e/.env or export them in your shell." >&2
  exit 1
fi

(IFS=','; echo "${families[*]}")
