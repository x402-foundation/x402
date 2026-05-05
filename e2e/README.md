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
- **Facilitators** - Payment verification/settlement services (Go, TypeScript)
- **Servers** - Protected endpoints requiring payment (Express, Gin, Hono, Next.js, FastAPI, Flask, etc.)
- **Clients** - Payment-capable HTTP clients (axios, fetch, httpx, requests, etc.)
- **Extensions** - Additional features like Bazaar discovery
- **Protocols** - EVM, SVM, Aptos, and/or Hedera networks
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
CLIENT_HEDERA_ACCOUNT_ID=0.0....    # Hedera account id for client payments
CLIENT_HEDERA_PRIVATE_KEY=0x...     # Hedera ECDSA private key for client payments
CLIENT_STELLAR_PRIVATE_KEY=...      # Stellar private key for client payments

# Server payment addresses
SERVER_EVM_ADDRESS=0x...            # Where servers receive EVM payments
SERVER_SVM_ADDRESS=...              # Where servers receive Solana payments
SERVER_APTOS_ADDRESS=0x...          # Where servers receive Aptos payments
SERVER_HEDERA_ADDRESS=0.0....       # Where servers receive Hedera payments
SERVER_STELLAR_ADDRESS=...          # Where servers receive Stellar payments

# Facilitator wallets (⚠️ TEST WALLETS ONLY — used to fund/drain client between tests)
FACILITATOR_EVM_PRIVATE_KEY=0x...   # EVM private key for facilitator
FACILITATOR_SVM_PRIVATE_KEY=...     # Solana private key for facilitator
FACILITATOR_APTOS_PRIVATE_KEY=...   # Aptos private key for facilitator (hex string)
FACILITATOR_HEDERA_ACCOUNT_ID=0.0... # Hedera fee payer account id for facilitator
FACILITATOR_HEDERA_PRIVATE_KEY=0x... # Hedera ECDSA private key for facilitator
FACILITATOR_STELLAR_PRIVATE_KEY=... # Stellar private key for facilitator
```

Optional environment variables (batch-settlement scheme):

```bash
SERVER_EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=0x... # server-side self-managed claim/refund signer
CLIENT_EVM_VOUCHER_SIGNER_PRIVATE_KEY=0x...      # EOA the client uses to sign vouchers
BATCH_SETTLEMENT_RECOVERY=true                   # test client state-loss recovery scenario (default: true)
```

### Account Setup Instructions

#### Stellar Testnet

You need **three separate Stellar accounts** for e2e tests (client, server, facilitator):

1. Go to [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot, then copy the `Secret` and `Public` keys so you can use them.
2. Add USDC trustline (required for client and server): go to [Fund Account](https://lab.stellar.org/account/fund) ➡️ Paste your `Public Key` ➡️ Add USDC Trustline ➡️ paste your `Secret key` ➡️ Sign transaction ➡️ Add Trustline.
3. Get testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Stellar network).

> **Note:** The facilitator account only needs XLM (step 1). Client and server accounts need all three steps.

## Example Session

```bash
$ pnpm test --min

🎯 Interactive Mode
==================

✔ Select facilitators › go, typescript
✔ Select servers › express, hono, legacy-express
✔ Select clients › axios, fetch, httpx
✔ Select extensions › bazaar
✔ Select protocol families › EVM, SVM, Aptos, Hedera, Stellar

📊 Coverage-Based Minimization
Total scenarios: 156
Selected scenarios: 18 (88.5% reduction)

✅ Passed: 18
❌ Failed: 0
```
