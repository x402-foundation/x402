#!/usr/bin/env bash
# Starts the regtest pair and opens alice -> bob (1,000,000 sat).
# Writes REST endpoints, macaroons and TLS paths to ./.data/env for the integration tests.
set -euo pipefail
cd "$(dirname "$0")"

btc() { docker compose exec -T bitcoind bitcoin-cli -regtest -rpcuser=x402 -rpcpassword=x402 "$@"; }
ln() { local node=$1; shift; docker compose exec -T "$node" lncli --network=regtest "$@"; }
mine() { btc generatetoaddress "$1" "$MINER" >/dev/null; }
wait_for() { for _ in $(seq 1 60); do if "$@" >/dev/null 2>&1; then return 0; fi; sleep 1; done; echo "timeout: $*" >&2; exit 1; }

docker compose up -d
wait_for btc getblockchaininfo
btc createwallet miner >/dev/null 2>&1 || btc loadwallet miner >/dev/null 2>&1 || true
MINER=$(btc -rpcwallet=miner getnewaddress)
mine 101

wait_for ln alice getinfo
wait_for ln bob getinfo

ALICE_ADDR=$(ln alice newaddress p2tr | sed -n 's/.*"address": "\(.*\)".*/\1/p')
btc -rpcwallet=miner sendtoaddress "$ALICE_ADDR" 1 >/dev/null
mine 6
wait_for sh -c "docker compose exec -T alice lncli --network=regtest walletbalance | grep -q '\"confirmed_balance\": \"100000000\"'"

BOB_PUBKEY=$(ln bob getinfo | sed -n 's/.*"identity_pubkey": "\(.*\)".*/\1/p')
ln alice connect "${BOB_PUBKEY}@bob:9735" >/dev/null 2>&1 || true
if ! ln alice listchannels | grep -q "$BOB_PUBKEY"; then
  ln alice openchannel --node_key "$BOB_PUBKEY" --local_amt 1000000 >/dev/null
  mine 6
fi
wait_for sh -c "docker compose exec -T alice lncli --network=regtest listchannels --active_only | grep -q '$BOB_PUBKEY'"

cat > .data/env <<ENV
LNBTC_REGTEST_PAYER_REST=https://localhost:18081
LNBTC_REGTEST_PAYER_MACAROON=$PWD/.data/alice/data/chain/bitcoin/regtest/admin.macaroon
LNBTC_REGTEST_PAYER_TLS_CERT=$PWD/.data/alice/tls.cert
LNBTC_REGTEST_RECEIVER_REST=https://localhost:18082
LNBTC_REGTEST_RECEIVER_MACAROON=$PWD/.data/bob/data/chain/bitcoin/regtest/admin.macaroon
LNBTC_REGTEST_RECEIVER_TLS_CERT=$PWD/.data/bob/tls.cert
LNBTC_REGTEST_RECEIVER_PUBKEY=$BOB_PUBKEY
ENV
echo "regtest ready: alice -> bob channel active; env in $PWD/.data/env"
