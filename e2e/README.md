# E2E Tests

End-to-end test suite for validating client-server-facilitator communication across languages and frameworks.

Layout is `role/language/transport/component` (e.g. `servers/typescript/http/express/index.ts`). One pnpm package per TS language role; Go/Python keep per-component modules and flat language-root modules (`clients/<lang>/client.*`, `servers/<lang>/{catalog,config,routes}.*`) — no `shared/` subdirectory or extra package dir in any language. Vanilla HTTP/MCP components omit `test.config.json`; the harness infers type/language/transport from the path and merges the mechanisms catalog (see below). Custom surfaces (e.g. svm-smart-wallet) keep a local `test.config.json` overlay; Next and MCP use the shared language-root modules with no local endpoint list.

You do **not** need to edit `generic-server` / `generic-client` / `generic-facilitator`, hand-list proxy env maps, or duplicate env/route blocks across sibling HTTP frameworks.

## Mechanisms catalog (SSOT)

[`config/mechanisms_global.json`](config/mechanisms_global.json) plus one [`config/mechanisms_<id>.json`](config/) per network are the source of truth for v2 mechanisms. The file id is the network id (`mechanisms_evm.json` → `evm`); the harness has no fixed network-id union — network identity (CAIP-2, env keys, routes) comes from the catalog. CAIP-2 registration patterns are derived from catalog `caip2` (never a per-family string table): clients and TS/Python resource servers use `${namespace}:*` via `networkCaip2Pattern`; Go resource servers register the exact catalog CAIP-2 (Go’s `BuildPaymentRequirements` looks up schemes by exact network); facilitators always register exact CAIP-2 via `resolveNetworkCaip2`. Scheme **classes** still need a one-time register call per language role (see [Add a network](#add-a-network)).

`mechanisms_global.json` holds only cross-cutting harness env (`PORT`, `FACILITATOR_URL`, `RESOURCE_SERVER_URL`, `ENDPOINT_PATH`, `MOCK_FACILITATOR_URL`). Each `mechanisms_<id>.json` holds:

- **`env`** — map of env key → `{ required: boolean, roles: ["server"|"client"|"facilitator", ...] }`. Every key a role reads (including unprefixed ones like `TVM_PROVIDER` or `EVM_PERMIT2_ASSET`) is declared here; [`src/mechanisms.ts`](src/mechanisms.ts) has no hardcoded role override table. Prefix (`SERVER_` / `CLIENT_` / `FACILITATOR_`) is only a fallback for undeclared keys.
- **`testnet` / `mainnet`** — `name`, `caip2`, optional `rpcUrlDefault`, optional `permit2Asset`/`permit2AssetName`. RPC env is pure convention, not declared: an operator sets `${ID}_TESTNET_RPC_URL` / `${ID}_MAINNET_RPC_URL` (e.g. `EVM_TESTNET_RPC_URL`), and the harness injects it into every spawned component as `${ID}_RPC_URL`. Set `rpcUrlRequired: true` on a mode with no `rpcUrlDefault` and no free public endpoint at all (a network whose SDK has no built-in node default, unlike e.g. Hedera/Keeta) so the harness fails fast at startup — with the missing input key named in the same preflight list as other required env — instead of deep inside a scenario run. Network identity defaults (`${ID}_NETWORK`) fall back to catalog `testnet.caip2` via `resolveNetworkCaip2`.
- **`routes`** — one canonical definition per paid HTTP path: `scheme`, `sdks`, `assetTransferMethod`, `schemeOptions`, declared `extensions`, required `price`, and optional `settlementOverride`. Handlers always return `{ message: "Protected endpoint accessed successfully", timestamp }`. The loader injects `network` (the file id) — routes never declare it themselves.

CI family selection ([`scripts/ci-select-families.sh`](scripts/ci-select-families.sh) → [`scripts/ci-select-families.ts`](scripts/ci-select-families.ts)) prints families whose catalog `required: true` keys are all set — no per-family hardcoding in the shell script.

Every SDK reads this same set of files. The harness ([`src/mechanisms.ts`](src/mechanisms.ts)) merges `mechanisms_global.json` with every `mechanisms_<id>.json` and derives component configs from the result:

- **Routes** → `routes` whose `sdks` include the language become server `endpoints` when no local `endpoints` overlay
- **`protocolFamilies` / `schemes` / `evm.assetTransferMethods`** → union of values on that SDK’s route list
- **`extensions`** → union of route `extensions` from the catalog (clients omit `bazaar`; they consume declarations but do not implement discovery)
- **Environment** → derived from each network's `env` for networks present in that SDK’s routes, filtered to the requesting role
- **Legacy v1** under `legacy/` is **not** driven by this catalog

Resource servers resolve the same data at boot — payment middleware config **and** route handlers — through a per-language loader: [`servers/typescript/catalog.ts`](servers/typescript/catalog.ts), [`servers/python/catalog.py`](servers/python/catalog.py), [`servers/go/catalog.go`](servers/go/catalog.go). No framework entrypoint hardcodes a path, price, or extension; each loops over its resolved routes. The harness passes the catalog directory in `E2E_MECHANISMS_CATALOG`, and each loader falls back to walking up to `e2e/config/` so a server still runs standalone from its own directory.

Route support is **listed** on each route via `sdks`, never inferred from a cartesian product. Scheme **registration** stays in the language-root client/server modules and facilitator mains.

## Add a mechanism

Adding a paid route to every SDK that should serve it is a catalog edit:

1. **Define the route** — add an entry under `routes` in the relevant `config/mechanisms_<id>.json`, keyed by its path, with `scheme`, `sdks` (e.g. `["typescript", "go", "python"]`), and `price`. Add `extensions`, `schemeOptions`, or `settlementOverride` only where the route needs them.
2. **Register the scheme once per language**, if it is new: server module (`servers/<lang>/`), client module (`clients/<lang>/`), and the facilitator main.

Servers pick up the route, its `402` payment requirements, and its handler with no per-framework edit. A surface that serves less than its SDK’s list can declare the narrowing in a local `test.config.json` (`excludeSchemes` / `excludeNetworks`); the harness applies it to the derived endpoints and forwards it to the server process (`E2E_EXCLUDE_SCHEMES` / `E2E_EXCLUDE_NETWORKS`), so declared and mounted routes cannot diverge.

After a server reports healthy, the harness requests every paid route it declares without payment. A `404`/`405` means the catalog lists a route the server never mounted, and fails startup immediately instead of silently dropping test coverage; any other status means the payment middleware owns the path, so payment-time failures stay the test suite’s job to report.

## Add a network

Four edits, no catalog type to touch:

1. **Catalog** — add [`config/mechanisms_<id>.json`](config/) with `env` (per-key `{ required, roles }`), `testnet`/`mainnet` (RPC input keys are pure convention: `${ID}_TESTNET_RPC_URL` / `${ID}_MAINNET_RPC_URL`), and `routes`. Mark wallet credentials `required: true` so CI ([`scripts/ci-select-families.sh`](scripts/ci-select-families.sh)) and harness preflight pick up the family automatically.
2. **Server** — register the scheme in `servers/<lang>/` (e.g. [`servers/typescript/config.ts`](servers/typescript/config.ts) / [`servers/python/config.py`](servers/python/config.py) / [`servers/go/config.go`](servers/go/config.go)).
3. **Client** — register the scheme in `clients/<lang>/` (e.g. [`clients/typescript/client.ts`](clients/typescript/client.ts) / [`clients/python/client.py`](clients/python/client.py) / [`clients/go/client.go`](clients/go/client.go)).
4. **Facilitator** — register the scheme in [`facilitators/typescript`](facilitators/typescript) / [`facilitators/go`](facilitators/go) / [`facilitators/python`](facilitators/python).

Also add `SERVER_*` / `CLIENT_*` / `FACILITATOR_*` secrets to [`.env-local`](.env-local) and the [Environment Variables](#environment-variables) section below. HTTP frameworks, Next, and MCP all pick up routes and scheme registration from the language-root modules — no per-framework CAIP-2 tables. Custom client surfaces (e.g. svm-smart-wallet) keep a local `test.config.json` overlay for narrowing (`protocolFamilies`, `facilitators`, extra env) — not a separate catalog route.

## Add an HTTP framework

| SDK | Steps |
|-----|--------|
| TypeScript | Add `clients/typescript/http/<name>/index.ts` or `servers/typescript/http/<name>/index.ts` using the language-root helpers (`../../client.ts` / `../../index.ts` for servers); add the adapter dep to the language `package.json`. Vanilla components need no local `test.config.json`. |
| Go / Python | Add component dir with `main.go` / `main.py` + module file. `setup.sh` runs language defaults. Vanilla components need no local `test.config.json`. |

## Custom flows (escape hatches)

These keep local `test.config.json` overlays and/or special orchestration — not just a catalog append:

| Flow | Where it lives |
|------|----------------|
| Batch-settlement multi-phase | Catalog `routes` entries + orchestration in [`test.ts`](test.ts) + shared scheme registration |
| Gas sponsoring / Permit2 coldstart | Route `schemeOptions.coldstart` + declared gas `extensions` + fund/revoke/drain in `test.ts` + facilitator extension registration |
| Swig smart wallet | Client overlay [`clients/typescript/http/svm-smart-wallet/test.config.json`](clients/typescript/http/svm-smart-wallet/test.config.json) (`protocolFamilies`, `facilitators`, Swig env) + [`scripts/swig-setup.ts`](scripts/swig-setup.ts); uses catalog route `/exact/svm` |
| Legacy (v1) | `legacy/` trees only — separate configs; do not extend the mechanisms catalog for v1 |

If an SDK implements a route end-to-end (client + server + facilitator), list it in that route’s `sdks`. Omit only when the mechanism package is missing (e.g. Go has no TVM; Python/Go have no AVM/NEAR/XRPL; Python has no SVM upto).

## Legacy

`legacy/` is always discovered for v1 coverage. It is intentionally outside the v2 family catalog. New v2 mechanisms do **not** require legacy changes unless you explicitly want v1 parity.

## Setup

### First Time Setup

Install all dependencies (TypeScript via pnpm, Go, Python):

```bash
pnpm install:all
```

This will:

1. Install TypeScript dependencies via `pnpm install` (including `servers/typescript` / `clients/typescript`)
2. Run per-component setup: local `install.sh`/`build.sh` when present, otherwise language defaults (`go mod tidy` / `go build`, `uv sync`)
3. Handle nested directories (like `external-proxies/` and `local/`)

For legacy (v1) implementations as well:

```bash
pnpm install:all:legacy
```

### Individual Setup

If you only want to set up v2 implementations:

```bash
pnpm setup
```

Or manually for a specific Go/Python component:

```bash
cd facilitators/go
go mod tidy && go build -o go .
```

### Wallet status

Print facilitator / client / server addresses plus facilitator native and client payment-token balances for every family whose catalog-required env keys are set.

```bash
pnpm wallet:status
pnpm wallet:status --mainnet
```

## Usage

### Interactive Test Mode

```bash
pnpm test
```

Launches an interactive CLI where you can select:
- **Facilitators** - Payment verification/settlement services (Go, TypeScript, Python)
- **Servers** - Protected endpoints requiring payment (Express, Gin, Hono, Next.js, FastAPI, Flask, etc.)
- **Clients** - Payment-capable HTTP clients (axios, fetch, httpx, requests, etc.)
- **Extensions** - Additional features like Bazaar discovery
- **Protocols** - EVM, SVM, AVM, Aptos, Concordium, Hedera, NEAR, Starknet, Stellar, and/or TVM networks
- **Payment schemes** (when multiple apply) - `exact`, `upto`, or `batch-settlement`
- **Payment flows** (when multiple apply) - `authorization`, `upfront`, or `escrow`
- **Asset transfer methods** (when multiple apply) - `eip3009`, `permit2`, `sequence`, or `ticketSequence`

Every valid combination of your selections will be tested. For example, selecting 2 facilitators, 3 servers, and 2 clients will generate and run all compatible test scenarios.

### Minimized Test Mode

```bash
pnpm test --min
```

Same interactive CLI, but with intelligent test minimization:

- **90% fewer tests** compared to full mode
- Each selected component is tested at least once across all variations
- Skips redundant combinations that provide no additional coverage
- Example: `legacy/typescript/http/hono` (v1 only) tests once, while `typescript/http/express` (v1+v2, EVM+SVM) tests all 4 combinations

Perfect for rapid iteration during development while maintaining comprehensive coverage.

### Verbose Logging

```bash
pnpm test -v
pnpm test --min -v
```

Add the `-v` flag to any command for verbose output:

- Prints all facilitator logs
- Prints all server logs
- Prints all client logs
- Shows detailed information after each test scenario

Useful for debugging test failures or understanding the payment flow.

## Wallet Safety Warning

**Use dedicated test wallets only. Do NOT use wallets that hold real funds.**

The test suite moves ETH between the configured wallets during a run. Funds stay
within the set of wallets defined in `.env`, but individual wallet balances will
change unpredictably:

- **ETH is transferred** from the facilitator wallet to the client wallet so the
  client can pay gas for granting and revoking Permit2 approvals between tests.
- **ETH is swept** from the client wallet back to the facilitator after revocation
  to create a zero-balance state, which is required to exercise the facilitator's
  gasless funding step.
- **Token approvals are granted and revoked** on the client wallet as part of
  normal test flow.

While no funds leave the configured wallet set, the client wallet's ETH balance
will be drained to near-zero between tests. Do not rely on any particular wallet
having a stable balance during or after a run.

## Environment Variables

Copy [`.env-local`](.env-local) to `.env` and fill in values. Required wallet/payee keys are declared per network in `config/mechanisms_<id>.json` (`env` with `required: true`); the template lists those placeholders.

```bash
# Client wallets (⚠️ TEST WALLETS ONLY — balances will be swept during runs)
CLIENT_EVM_PRIVATE_KEY=0x...        # EVM private key for client payments
CLIENT_SVM_PRIVATE_KEY=...          # Solana private key for client payments
CLIENT_AVM_PRIVATE_KEY=...          # Algorand private key for client payments
CLIENT_APTOS_PRIVATE_KEY=...        # Aptos private key for client payments (hex string)
CLIENT_CCD_PRIVATE_KEY=...         # Concordium private key for client payments
CLIENT_CCD_ADDRESS=...            # Concordium account address for client payments
CLIENT_HEDERA_ACCOUNT_ID=0.0....    # Hedera account id for client payments
CLIENT_HEDERA_PRIVATE_KEY=0x...     # Hedera ECDSA private key for client payments
CLIENT_KEETA_MNEMONIC=...           # Keeta mnemonic for client payments
CLIENT_STELLAR_PRIVATE_KEY=...      # Stellar private key for client payments
CLIENT_TVM_PRIVATE_KEY=...          # TVM private key for client payments
CLIENT_NEAR_ACCOUNT_ID=...          # NEAR payer account id that owns the access key
CLIENT_NEAR_PRIVATE_KEY=ed25519:... # NEAR private key for that payer account
CLIENT_XRPL_SEED=s...               # XRPL seed for client payments (payer signs and pays fees)
CLIENT_STARKNET_ADDRESS=0x...       # Starknet payer account contract address
CLIENT_STARKNET_PRIVATE_KEY=0x...   # Starknet private key for that payer account (payer needs no gas)

# Server payment addresses
SERVER_EVM_ADDRESS=0x...            # Where servers receive EVM payments
SERVER_SVM_ADDRESS=...              # Where servers receive Solana payments
SERVER_AVM_ADDRESS=...              # Where servers receive Algorand payments
SERVER_APTOS_ADDRESS=0x...          # Where servers receive Aptos payments
SERVER_CCD_ADDRESS=...              # Where servers receive Concordium payments
SERVER_HEDERA_ADDRESS=0.0....       # Where servers receive Hedera payments
SERVER_KEETA_ADDRESS=keeta_...      # Where servers receive Keeta payments
SERVER_STELLAR_ADDRESS=...          # Where servers receive Stellar payments
SERVER_TVM_ADDRESS=...              # Where servers receive TVM payments
SERVER_NEAR_ADDRESS=...             # Where servers receive NEAR payments (merchant account)
SERVER_XRPL_ADDRESS=r...            # Where servers receive XRPL payments
SERVER_STARKNET_ADDRESS=0x...       # Where servers receive Starknet payments

# Facilitator wallets (⚠️ TEST WALLETS ONLY — used to fund/drain client between tests)
FACILITATOR_EVM_PRIVATE_KEY=0x...   # EVM private key for facilitator
FACILITATOR_SVM_PRIVATE_KEY=...     # Solana private key for facilitator
FACILITATOR_AVM_PRIVATE_KEY=...     # Algorand private key for facilitator
FACILITATOR_APTOS_PRIVATE_KEY=...   # Aptos private key for facilitator (hex string)
FACILITATOR_CCD_PRIVATE_KEY=...    # Concordium private key for facilitator
FACILITATOR_CCD_ADDRESS=...       # Concordium account address for facilitator
FACILITATOR_HEDERA_ACCOUNT_ID=0.0... # Hedera fee payer account id for facilitator
FACILITATOR_HEDERA_PRIVATE_KEY=0x... # Hedera ECDSA private key for facilitator
FACILITATOR_KEETA_MNEMONIC=...      # Keeta mnemonic for facilitator
FACILITATOR_STELLAR_PRIVATE_KEY=... # Stellar private key for facilitator
FACILITATOR_TVM_PRIVATE_KEY=...     # TVM private key for facilitator
FACILITATOR_NEAR_ACCOUNT_ID=...     # NEAR relayer account id (submits meta-tx, sponsors gas)
FACILITATOR_NEAR_PRIVATE_KEY=ed25519:... # NEAR relayer private key
# XRPL needs no facilitator wallet — the facilitator is keyless (payer signs and pays fees)
FACILITATOR_STARKNET_ADDRESS=0x...  # Starknet executor account address (pays every settlement fee)
FACILITATOR_STARKNET_PRIVATE_KEY=0x... # Starknet private key for that executor account

# Concordium network override
CCD_NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27  # Optional; defaults to testnet
CCD_TESTNET_RPC_URL=grpc.testnet.concordium.com:20000  # Optional; defaults by network

# TVM support
TVM_PROVIDER=tonapi                 # Optional: toncenter (default) or tonapi
TVM_TONAPI_API_KEY=...              # Required when TVM_PROVIDER=tonapi
TVM_TONCENTER_API_KEY=...           # Recommended when TVM_PROVIDER=toncenter
TVM_TESTNET_RPC_URL=...             # Optional custom provider base URL (toncenter or tonapi, per TVM_PROVIDER)
```

Every network's RPC endpoint follows the same convention: set `${ID}_TESTNET_RPC_URL` / `${ID}_MAINNET_RPC_URL` (e.g. `EVM_TESTNET_RPC_URL`, `XRPL_MAINNET_RPC_URL`) to override the catalog default; the harness injects it into spawned components as `${ID}_RPC_URL`.

To run Python SDK TVM e2e scenarios through TonAPI instead of Toncenter:

```bash
cd e2e
TVM_PROVIDER=tonapi \
TVM_TONAPI_API_KEY=<tonapi-key> \
pnpm test --testnet --families=tvm --facilitators=python --clients=python/http/httpx,python/http/requests --servers=python/http/fastapi,python/http/flask --min -v
```

Catalog dimensions can also be filtered from the CLI (`pnpm test --help` for the full list):

```bash
pnpm test --testnet --min --families=evm --sdk=ts --paymentflow=upfront --assetTransferMethod=eip3009
```

`--sdk` keeps scenarios whose client, server, and facilitator are that language (`ts` / `typescript`, `py` / `python`, `go`). `--paymentflow` and `--assetTransferMethod` match the catalog route fields (omitted `paymentFlow` is `authorization`).

Optional environment variables (batch-settlement scheme):

```bash
SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=0x...              # optional: self-managed receiver authorizer (omit to delegate to facilitator /supported)
SERVER_SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=...                # server hot key that signs upto settlement vouchers (no SOL required)
CLIENT_EVM_BATCH_SETTLEMENT_VOUCHER_SIGNER_PRIVATE_KEY=0x...  # EOA the client uses to sign vouchers
EVM_BATCH_SETTLEMENT_RECOVERY=true                            # test client state-loss recovery scenario (default: true)
```

Optional environment variables for XRPL issued-currency tests are generated by
`pnpm xrpl:iou:setup`:

```bash
SERVER_XRPL_SEED=s...             # Payee seed used only to initialize its trust line
SERVER_XRPL_ASSET=USD             # Self-issued Testnet currency code
SERVER_XRPL_AMOUNT=1              # Exact IOU amount per payment
SERVER_XRPL_ISSUER=r...           # Self-managed Testnet issuer address
XRPL_IOU_ISSUER_SEED=s...         # Issuer seed used only by the setup script
XRPL_IOU_PAYER_BALANCE=1000       # Target payer balance maintained by setup
XRPL_IOU_TRUST_LIMIT=1000000      # Payer/payee trust-line limit
```

### Account Setup Instructions

#### XRPL Testnet Issued Currency

Create or reuse a dedicated Testnet issuer, payer, and payee fixture:

```bash
pnpm xrpl:iou:setup
pnpm test --testnet --min --families=xrpl --versions=2
```

The setup script uses the XRPL Testnet faucet to fund missing accounts, enables
DefaultRipple on the issuer, creates payer and payee trust lines, issues test `USD`
to the payer, and saves the fixture to the git-ignored `e2e/.env`. Re-running it
reuses the saved accounts and replenishes the payer when needed. The `USD` code is
only an e2e fixture; it is not a default asset in the XRPL SDK.

See the [XRPL Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets)
and [issued-token setup](https://xrpl.org/docs/tutorials/tokens/fungible-tokens/issue-a-fungible-token).

#### Stellar Testnet

You need **three separate Stellar accounts** for e2e tests (client, server, facilitator):

1. Go to [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot, then copy the `Secret` and `Public` keys so you can use them.
2. Add USDC trustline (required for client and server): go to [Fund Account](https://lab.stellar.org/account/fund) ➡️ Paste your `Public Key` ➡️ Add USDC Trustline ➡️ paste your `Secret key` ➡️ Sign transaction ➡️ Add Trustline.
3. Get testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Stellar network).

> **Note:** The facilitator account only needs XLM (step 1). Client and server accounts need all three steps.
##### TON testnet funding for TVM e2e and examples

- **Testnet TON**: use [@testgiver_ton_bot](https://t.me/testgiver_ton_bot) to fund the facilitator and payer wallets with TON for relay fees. The facilitator wallet must hold **at least 1.1 TON** before running tests.
- **Testnet USDT**: the payer wallet also needs testnet USDT. Open the [TON transfer link](https://app.tonkeeper.com/transfer/kQDNUDJC0iQvJoZp0ml-YteL1NtTXKphU03CTI5v4VtBhGYs?amount=49000000&bin=te6cckEBAQEAFgAAKClXdJkAAAAAAAAAAAAAAAAAmJaAhDUekg) or scan the QR code below to get them. The facilitator wallet only needs TON.
- **Note:** the facilitator uses a highload-wallet-v3 account, so the facilitator's wallet address differs from your W5 address — fund the highload-v3 address, not the W5 one derived from the same key.
  <img width="228" height="228" alt="QR code for the testnet USDT transfer link" src="https://github.com/user-attachments/assets/da09ad03-388d-4960-88bf-afbacf4a7c65" />

#### Keeta Testnet

You need **three separate Keeta accounts** for e2e tests (client, server, facilitator):

1. Go to [Keeta Testnet Wallet](https://wallet.test.keeta.com/) and follow the steps to create your wallet. Make sure to save your mnemonic (seed phrase) to keep access to your wallet. To get your Keeta address, click on "Receive" and copy the deposit address (starting with `keeta_`).
2. Use the [Keeta Testnet Faucet](https://faucet.test.keeta.com/) to send Testnet KTA to your wallet.
3. To get Testnet USDC on Keeta, go to the "Receive" page in the wallet, click on "Any token from Keeta Testnet", select "USDC from Base (Sepolia) Testnet" and copy the deposit address (starting with `0x`). Then go the [Circle Faucet](https://faucet.circle.com/), select Base network and enter your Base deposit address.

> **Note:** The facilitator account only needs KTA (step 2). Client and server accounts need all three steps.

#### NEAR Testnet

You need **three separate NEAR testnet accounts** for e2e tests — client (payer), server (merchant), and facilitator (relayer):

1. Create three testnet accounts (e.g. via [MyNearWallet testnet](https://testnet.mynearwallet.com/) or `near create-account`); export each account's private key (`ed25519:...`) — e.g. from `~/.near-credentials/testnet/<account>.json`.
2. Fund the **facilitator (relayer)** account with testnet NEAR for gas from the [NEAR faucet](https://near-faucet.io/). The relayer submits the NEP-366 `SignedDelegate` and sponsors gas, so the payer spends zero gas.
3. Give the **client (payer)** the payment token. The default asset is **wNEAR** (`wrap.testnet`, a NEP-141): wrap NEAR via `wrap.testnet` `near_deposit`. Both payer and merchant must be `storage_deposit`-registered on the token contract.

> **Note:** payer key = `CLIENT_NEAR_*`, relayer key = `FACILITATOR_NEAR_*`, merchant = `SERVER_NEAR_ADDRESS`. `CLIENT_NEAR_ACCOUNT_ID` is required because a NEAR private key identifies a public key, but the signer must also know which account owns that access key to read its nonce and set the delegated action `senderId`. Override the token with `SERVER_NEAR_ASSET` / `SERVER_NEAR_AMOUNT` (defaults: `wrap.testnet` / `1000000000000000000000` = 0.001 wNEAR; set them to a NEP-141 like Circle USDC for stablecoin runs).

#### Starknet Sepolia

You need **two deployed Starknet Sepolia accounts** for e2e tests, client (payer) and facilitator (executor), plus a merchant address for the server:

1. The payer account must use an account class implementing SNIP-9 v2 (it must expose `execute_from_outside_v2` and `is_valid_outside_execution_nonce`); current Argent and Braavos classes do, older ones do not, and the payer will otherwise be rejected at verification. The executor can be any deployed Starknet account that signs v3 `INVOKE` transactions. Create and deploy the payer and executor accounts (e.g. `sncast account create` + `sncast account deploy`, or any Starknet wallet), then export each account's address (`0x...`) and private key (`0x...`). A Starknet account is a contract, so it must be deployed before it can sign; an undeployed (counterfactual) address will not work. See the [Starknet Sepolia quickstart](https://docs.starknet.io/build/quickstart/sepolia). `SERVER_STARKNET_ADDRESS` only receives the transfer, never signs, and needs no key.
2. Fund the facilitator (executor) account with Sepolia STRK from the [Starknet faucet](https://faucet.starknet.io/); it submits the SNIP-9 `execute_from_outside_v2` call and pays the whole transaction fee, so it must stay funded. The payer needs a one-time STRK balance too, because deploying its account contract in step 1 costs gas. Once deployed, the payer never pays a fee again: it only signs.
3. Give **only the client (payer)** the payment token. The default asset is Circle USDC on Sepolia, `0x0512feAc6339Ff7889822cb5aA2a86C848e9D392bB0E3E237C008674feeD8343` (6 decimals), from the [Circle faucet](https://faucet.circle.com/) (select Starknet Sepolia).

```bash
pnpm test --testnet --min --families=starknet --versions=2
```

> **Note:** payer = `CLIENT_STARKNET_ADDRESS` + `CLIENT_STARKNET_PRIVATE_KEY`, executor = `FACILITATOR_STARKNET_ADDRESS` + `FACILITATOR_STARKNET_PRIVATE_KEY`, merchant = `SERVER_STARKNET_ADDRESS`. The payer needs **no STRK and no ETH**, only a token balance: settlement is fully sponsored, and the executor account is the only one that ever pays fees. `CLIENT_STARKNET_ADDRESS` is required because a Starknet private key does not identify the account contract that authorizes it. `PaymentRequirements.extra.feePayer` is advertised by the facilitator through `/supported` and copied verbatim by the resource server, so a Starknet 402 cannot be served without a facilitator that advertises a fee payer.

## Example Session

```bash
$ pnpm test --min

🎯 Interactive Mode
==================

✔ Select facilitators › go, typescript
✔ Select servers › typescript/http/express, typescript/http/hono, legacy/typescript/http/express
✔ Select clients › axios, fetch, httpx
✔ Select extensions › bazaar
✔ Select protocol families › EVM, SVM, Aptos, Hedera, Keeta, Stellar, TVM

📊 Coverage-Based Minimization
Total scenarios: 156
Selected scenarios: 18 (88.5% reduction)

✅ Passed: 18
❌ Failed: 0
```
