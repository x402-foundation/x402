#!/bin/bash
set -e
export FACILITATOR_URL="${FACILITATOR_URL:-http://localhost:4022}"
# `next dev` writes .next/dev/types that still import removed routes.
# `next build` typechecks those files and fails until the cache is cleared.
rm -rf .next
pnpm build
