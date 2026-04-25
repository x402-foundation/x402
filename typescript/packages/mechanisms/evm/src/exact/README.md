# Exact EVM Scheme (`@x402/evm/exact`)

The **exact** scheme is the default x402 payment scheme for EVM networks. The client pays the exact advertised price — no more, no less. It supports two on-chain transfer methods: **EIP-3009** (`transferWithAuthorization`) and **Permit2** (Uniswap's signature-based approval).

## Import Paths

| Role | Import |
|------|--------|
| Client | `@x402/evm/exact/client` |
| Server | `@x402/evm/exact/server` |
| Facilitator | `@x402/evm/exact/facilitator` |
| Client (V1 legacy) | `@x402/evm/exact/v1/client` |
| Facilitator (V1 legacy) | `@x402/evm/exact/v1/facilitator` |

## Client Usage

Register `ExactEvmScheme` with an `x402Client` to automatically handle payments for EVM-network services that use the `exact` scheme.

```typescript
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

const client = new x402Client();
client.register("eip155:*", new ExactEvmScheme(signer));
```

The client selects between EIP-3009 and Permit2 based on `paymentRequirements.extra.assetTransferMethod` (defaults to `eip3009`).

### Permit2 Approval

If the service requires Permit2, the client may need to approve the Permit2 contract first:

```typescript
import { createPermit2ApprovalTx, getPermit2AllowanceReadParams } from "@x402/evm/exact/client";
```

## Server Usage

Register `ExactEvmScheme` with an `x402ResourceServer` to protect routes with fixed-price payments.

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";

const server = new x402ResourceServer(facilitatorClient);
server.register("eip155:*", new ExactEvmScheme());
```

In your route config, set `scheme: "exact"` and `price` to the fixed amount:

```typescript
{
  "GET /weather": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",
      payTo: "0xYourAddress",
    },
  },
}
```

## Facilitator Usage

For custom facilitator implementations:

```typescript
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";

const scheme = new ExactEvmScheme({ signers: [wallet] });
```

## Supported Networks

Works on any EIP-155 compatible network. Common networks:

| Network | CAIP-2 ID |
|---------|-----------|
| Base Mainnet | `eip155:8453` |
| Base Sepolia | `eip155:84532` |

## Transfer Methods

| Method | Description |
|--------|-------------|
| EIP-3009 | `transferWithAuthorization` — gasless, single-signature transfer (default) |
| Permit2 | Uniswap Permit2 — signature-based approval + transfer via proxy contract |

## Gas Sponsoring Extensions (Permit2 only)

When using the Permit2 transfer method, the exact scheme integrates with two gas sponsoring extensions that let the **facilitator** pay for the client's Permit2 approval transaction on-chain. This is transparent to both server and client — the client SDK automatically detects advertised extensions and signs the appropriate data.

> Gas sponsoring does **not** apply to the EIP-3009 path, which is already gasless by design.

### EIP-2612 Gas Sponsoring

The preferred path. If the payment token supports [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) (gasless `permit`), the client signs an off-chain EIP-2612 permit and the facilitator calls `settleWithPermit` — bundling the approval and settlement in a single transaction with no gas cost to the client.

**Server:** Declare the extension in your route config and ensure the token's `name` and `version` are included in `extra` (the default for EIP-2612-compatible tokens):

```typescript
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";

{
  "GET /weather": {
    accepts: {
      scheme: "exact",
      price: "$0.001",
      network: "eip155:84532",
      payTo: "0xYourAddress",
    },
    extensions: {
      ...declareEip2612GasSponsoringExtension(),
    },
  },
}
```

**Client:** No additional setup required. `ExactEvmScheme` automatically checks for the `eip2612GasSponsoring` extension in the server's payment requirements and signs the permit when applicable.

**Facilitator:** Register the extension:

```typescript
import { EIP2612_GAS_SPONSORING } from "@x402/extensions";

facilitator.registerExtension(EIP2612_GAS_SPONSORING);
```

### ERC-20 Approval Gas Sponsoring

Fallback for tokens that **do not** support EIP-2612. The client signs a raw ERC-20 `approve(Permit2, MaxUint256)` transaction off-chain and includes it in the payment payload. The facilitator broadcasts this approval transaction on-chain before settling.

**Server:** Declare the extension and omit `name`/`version` from the token config to signal clients to skip EIP-2612:

```typescript
import { declareErc20ApprovalGasSponsoringExtension } from "@x402/extensions";

{
  "GET /weather": {
    accepts: { /* ... */ },
    extensions: {
      ...declareErc20ApprovalGasSponsoringExtension(),
    },
  },
}
```

**Client:** The signer must support transaction signing (`signTransaction`, `getTransactionCount`). `ExactEvmScheme` falls back to this path when EIP-2612 is not available.

**Facilitator:** Register with a signer that can broadcast transactions:

```typescript
import { createErc20ApprovalGasSponsoringExtension } from "@x402/extensions";

facilitator.registerExtension(createErc20ApprovalGasSponsoringExtension(erc20ApprovalSigner));
```

### Extension Priority

When **both** extensions are advertised, EIP-2612 takes priority. The client tries EIP-2612 first; if the token lacks `name`/`version` in `extra` (meaning it doesn't support EIP-2612), it falls back to ERC-20 approval gas sponsoring.

## Examples

- [Express server](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/express)
- [Fetch client](https://github.com/x402-foundation/x402/tree/main/examples/typescript/clients/fetch)
- [EIP-2612 gas sponsoring server](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/advanced/eip2612-gas-sponsoring.ts)

## See Also

- [Upto EVM Scheme](../upto/README.md) — usage-based billing with partial settlement
- [x402 Docs: Quickstart for Sellers](https://docs.x402.org/getting-started/quickstart-for-sellers)
- [x402 Docs: Quickstart for Buyers](https://docs.x402.org/getting-started/quickstart-for-buyers)
- [Exact EVM Scheme Specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md)
