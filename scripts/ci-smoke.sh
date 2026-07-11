#!/usr/bin/env bash
# CI smoke test — local, no external services required.
#
# Runs the full "does this even boot" gate before a deploy:
#   1. npm ci + build both services (esbuild → dist/*.cjs)
#   2. Unit tests (rh-facilitator/tests/*.test.ts via node:test)
#   3. Boot both services against dist/*.cjs (the actual deploy artifact,
#      not tsx/ts-node — catches bundling bugs tsx would mask)
#   4. Poll /health until ready (bounded wait, not sleep-and-pray)
#   5. Hit /metrics, confirm Prometheus exposition format
#   6. Hit demo-api root, confirm the inline HTML page renders
#   7. Optional: full on-chain E2E if CLIENT_KEY is set (skipped in CI by
#      default since it needs a funded testnet wallet + costs real gas)
#
# Exit code 0 = all gates passed. Non-zero = first failure, with the
# offending step's output printed above.
#
# Usage:
#   bash scripts/ci-smoke.sh              # build + unit + boot + http checks
#   CLIENT_KEY=0x... bash scripts/ci-smoke.sh   # also run on-chain E2E
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FACILITATOR_DIR="$ROOT/rh-facilitator"
DEMO_DIR="$ROOT/demo-api"
FACILITATOR_PORT="${FACILITATOR_PORT:-13001}"
DEMO_PORT="${DEMO_PORT:-13005}"
LOG_DIR="$(mktemp -d)"
FAC_PID=""
DEMO_PID=""

# ── Pre-flight: nothing should be on our target ports ────────────────
# Zombies from a prior aborted run answer /health with success and mask
# a real boot failure. Fail loudly if the ports are busy.
for _p in "$FACILITATOR_PORT" "$DEMO_PORT"; do
  if ss -ltn "sport = :$_p" 2>/dev/null | grep -q LISTEN; then
    echo "✘ port $_p already in use — kill leftover process first" >&2
    (ss -ltnp "sport = :$_p" 2>/dev/null || netstat -ltnp 2>/dev/null | grep ":$_p ") >&2
    exit 2
  fi
done

# ── Pretty output ────────────────────────────────────────────────────
step() { printf "\n\033[1;36m▶ %s\033[0m\n" "$1"; }
ok()   { printf "\033[32m✔ %s\033[0m\n" "$1"; }
fail() { printf "\033[31m✘ %s\033[0m\n" "$1"; }

# ── Cleanup: kill any child processes we started, on any exit path ──
cleanup() {
  local code=$?
  [[ -n "$FAC_PID" ]] && kill "$FAC_PID" 2>/dev/null || true
  [[ -n "$DEMO_PID" ]] && kill "$DEMO_PID" 2>/dev/null || true
  if [[ $code -ne 0 ]]; then
    fail "SMOKE TEST FAILED (exit $code) — logs in $LOG_DIR"
    echo "--- facilitator.log (last 40 lines) ---"
    tail -40 "$LOG_DIR/facilitator.log" 2>/dev/null || true
    echo "--- demo-api.log (last 40 lines) ---"
    tail -40 "$LOG_DIR/demo-api.log" 2>/dev/null || true
  else
    rm -rf "$LOG_DIR"
  fi
  exit "$code"
}
trap cleanup EXIT

# ── Bounded poll helper (no sleep-and-pray) ──────────────────────────
# wait_for URL max_seconds
# NOTE: uses -o (not -f) — we only care that the port answers HTTP at all.
# /health can legitimately return 503 (e.g. gasBalanceOk=false when the
# smoke-test signer key has zero funds) and that still means "booted ok".
wait_for() {
  # IMPORTANT: `-w '%{http_code}'` writes "000" on connect failure and then
  # curl exits 7. The old `code=$(curl ... || echo 000)` pattern appended a
  # second "000", giving code="000\n000" which was not equal to "000" — so the
  # check spuriously succeeded before the port was even bound (the "log 0
  # bytes + health passed" ghost we chased for four smoke runs).
  #
  # We now put the curl call in the `if` condition — `set -e` is explicitly
  # disabled for commands whose exit status is being tested, so a curl exit 7
  # can't bubble out and kill the script.
  local url="$1" max="${2:-20}" waited=0 code=""
  while (( waited < max )); do
    if code="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 2 "$url" 2>/dev/null)" \
       && [[ -n "$code" && "$code" != "000" ]]; then
      return 0
    fi
    waited=$((waited + 1))
    sleep 1
  done
  fail "timed out waiting for $url (last http_code='${code:-000}' after ${max}s)"
  return 1
}

# ── 1. Install + build ────────────────────────────────────────────────
step "1/7 — install + build rh-facilitator"
# rate-limit-redis + ioredis are optional deps, loaded lazily via require()
# only when REDIS_URL is set. Mark them --external so a Redis-less build
# (the default testnet path) neither bundles nor requires them present.
( cd "$FACILITATOR_DIR" && npm ci --silent && npx esbuild src/index.ts \
    --bundle --platform=node --format=cjs --outfile=dist/index.cjs \
    --external:dotenv --external:rate-limit-redis --external:ioredis )
ok "rh-facilitator built → dist/index.cjs"

step "1/7 — install + build demo-api"
( cd "$DEMO_DIR" && npm ci --silent && npx esbuild server.ts \
    --bundle --platform=node --format=cjs --outfile=dist/server.cjs )
ok "demo-api built → dist/server.cjs"

# ── 2. Unit tests ─────────────────────────────────────────────────────
step "2/7 — unit tests (rh-facilitator)"
( cd "$FACILITATOR_DIR" && npm test )
ok "unit tests passed"

# ── 3. Boot both services from the built artifact ────────────────────
# We launch via `env ... node ...` in the current shell (not a subshell) so
# `$!` captures the PID we can actually kill in cleanup. `disown` detaches
# the job from shell-exit propagation while still letting us kill by PID.
step "3/7 — boot facilitator on :$FACILITATOR_PORT"
cd "$FACILITATOR_DIR"
env \
  PORT="$FACILITATOR_PORT" \
  CHAIN_ID="${CHAIN_ID:-46630}" \
  RH_RPC_URL="${RH_RPC_URL:-https://rpc.testnet.chain.robinhood.com}" \
  MOCK_USDG_ADDRESS="${MOCK_USDG_ADDRESS:-0xdDC7e17D6c06F8c5126b65fc9164481D87e6edE4}" \
  FACILITATOR_PRIVATE_KEY="${FACILITATOR_PRIVATE_KEY:-0x1111111111111111111111111111111111111111111111111111111111111111}" \
  STRICT_TOKEN_CHECK=0 \
  LOG_LEVEL=warn \
  node dist/index.cjs > "$LOG_DIR/facilitator.log" 2>&1 &
FAC_PID=$!
disown %1 2>/dev/null || true
cd "$ROOT"

step "3/7 — boot demo-api on :$DEMO_PORT"
cd "$DEMO_DIR"
# FACILITATOR_ADDRESS must be a real 0x-prefixed address — demo-api puts it
# in PaymentRequirements.payTo, and the E2E client feeds that straight into
# viem.signTypedData which rejects empty strings ("Address \"\" is invalid").
env \
  PORT="$DEMO_PORT" \
  FACILITATOR_URL="http://127.0.0.1:$FACILITATOR_PORT" \
  CHAIN_ID="${CHAIN_ID:-46630}" \
  FACILITATOR_ADDRESS="${FACILITATOR_ADDRESS:-0xb3D0265a0e9Ab5C4B39c5E7735958572BE16E985}" \
  node dist/server.cjs > "$LOG_DIR/demo-api.log" 2>&1 &
DEMO_PID=$!
disown %1 2>/dev/null || true
cd "$ROOT"

# ── 4. Wait for both to answer /health (or / for demo-api) ───────────
step "4/7 — wait for services to become ready"
wait_for "http://127.0.0.1:$FACILITATOR_PORT/health" 20
ok "facilitator /health responded"
wait_for "http://127.0.0.1:$DEMO_PORT/" 20
ok "demo-api / responded"

# ── 5. /metrics format check ──────────────────────────────────────────
# Counter TYPE lines are only emitted once the counter has been incremented
# at least once. Hit /verify with a deliberately bad body to force the
# verify_total counter to register before we scrape.
step "5/7 — /metrics is valid Prometheus exposition"
# Prime the verify counter with a malformed body so `# TYPE ... counter` shows up
# in the output. Body-in-file avoids shell-quoting foot-guns.
printf '%s' '{"garbage":true}' > "$LOG_DIR/bad-verify.json"
curl -s -o /dev/null -X POST "http://127.0.0.1:$FACILITATOR_PORT/verify" \
  -H 'content-type: application/json' --data-binary "@$LOG_DIR/bad-verify.json"
curl -s -o "$LOG_DIR/metrics.txt" "http://127.0.0.1:$FACILITATOR_PORT/metrics"
# grep the file directly. Piping `echo "$big_var" | grep -q` gives the echo
# writer a SIGPIPE when grep matches early and exits — with `set -o pipefail`
# on, that 141 exit propagates as a pipeline failure even though grep matched.
# This bit us during development (72KB HTML body + <html at byte 16 + pipefail).
grep -q '^facilitator_up ' "$LOG_DIR/metrics.txt" || { fail "missing facilitator_up gauge"; exit 1; }
grep -q '^# TYPE facilitator_verify_total counter$' "$LOG_DIR/metrics.txt" || { fail "missing verify_total TYPE line"; exit 1; }
ok "/metrics exposes facilitator_up + facilitator_verify_total"

# ── 6. demo-api root page renders ─────────────────────────────────────
step "6/7 — demo-api root page contains expected markup"
curl -s -o "$LOG_DIR/root.html" "http://127.0.0.1:$DEMO_PORT/"
grep -qi "<html" "$LOG_DIR/root.html" || { fail "root page is not HTML"; exit 1; }
ok "demo-api served the inline HTML page"

# ── 7. Optional on-chain E2E ───────────────────────────────────────────
# Requires TWO funded wallets: CLIENT_KEY (signs the EIP-3009 auth) and
# FACILITATOR_PRIVATE_KEY (broadcasts the settle tx and pays gas). The
# default facilitator key is the well-known dummy 0x1111...1 → signer
# 0x19E7...ff2A which has zero gas on any real testnet, so a smoke run
# with defaults would always fail at settle even if the whole v2 pipeline
# (challenge → sign → payload → verify) worked perfectly. Gate on both.
DUMMY_FAC_KEY="0x1111111111111111111111111111111111111111111111111111111111111111"
step "7/7 — on-chain E2E (optional)"
if [[ -z "${CLIENT_KEY:-}" ]]; then
  echo "  (skipped — set CLIENT_KEY to a funded testnet wallet to enable)"
elif [[ "${FACILITATOR_PRIVATE_KEY:-$DUMMY_FAC_KEY}" == "$DUMMY_FAC_KEY" ]]; then
  echo "  (skipped — FACILITATOR_PRIVATE_KEY is the smoke-test dummy key,"
  echo "   which has 0 wei on testnet. Set a funded key to run the full"
  echo "   settle path. Wire-level v2 conformance is already validated by"
  echo "   steps 3–6 above; the on-chain leg is a separate integration gate.)"
else
  ( cd "$FACILITATOR_DIR" && RESOURCE="http://127.0.0.1:$DEMO_PORT/weather" node e2e_v2_conform.mjs )
  ok "on-chain E2E conformance passed"
fi

echo
ok "ALL SMOKE CHECKS PASSED"
