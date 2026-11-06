# @x402/casper

TypeScript implementation of the x402 v2 `exact` scheme for Casper CEP-18 tokens with CEP-3009 `transfer_with_authorization`.

## Install

```bash
pnpm add @x402/casper
```

## Network Identifiers

- `casper:casper` - Casper Mainnet
- `casper:casper-test` - Casper Testnet

## Address And Asset Formats

- `asset`: 32-byte contract package hash as 64 hex characters. Do not include `0x` or `hash-`.
- `payTo`: 33-byte Casper address as 66 hex characters. Use the `00` account-hash prefix or `01` package-hash prefix.
- `extra.name`: required CEP-18 token name for the CEP-3009 EIP-712 domain.
- `extra.version`: required CEP-3009 EIP-712 domain version.

## Client

```ts
import { x402Client } from "@x402/core/client";
import { createClientCasperSigner } from "@x402/casper";
import { ExactCasperScheme } from "@x402/casper/exact/client";

const signer = await createClientCasperSigner(process.env.CASPER_CLIENT_PRIVATE_KEY!);
const client = new x402Client().register("casper:*", new ExactCasperScheme(signer));
```

## Server

```ts
import { x402ResourceServer } from "@x402/core/server";
import { ExactCasperScheme } from "@x402/casper/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("casper:*", new ExactCasperScheme());
```

Payment requirements must include the Casper EIP-712 domain fields:

```ts
{
  scheme: "exact",
  network: "casper:casper-test",
  payTo: "00...",
  price: {
    amount: "1",
    asset: "0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52",
    extra: {
      name: "csprUSD",
      version: "1",
    },
  },
}
```

The csprUSD testnet asset above is registered as the Casper testnet default asset. If you use a different asset in payment requirements, or a payment amount above the default client spend cap, configure client spend controls with `allowedAssets` or disable spend controls explicitly.

## Facilitator

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorCasperSigner } from "@x402/casper";
import { ExactCasperScheme } from "@x402/casper/exact/facilitator";
import { KeyAlgorithm } from "casper-js-sdk";

const signer = await createFacilitatorCasperSigner(
  process.env.CASPER_FACILITATOR_PRIVATE_KEY!,
  KeyAlgorithm.ED25519,
  {
    rpcUrlConfig: { "casper:casper-test": "https://node.testnet.casper.network/rpc" },
    speculativeRpcUrlConfig: process.env.CASPER_SPECULATIVE_RPC_URL
      ? { "casper:casper-test": process.env.CASPER_SPECULATIVE_RPC_URL }
      : undefined,
  },
);

const facilitator = new x402Facilitator().register("casper:*", new ExactCasperScheme(signer));
```

Facilitator `verify()` always performs live preflight checks after validating the payment shape and signature. If `speculativeRpcUrlConfig` contains a URL for the payment network, `verify()` runs Casper speculative execution against that endpoint and skips preflight checks; the simulation covers balance, nonce reuse, and contract entry-point failures. The speculative endpoint is network-specific and is often exposed separately from standard node JSON-RPC, commonly on port `7778`.

When no speculative RPC URL is configured for the payment network, `verify()` uses `rpcUrlConfig` or the SDK's default network RPC URL to run targeted checks: CEP-18 payer balance, CEP-3009 `authorization_state`, and support for `transfer_with_authorization` on the token package's active contract.

## Integration Tests

Live integration tests require a funded Casper testnet account and a CEP-3009-enabled CEP-18 token:

Create or reuse a dedicated Casper testnet account or wallet key, then fund any account that submits Casper transactions with testnet CSPR from the [CSPR.live testnet faucet](https://testnet.cspr.live/tools/faucet). CSPR is required for gas on Casper Testnet.

Use [testnet.cspr.trade](https://testnet.cspr.trade) to get wrapped CSPR (WCSPR) or csprUSD for the client payments.

```bash
CASPER_RUN_LIVE=1 \
CASPER_CLIENT_PRIVATE_KEY=... \
CASPER_CLIENT_PRIVATE_KEY_ALGORITHM=secp256k1 \
CASPER_FACILITATOR_PRIVATE_KEY=... \
CASPER_FACILITATOR_PRIVATE_KEY_ALGORITHM=secp256k1 \
CASPER_PAY_TO=00... \
CASPER_ASSET=0cb6f94834c60510d532b0ae077b18b4100874a4c867396d61c2b13c790ead52 \
CASPER_TOKEN_NAME="csprUSD" \
CASPER_TOKEN_VERSION=1 \
CASPER_NETWORK=casper:casper-test \
CASPER_RPC_URL=https://node.testnet.casper.network/rpc \
pnpm --filter @x402/casper test:integration
```

`CASPER_CLIENT_PRIVATE_KEY_ALGORITHM` and `CASPER_FACILITATOR_PRIVATE_KEY_ALGORITHM` are optional for ED25519 keys; set them to `secp256k1` for secp256k1 keys. `CASPER_SPECEXEC_RPC_URL` is optional and enables speculative execution during live verification when a Casper speculative execution endpoint is available.
