# E2E Tests

End-to-end test suite for validating client-server-facilitator communication across languages and frameworks.

## Setup

### First Time Setup

Install all dependencies (TypeScript via pnpm, Go, Python):

```bash
pnpm install:all
```

This will:

1. Install TypeScript dependencies via `pnpm install`
2. Run `install.sh` and `build.sh` for all clients, servers, and facilitators
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

Or manually for a specific component:

```bash
cd facilitators/go
bash install.sh
bash build.sh
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
- **Protocols** - EVM, SVM, AVM, Aptos, Concordium, Hedera, Stellar, and/or TVM networks
- **Payment schemes** (when multiple apply) - `exact`, `upto`, or `batch-settlement`

Every valid combination of your selections will be tested. For example, selecting 2 facilitators, 3 servers, and 2 clients will generate and run all compatible test scenarios.

### Minimized Test Mode

```bash
pnpm test --min
```

Same interactive CLI, but with intelligent test minimization:

- **90% fewer tests** compared to full mode
- Each selected component is tested at least once across all variations
- Skips redundant combinations that provide no additional coverage
- Example: `legacy-hono` (v1 only) tests once, while `express` (v1+v2, EVM+SVM) tests all 4 combinations

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

Required environment variables (set in `.env` file):

```bash
# Client wallets (⚠️ TEST WALLETS ONLY — balances will be swept during runs)
CLIENT_EVM_PRIVATE_KEY=0x...        # EVM private key for client payments
CLIENT_SVM_PRIVATE_KEY=...          # Solana private key for client payments
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

# Server payment addresses
SERVER_EVM_ADDRESS=0x...            # Where servers receive EVM payments
SERVER_SVM_ADDRESS=...              # Where servers receive Solana payments
SERVER_APTOS_ADDRESS=0x...          # Where servers receive Aptos payments
SERVER_CCD_ADDRESS=...              # Where servers receive Concordium payments
SERVER_HEDERA_ADDRESS=0.0....       # Where servers receive Hedera payments
SERVER_KEETA_ADDRESS=keeta_...      # Where servers receive Keeta payments
SERVER_STELLAR_ADDRESS=...          # Where servers receive Stellar payments
SERVER_TVM_ADDRESS=...              # Where servers receive TVM payments
SERVER_NEAR_ADDRESS=...             # Where servers receive NEAR payments (merchant account)
SERVER_XRPL_ADDRESS=r...            # Where servers receive XRPL payments

# Facilitator wallets (⚠️ TEST WALLETS ONLY — used to fund/drain client between tests)
FACILITATOR_EVM_PRIVATE_KEY=0x...   # EVM private key for facilitator
FACILITATOR_SVM_PRIVATE_KEY=...     # Solana private key for facilitator
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

# Concordium network override
CCD_NETWORK=ccd:4221332d34e1694168c2a0c0b3fd0f27  # Optional; defaults to testnet
CCD_GRPC_URL=grpc.testnet.concordium.com:20000    # Optional; defaults by network

# TVM support
TVM_PROVIDER=tonapi                 # Optional: toncenter (default) or tonapi
TONAPI_API_KEY=...                  # Required when TVM_PROVIDER=tonapi
TONAPI_BASE_URL=...                 # Optional custom TonAPI base URL
TONCENTER_API_KEY=...               # Recommended when TVM_PROVIDER=toncenter
```

To run Python SDK TVM e2e scenarios through TonAPI instead of Toncenter:

```bash
cd e2e
TVM_PROVIDER=tonapi \
TONAPI_API_KEY=<tonapi-key> \
pnpm test --testnet --families=tvm --facilitators=python --clients=httpx,requests --servers=fastapi,flask --min -v
```

Optional environment variables (batch-settlement scheme):

```bash
SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=0x... # server-side self-managed claim/refund signer
CLIENT_EVM_VOUCHER_SIGNER_PRIVATE_KEY=0x...      # EOA the client uses to sign vouchers
BATCH_SETTLEMENT_RECOVERY=true                   # test client state-loss recovery scenario (default: true)
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

## Example Session

```bash
$ pnpm test --min

🎯 Interactive Mode
==================

✔ Select facilitators › go, typescript
✔ Select servers › express, hono, legacy-express
✔ Select clients › axios, fetch, httpx
✔ Select extensions › bazaar
✔ Select protocol families › EVM, SVM, Aptos, Hedera, Keeta, Stellar, TVM

📊 Coverage-Based Minimization
Total scenarios: 156
Selected scenarios: 18 (88.5% reduction)

✅ Passed: 18
❌ Failed: 0
```
