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
    asset: "17be3c3dc67ddf193b8f64bfc2421826407470f88b3dab68184ebffebdd57f59",
    extra: {
      name: "Casper X402 Token",
      version: "1",
    },
  },
}
```

## Facilitator

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorCasperSigner } from "@x402/casper";
import { ExactCasperScheme } from "@x402/casper/exact/facilitator";

const signer = await createFacilitatorCasperSigner(
  process.env.CASPER_FACILITATOR_PRIVATE_KEY!,
  undefined,
  {
    rpcUrlConfig: { "casper:casper-test": "https://node.testnet.casper.network/rpc" },
    speculativeRpcUrlConfig: process.env.CASPER_SPECULATIVE_RPC_URL
      ? { "casper:casper-test": process.env.CASPER_SPECULATIVE_RPC_URL }
      : undefined,
    preflightHooks: {
      getBalance: async params => {
        // Read CEP-18 balance for params.account.
        return 0n;
      },
      getAuthorizationState: async params => {
        // Read CEP-3009 authorization_state for params.payer and params.nonce.
        return "unused";
      },
      assertTransferWithAuthorizationSupported: async params => {
        // Fail if params.asset does not expose transfer_with_authorization.
      },
    },
  },
);

const facilitator = new x402Facilitator().register("casper:*", new ExactCasperScheme(signer));
```

The default facilitator signer fails closed unless preflight hooks are supplied. This prevents verification from accidentally skipping balance, nonce-state, or CEP-3009 contract support checks.

`speculativeRpcUrlConfig` is optional. When it contains a URL for the payment network, facilitator `verify()` runs Casper speculative execution against that endpoint as a final check. The speculative endpoint is network-specific and is often exposed separately from standard node JSON-RPC, commonly on port `7778`.

## Integration Tests

Live integration tests require a funded Casper testnet account and a CEP-3009-enabled CEP-18 token:

```bash
CASPER_CLIENT_PRIVATE_KEY=... \
CASPER_FACILITATOR_PRIVATE_KEY=... \
CASPER_PAY_TO=00... \
CASPER_ASSET=17be3c3dc67ddf193b8f64bfc2421826407470f88b3dab68184ebffebdd57f59 \
CASPER_TOKEN_NAME="Casper X402 Token" \
CASPER_TOKEN_VERSION=1 \
CASPER_NETWORK=casper:casper-test \
CASPER_RPC_URL=https://node.testnet.casper.network/rpc \
pnpm --filter @x402/casper test:integration
```
