# Hoodgate — Operations Runbook

Production operations guide for the Hoodgate x402 facilitator + demo-api.
Assumes a single Linux host (Debian/Ubuntu) running both services behind
nginx with Let's Encrypt TLS. Multi-node deployment notes at the end.

**Audience:** on-call engineer, first-time deployer, incident responder.

---

## Contents

1. [Topology at a glance](#1-topology-at-a-glance)
2. [First-time deployment](#2-first-time-deployment)
3. [Configuration reference](#3-configuration-reference)
4. [Service management](#4-service-management)
5. [Monitoring & alerts](#5-monitoring--alerts)
6. [Common incidents](#6-common-incidents)
7. [Deploying a new build](#7-deploying-a-new-build)
8. [Key rotation](#8-key-rotation)
9. [Backups & disaster recovery](#9-backups--disaster-recovery)
10. [Scaling beyond one node](#10-scaling-beyond-one-node)

---

## 1. Topology at a glance

```
                     ┌──────────────────────────────────┐
                     │  Internet                        │
                     └────────────┬─────────────────────┘
                                  │  443/tcp (TLS)
                     ┌────────────▼─────────────────────┐
                     │  nginx (systemd)                 │
                     │  - TLS termination               │
                     │  - HSTS, rate-limit floor        │
                     │  - X-Forwarded-For hop           │
                     └────────┬────────────────┬────────┘
                              │127.0.0.1:3001  │127.0.0.1:3005
              ┌───────────────▼───────┐   ┌────▼───────────────────┐
              │ hoodgate-facilitator  │   │ hoodgate-demo-api      │
              │ (systemd, node)       │   │ (systemd, node)        │
              │ /verify /settle       │   │ /weather (x402)        │
              │ /health /metrics      │   │                        │
              └───────────┬───────────┘   └─────────┬──────────────┘
                          │ HTTPS RPC              │ HTTP internal
                          │                        │
              ┌───────────▼──────────┐   ┌─────────▼──────────────┐
              │  Robinhood Chain RPC │   │  facilitator :3001     │
              │  (testnet or main)   │   │  for verify+settle     │
              └──────────────────────┘   └────────────────────────┘
```

**Key surfaces:**

| Surface                       | Purpose                                | Auth   |
| ----------------------------- | -------------------------------------- | ------ |
| `https://demo/...`            | Public, x402-gated resource            | 402    |
| `https://facilitator/verify`  | Payment verification                   | none   |
| `https://facilitator/settle`  | On-chain settlement                    | none   |
| `https://facilitator/health`  | Liveness (uptime pinger)               | none   |
| `https://facilitator/metrics` | Prometheus scrape                      | subnet |

`/verify` and `/settle` are intentionally auth-free: the payment authorization
itself is the credential (an EIP-3009 signature from the payer). Do **not**
add an API key in front of them without a design review — it changes the trust
model.

---

## 2. First-time deployment

### 2.1 Host prep

```bash
apt-get update && apt-get install -y \
    nodejs npm nginx certbot python3-certbot-nginx jq curl
node --version   # must be ≥20
```

### 2.2 Fetch + build

```bash
git clone https://github.com/neonize/hoodgate.git /opt/hoodgate-src
cd /opt/hoodgate-src

# Build both services (produces dist/*.cjs — self-contained bundles)
cd rh-facilitator && npm ci && npm run build && cd ..
cd demo-api       && npm ci && npm run build && cd ..

# Install to /opt/hoodgate (systemd units expect this path)
install -d -m 755 /opt/hoodgate/rh-facilitator/dist /opt/hoodgate/demo-api/dist
install -m 644 rh-facilitator/dist/index.cjs  /opt/hoodgate/rh-facilitator/dist/
install -m 644 demo-api/dist/server.cjs        /opt/hoodgate/demo-api/dist/
```

### 2.3 systemd

```bash
cd /opt/hoodgate-src/deploy/systemd
bash install.sh                       # creates 'hoodgate' user + env files

# Fill in secrets (the installer refuses to overwrite existing files):
$EDITOR /etc/hoodgate/facilitator.secret.env   # FACILITATOR_PRIVATE_KEY
$EDITOR /etc/hoodgate/facilitator.env          # CORS_ORIGINS, ALERT_WEBHOOK_URL

systemctl enable --now hoodgate-facilitator hoodgate-demo-api
systemctl status hoodgate-facilitator          # should be 'active (running)'
```

### 2.4 nginx + TLS

See [`deploy/nginx/README.md`](./nginx/README.md) — install nginx config,
run `certbot`, reload.

### 2.5 Smoke test

```bash
# Local (bypassing nginx)
curl -s http://127.0.0.1:3001/health | jq
curl -s http://127.0.0.1:3005/ | head -5

# Public (through nginx)
curl -sI https://facilitator.hoodgate.example/health | grep -i strict-transport
curl -s  https://facilitator.hoodgate.example/health | jq

# End-to-end payment (uses the demo-api directly)
cd /opt/hoodgate-src/rh-facilitator
export CLIENT_KEY=0x<a-test-wallet-with-USDG-and-gas>
node e2e_v2_conform.mjs   # expects tx hash + block number
```

If any of the above fails, jump to [§6 Common incidents](#6-common-incidents).

---

## 3. Configuration reference

All facilitator config is set via env vars, loaded by systemd from two files
(`facilitator.env` for defaults, `facilitator.secret.env` for keys). Full
template lives at `deploy/systemd/facilitator.env.example`.

### Required
| Var                      | Meaning                                           |
| ------------------------ | ------------------------------------------------- |
| `FACILITATOR_PRIVATE_KEY`| 0x-prefixed 32-byte hex — signer for `/settle`    |
| `CHAIN_ID`               | EIP-155 chain id (testnet=46630)                  |
| `RH_RPC_URL`             | JSON-RPC endpoint                                 |
| `MOCK_USDG_ADDRESS`      | ERC-20 with EIP-3009 (USDG on RH Chain)           |

### Reliability tuning
| Var                     | Default        | Purpose                              |
| ----------------------- | -------------- | ------------------------------------ |
| `RPC_TIMEOUT_MS`        | 6000           | Kill any single RPC after Nms        |
| `RPC_RETRY_COUNT`       | 2              | viem transport retry attempts        |
| `RPC_RETRY_DELAY_MS`    | 300            | Base backoff between retries         |
| `TRUST_PROXY_HOPS`      | 1              | X-Forwarded-For depth (nginx=1)      |
| `CORS_ORIGINS`          | ""             | Comma-separated allowed origins      |
| `STRICT_TOKEN_CHECK`    | 0              | Set 1 on mainnet — refuse boot if token contract fails validation |
| `MAX_GAS_PRICE_WEI`     | *(unset)*      | Refuse to settle above this gas price |

### Health + alerting
| Var                      | Default          | Purpose                             |
| ------------------------ | ---------------- | ----------------------------------- |
| `MIN_GAS_BALANCE_WEI`    | 1e15 (0.001 ETH) | Below this /health returns 503      |
| `ALERT_GAS_BALANCE_WEI`  | 2× MIN           | Soft warn — fires alert webhook     |
| `ALERT_WEBHOOK_URL`      | ""               | Slack/Discord webhook (empty = off) |
| `LOG_LEVEL`              | info             | pino level (debug/info/warn/error)  |

Reload after edits: `systemctl restart hoodgate-facilitator`.

---

## 4. Service management

```bash
# Status
systemctl status hoodgate-facilitator hoodgate-demo-api

# Tail logs (structured JSON via journald)
journalctl -u hoodgate-facilitator -f -o cat | jq -c .
journalctl -u hoodgate-facilitator --since "10 min ago" | jq -c 'select(.level == "error")'

# Restart (drains in-flight settles cleanly — up to 20s)
systemctl restart hoodgate-facilitator

# Full stop (for maintenance)
systemctl stop hoodgate-facilitator hoodgate-demo-api

# nginx reload after config change
nginx -t && systemctl reload nginx
```

**Zero-downtime deploy trick:** systemd `Restart=always` catches the process
exit within 3s. Because settles are idempotent (via the in-memory cache), a
retry from the client after a restart-blip resolves cleanly. See §7.

---

## 5. Monitoring & alerts

### Endpoints
- **`/health`** — 200 = ok, 503 = degraded. Point your uptime pinger here.
- **`/metrics`** — Prometheus text exposition. Firewalled to RFC1918 by
  default (see nginx config). Scrape from `127.0.0.1:3001` if the agent
  runs on the same host.

### What to graph
| Metric                                            | Alert when              |
| ------------------------------------------------- | ----------------------- |
| `facilitator_verify_total{outcome="error"}`       | rate > 1/s for 5m       |
| `facilitator_settle_total{outcome="failure"}`     | rate > 0.1/s for 5m     |
| `facilitator_settle_total{outcome="error"}`       | any                     |
| `facilitator_settle_latency_ms{quantile="0.9"}`   | > 8000                  |
| `facilitator_up`                                  | == 0                    |
| `facilitator_uptime_seconds`                      | resets frequently → crash loop |

### Alert webhook
`ALERT_WEBHOOK_URL` receives a Slack/Discord-compatible `{"text": "..."}`
POST when the gas balance crosses the `ALERT_GAS_BALANCE_WEI` threshold in
either direction. Edge-triggered — one fire per crossing, not per poll.

---

## 6. Common incidents

### 6.1 `/health` returns 503, gasBalanceOk=false
**Symptom:** systemd healthy, but `/health` says degraded.
**Cause:** Facilitator wallet is out of native gas.
**Fix:**
```bash
# Confirm balance
curl -s http://127.0.0.1:3001/health | jq .gasBalanceWei

# Top up (from a funding wallet):
cast send $(jq -r .address < <(curl -s http://127.0.0.1:3001/health)) \
    --value 0.01ether --private-key $FUNDING_KEY --rpc-url $RH_RPC_URL
```

### 6.2 `/health` returns 503, rpcError=rpc_unreachable
**Symptom:** `gasBalanceOk=false` **and** `rpcError` set.
**Cause:** RPC endpoint down or reachable but throwing.
**Fix:**
```bash
# Is the RPC alive at all?
curl -s -X POST $RH_RPC_URL -H 'content-type: application/json' \
    -d '***"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":***' | jq

# If chain-side, wait it out — the service will auto-recover on next poll.
# If a specific endpoint died, edit facilitator.env → RH_RPC_URL → restart.
```

### 6.3 Sudden burst of `nonce_already_used`
**Symptom:** Verify counter shows repeated `nonce_already_used`.
**Cause:** Client bug OR retry storm OR replay attack.
**Diagnosis:**
```bash
# Which payer address?
journalctl -u hoodgate-facilitator --since "10 min ago" -o cat \
    | jq -c 'select(.invalidReason == "nonce_already_used") | .payer' | sort | uniq -c
```
Single-payer high count = their client is buggy (probably calling `/verify`
twice per session — expected, that's the x402 flow). Cross-payer pattern =
worth investigating further; check `/metrics` for `settle` success rate.

### 6.4 `settlement_in_flight` 409s
**Symptom:** Client retries returning 409.
**Cause:** Two simultaneous `/settle` calls for the same (from, nonce). The
in-memory idempotency cache is working correctly — reject the dup.
**Action:** None required unless the client is looping. If it is, the client
is broken; a 200 with the same tx hash comes back on the next poll once the
first settle resolves.

### 6.5 Alert webhook firing constantly
**Symptom:** Repeated "gas low" alerts.
**Cause:** Alert is edge-triggered — repeated fires mean the balance is
oscillating around the threshold. Real cause is usually settlements draining
faster than top-ups.
**Fix:** Raise `ALERT_GAS_BALANCE_WEI` so it fires earlier and gives you more
runway, or automate top-ups from a treasury wallet.

### 6.6 nginx 502 Bad Gateway
**Symptom:** Public curl returns 502; local curl to `:3001` works.
**Cause:** Almost always the app process died between health polls.
```bash
systemctl status hoodgate-facilitator
journalctl -u hoodgate-facilitator --since "5 min ago" -p err
```
If `Restart=always` isn't catching it, check `StartLimitBurst` — 5 restarts
in 60s and systemd stops trying. Fix the root cause, then
`systemctl reset-failed hoodgate-facilitator && systemctl start hoodgate-facilitator`.

### 6.7 Rate-limit false positives from a real customer
**Symptom:** Legit user gets 429 on `/verify`.
**Cause:** Either their retry logic is too aggressive, OR the shared NAT they
sit behind (mobile carrier, corporate proxy) hit the per-IP limit.
**Diagnosis:** Look at their IP in the log — if you see many distinct payer
addresses from one IP, it's a shared egress. Bump the per-IP window in
`index.ts` (`verifyLimiter`) or set up per-payer instead.

---

## 7. Deploying a new build

Zero-downtime-ish deploy (a few seconds of 502 possible during the swap):

```bash
cd /opt/hoodgate-src
git pull
cd rh-facilitator && npm ci && npm run build

# Stage the new artifact side-by-side
install -m 644 dist/index.cjs /opt/hoodgate/rh-facilitator/dist/index.cjs.new

# Atomic swap + restart
mv /opt/hoodgate/rh-facilitator/dist/index.cjs.new /opt/hoodgate/rh-facilitator/dist/index.cjs
systemctl restart hoodgate-facilitator

# Verify
curl -s http://127.0.0.1:3001/health | jq
curl -s http://127.0.0.1:3001/metrics | grep facilitator_up
```

**Rollback:** keep the previous `dist/index.cjs` around as `index.cjs.prev`;
`mv` it back + restart.

---

## 8. Key rotation

The facilitator signer holds real money (gas + any recovery balance). Rotate
periodically or after any suspected compromise.

```bash
# 1. Generate new key (offline machine ideally)
cast wallet new

# 2. Fund the new address with gas
cast send $NEW_ADDR --value 0.05ether --private-key $FUNDING_KEY --rpc-url $RH_RPC_URL

# 3. Update the secret file (chmod 600, root:hoodgate)
$EDITOR /etc/hoodgate/facilitator.secret.env   # replace FACILITATOR_PRIVATE_KEY

# 4. Restart
systemctl restart hoodgate-facilitator

# 5. Verify new signer is live
curl -s http://127.0.0.1:3001/health | jq .address

# 6. Sweep any residue from the old key back to treasury
cast send $TREASURY --value $(cast balance $OLD_ADDR) --private-key $OLD_KEY --rpc-url $RH_RPC_URL

# 7. Destroy the old key material (paper backup + wipe)
```

**Never** commit a private key or paste it into chat, tickets, or PRs. The
`.secret.env` file is `chmod 600` and mode-checked on service start.

---

## 9. Backups & disaster recovery

State that matters:

| What                                     | Where                                | Backup?             |
| ---------------------------------------- | ------------------------------------ | ------------------- |
| Facilitator private key                  | `/etc/hoodgate/facilitator.secret.env` | **Yes — offline + paper** |
| systemd unit files + nginx config        | `/opt/hoodgate-src/deploy/`          | Git                 |
| Env config (non-secret)                  | `/etc/hoodgate/*.env`                | Git (redacted)      |
| TLS certs                                | `/etc/letsencrypt/`                  | Optional (certbot re-issues) |
| Nonce cache, idempotency cache, metrics  | Process memory                       | **No** — rebuilds after restart |

Nothing durable lives in the process. A total host loss recovers by:
1. Reprovision host
2. `git clone` + build + `install.sh`
3. Restore `facilitator.secret.env` from cold storage
4. Reissue certs (certbot)
5. Boot services

Expected RTO: **<15 min** with a fresh host + backup key.

---

## 10. Scaling beyond one node

The current architecture assumes a single process. Two things break at N>1:

### 10.1 Rate limits + idempotency cache are in-process
Two replicas each have their own limiter — an attacker gets 2× the budget.
Same story for the in-memory settle cache: a request round-robined to a
different replica sees no idempotency guarantee.

#### Rate limiter — Redis-backed store (SHIPPED, opt-in via env)

The rate limiter is already **pluggable**. Set `REDIS_URL` and both the
`/verify` and `/settle` limiters switch to a shared Redis store; leave it
unset and they use the built-in in-memory store (correct for single-instance
testnet, wrong for multi-replica production).

**Enable in production:**

```bash
# 1. Install the optional deps in the facilitator workspace.
#    They are NOT in package.json by default — kept out so Redis-less deploys
#    stay dependency-light and don't pull an unused native module.
cd rh-facilitator
npm install --save-optional rate-limit-redis@^4 ioredis@^5

# 2. Point at your Redis (managed ElastiCache / Upstash / self-hosted).
export REDIS_URL='rediss://:PASSWORD@redis.internal:6380'

# 3. Boot as usual.
node dist/index.cjs
```

The build already treats both packages as `--external:` (see
`scripts/ci-smoke.sh` step 1), so a Redis-less machine can still build and
run the same bundle without those modules on disk.

**Failure semantics (fail-open by design):**
- `REDIS_URL` unset → in-memory store, no attempt to load Redis libs.
- `REDIS_URL` set, libs missing → log error, fall back to in-memory. Boot
  succeeds. Rate limits become per-replica.
- `REDIS_URL` set, libs present, Redis unreachable → log error, fall back
  to in-memory. Boot succeeds. Ping is fire-and-forget so a flaky Redis
  never blocks facilitator startup — payments path stays available.

We chose fail-open over fail-closed because a 60/min limiter degrading to
per-replica is a lesser evil than the payments endpoint refusing all
traffic during a Redis outage. If your threat model needs the opposite,
change `makeRateLimitStore()` in `src/index.ts` to throw on error.

**Key prefix:** `rl:hoodgate:` — override by editing `prefix` in
`makeRateLimitStore()` if you share a Redis instance with other services.

**Verifying it's actually attached:** grep the pino log for
`"rate limiter using shared Redis store"` shortly after boot. Absent =
in-memory (either `REDIS_URL` unset or the fallback fired).

#### Settle cache

Still an in-process `Map` — swap for `SETNX` with TTL in Redis when moving
to multi-replica. Skeleton is annotated with `// TODO(scale-out):` markers.
Same `REDIS_URL` can be reused; give it a distinct prefix (`idem:hoodgate:`).

### 10.2 Signer key is single-tenant
If two replicas try to `writeContract` from the same key simultaneously,
they'll race on the on-chain nonce and one tx will fail with `nonce too low`.

**Options:**
- Serialize settlements via a Redis lock (`SETNX signer-lock`)
- Give each replica its own key and load-balance carefully (funds get split)
- Front the signer with a tx-manager (Sequencer, Defender Relay) — best
  long-term answer

**Recommended:** run one replica per signer key. Horizontal scale = more keys.
For most workloads a single replica handles thousands of settles/hour and
the on-chain settle latency is the real bottleneck, not compute.
