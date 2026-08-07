# Advanced x402 Client Examples

Advanced patterns for x402 TypeScript clients demonstrating builder pattern registration, payment lifecycle hooks, and network preferences.

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(privateKeyToAccount(evmPrivateKey)))
  .onBeforePaymentCreation(async ctx => {
    console.log("Creating payment for:", ctx.selectedRequirements.network);
  })
  .onAfterPaymentCreation(async ctx => {
    console.log("Payment created:", ctx.paymentPayload.x402Version);
  });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment("http://localhost:4021/weather");
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM, SVM, Stellar and/or Keeta private keys for making payments
- A running x402 server (see [server examples](../../servers/))
- Familiarity with the [basic fetch client](../fetch/)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `APTOS_PRIVATE_KEY` - Aptos Ed25519 private key for Aptos payments (optional; `all-networks`)
- `CCD_PRIVATE_KEY` - Concordium Ed25519 private key for Concordium payments (optional; `all-networks`)
- `CCD_ADDRESS` - Concordium account address for Concordium payments (optional; `all-networks`)
- `EVM_PRIVATE_KEY` - Ethereum private key for EVM payments
- `SVM_PRIVATE_KEY` - Solana private key for SVM payments
- `STELLAR_PRIVATE_KEY` - Stellar secret key (starts with `S`) for signing Stellar payments
- `HEDERA_ACCOUNT_ID` - Hedera account id for Hedera payments (optional)
- `HEDERA_PRIVATE_KEY` - Hedera **ECDSA** private key (0x-prefixed or DER-encoded) for Hedera payments (optional)
- `HEDERA_NETWORK` - Hedera network (optional, defaults to `hedera:testnet`)
- `KEETA_MNEMONIC` - Keeta mnemonic for Keeta payments
- `XRPL_SEED` - XRPL family seed (starts with `s`) for XRPL payments (optional; `all-networks`)
- `XRPL_NETWORK` - XRPL network CAIP-2 (optional, defaults to `xrpl:1` XRPL Testnet)
- `XRPL_WS_URL` - Custom XRPL WebSocket endpoint (optional, defaults to the public endpoint for `XRPL_NETWORK`)

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/advanced
```

3. Run the server

```bash
pnpm dev
```

### Account Setup Instructions

#### Stellar Testnet

Stellar accounts need to be created and funded with both XLM and USDC. Instructions:

1. Go to [Stellar Laboratory](https://lab.stellar.org/account/create) ➡️ Generate keypair ➡️ Fund account with Friendbot, then copy the `Secret` and `Public` keys so you can use them.
2. Add USDC trustline (required to transact USDC): go to [Fund Account](https://lab.stellar.org/account/fund) ➡️ Paste your `Public Key` ➡️ Add USDC Trustline ➡️ paste your `Secret key` ➡️ Sign transaction ➡️ Add Trustline.
3. Get testnet USDC from [Circle Faucet](https://faucet.circle.com/) (select Stellar network).

#### Keeta Testnet

To create a Keeta Testnet wallet:

1. Go to [Keeta Testnet Wallet](https://wallet.test.keeta.com/) and follow the steps to create your wallet. Make sure to save your mnemonic (seed phrase) to keep access to your wallet. To get your Keeta address, click on "Receive" and copy the deposit address (starting with `keeta_`).
2. Use the [Keeta Testnet Faucet](https://faucet.test.keeta.com/) to send Testnet KTA to your wallet.
3. To get Testnet USDC on Keeta, go to the "Receive" page in the wallet, click on "Any token from Keeta Testnet", select "USDC from Base (Sepolia) Testnet" and copy the deposit address (starting with `0x`). Then go the [Circle Faucet](https://faucet.circle.com/), select Base network and enter your Base deposit address.

#### Aptos Testnet

For testing on Aptos testnet, you can obtain test tokens from these faucets:

- **Test APT**: https://aptos.dev/network/faucet or through an account on [geomi.dev](https://geomi.dev/manage/faucet)
- **Test USDC**: https://faucet.circle.com/

#### Concordium Testnet

To get test CCD:

1. Set up [Concordium Wallet for Web](https://wallet.testnet.concordium.com/) on **Testnet**.
2. Open the account in the wallet.
3. Go to **Activity**.
4. Click **Request CCD**.
5. Wait for the test CCD transfer to arrive. Official guide: [Request CCD](https://docs.concordium.com/en/mainnet/docs/plt/setup-guide/request-ccd.html).

To get test PLT, there is no universal public faucet for arbitrary PLT symbols. Either:

1. Use a token issuer's own test distribution for the symbol you want to use, or
2. Request your own PLT issuance on testnet, then mint/distribute balances from the nominated governance account. Official guide: [Request PLT](https://docs.concordium.com/en/mainnet/tutorials/plt/request-plt.html).

#### XRPL Testnet

To create and fund an XRPL Testnet payer account:

1. Use the [XRPL Testnet faucet](https://xrpl.org/resources/dev-tools/xrp-faucets) to generate a funded account, and copy its family seed (starts with `s`) into `XRPL_SEED`.
2. Keep the [base reserve](https://xrpl.org/docs/concepts/accounts/reserves) funded (currently 1 XRP; the faucet funding is more than enough). The `all-networks` example pays in XRP drops, so no further setup is needed.
3. For issued-currency (IOU) payments, the payer needs a sufficient issued-currency balance, and the receiving account must hold a [trust line](https://xrpl.org/docs/concepts/tokens/fungible-tokens) to the issuer.

## Available Examples

Each example demonstrates a specific advanced pattern:

| Example | Command | Description |
| --- | --- | --- |
| `all-networks` | `pnpm dev:all-networks` | All supported networks with optional chain configuration |
| `builder-pattern` | `pnpm dev:builder-pattern` | Fine-grained network registration |
| `hooks` | `pnpm dev:hooks` | Payment lifecycle hooks |
| `preferred-network` | `pnpm dev:preferred-network` | Client-side network preferences |

## Testing the Examples

Start a server first:

```bash
cd ../../servers/express
pnpm dev
```

Then run the examples:

```bash
cd ../../clients/advanced
pnpm dev:builder-pattern
```

## Example: Builder Pattern Registration

Use the builder pattern for fine-grained control over which networks are supported and with which signers:

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactKeetaScheme } from "@x402/keeta/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const evmSigner = privateKeyToAccount(evmPrivateKey);
const mainnetSigner = privateKeyToAccount(mainnetPrivateKey);

// More specific patterns take precedence over wildcards
const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(evmSigner)) // All EVM networks
  .register("eip155:1", new ExactEvmScheme(mainnetSigner)) // Ethereum mainnet override
  .register("keeta:*", new ExactKeetaScheme(keetaSigner)) // All Keeta networks
  .register("solana:*", new ExactSvmScheme(svmSigner)) // All Solana networks
  .register("stellar:*", new ExactStellarScheme(stellarSigner)); // All Stellar networks

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment("http://localhost:4021/weather");
```

**Use case:**

- Different signers for mainnet vs testnet
- Separate keys for different networks
- Explicit control over supported networks

## Example: Payment Lifecycle Hooks

Register custom logic at different payment stages for observability and control:

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY);

const client = new x402Client()
  .register("eip155:*", new ExactEvmScheme(signer))
  .onBeforePaymentCreation(async context => {
    console.log("Creating payment for:", context.selectedRequirements);
    // Abort payment by returning: { abort: true, reason: "Not allowed" }
  })
  .onAfterPaymentCreation(async context => {
    console.log("Payment created:", context.paymentPayload.x402Version);
    // Send to analytics, database, etc.
  })
  .onPaymentCreationFailure(async context => {
    console.error("Payment failed:", context.error);
    // Recover by returning: { recovered: true, payload: alternativePayload }
  });

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment("http://localhost:4021/weather");
```

Available hooks:

- `onBeforePaymentCreation` — Run before payment creation (can abort)
- `onAfterPaymentCreation` — Run after successful payment creation
- `onPaymentCreationFailure` — Run when payment creation fails (can recover)

**Use case:**

- Log payment events for debugging and monitoring
- Custom validation before allowing payments
- Implement retry or recovery logic for failed payments
- Metrics and analytics collection

## Example: Preferred Network Selection

Configure client-side network preferences with automatic fallback:

```typescript
import { x402Client, wrapFetchWithPayment, type PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { ExactKeetaScheme } from "@x402/keeta/exact/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

// Define network preference order (most preferred first)
const networkPreferences = ["eip155:", "keeta:", "solana:", "stellar:"];

const preferredNetworkSelector = (
  _x402Version: number,
  options: PaymentRequirements[],
): PaymentRequirements => {
  // Try each preference in order
  for (const preference of networkPreferences) {
    const match = options.find(opt => opt.network.startsWith(preference));
    if (match) return match;
  }
  // Fallback to first mutually-supported option
  return options[0];
};

const client = new x402Client(preferredNetworkSelector)
  .register("eip155:*", new ExactEvmScheme(evmSigner))
  .register("keeta:*", new ExactKeetaScheme(keetaSigner))
  .register("solana:*", new ExactSvmScheme(svmSigner))
  .register("stellar:*", new ExactStellarScheme(stellarSigner));

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPayment("http://localhost:4021/weather");
```

**Use case:**

- Prefer payments on specific chains
- User preference settings in wallet UIs

## Hook Best Practices

1. **Keep hooks fast** — Avoid blocking operations
2. **Handle errors gracefully** — Don't throw in hooks
3. **Log appropriately** — Use structured logging
4. **Avoid side effects in before hooks** — Only use for validation
