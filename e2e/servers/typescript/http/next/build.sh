#!/bin/bash
set -e
export FACILITATOR_URL="${FACILITATOR_URL:-http://localhost:4022}"
pnpm build
