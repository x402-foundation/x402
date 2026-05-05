#!/usr/bin/env bash
# Layer 1 universal gate for the batch-settlement Python port.
#
# Usage (run from the repository root):
#   bash scripts/check.sh
#
# Steps (PR1 scope):
#   1. ruff lint
#   2. ruff format check
#   3. mypy (scoped to the package, --follow-imports=silent)
#   4. pytest
#   5. commit signing (warn-only until PR submission)
#   6. towncrier changelog fragment present

set -euo pipefail

cd "$(git rev-parse --show-toplevel)/python/x402"

PKG=mechanisms/evm/batch_settlement
TESTS=tests/unit/mechanisms/evm/batch_settlement

echo "[1/6] ruff lint..."
uv run ruff check "$PKG" "$TESTS"

echo "[2/6] ruff format check..."
uv run ruff format --check "$PKG" "$TESTS"

echo "[3/6] mypy..."
uv run mypy --follow-imports=silent "$PKG" "$TESTS"

echo "[4/6] pytest..."
uv run pytest "$TESTS" -v

echo "[5/6] commit signing (HEAD)..."
if git log --show-signature -1 2>&1 | grep -qE "Good (signature|.*signature)"; then
  echo "  ✅ signed"
else
  echo "  ⚠ HEAD not verified as signed (PR submission requires signed commits)"
fi

echo "[6/6] towncrier changelog fragment..."
# Only count fragments with valid towncrier suffixes (per pyproject.toml).
if compgen -G "changelog.d/*.feature.md" > /dev/null \
   || compgen -G "changelog.d/*.bugfix.md" > /dev/null \
   || compgen -G "changelog.d/*.doc.md" > /dev/null \
   || compgen -G "changelog.d/*.removal.md" > /dev/null \
   || compgen -G "changelog.d/*.misc.md" > /dev/null; then
  echo "  ✅ found"
else
  echo "  ❌ no changelog fragment in python/x402/changelog.d/" >&2
  exit 1
fi

echo ""
echo "✅ all checks passed"
