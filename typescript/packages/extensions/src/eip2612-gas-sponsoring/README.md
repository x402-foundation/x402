# EIP-2612 gas sponsoring extension

Part of [`@x402/extensions`](../README.md). **Import from the package root:** `import { ... } from "@x402/extensions"` (this module is not a separate npm export subpath).

For **Permit2** payments on tokens that implement [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612), the payer can sign a gasless off-chain `permit`. The facilitator then settles via the proxy’s **`settleWithPermit`**, which applies that approval and the Permit2 transfer in one on-chain transaction (payer pays no gas for the approval).

For tokens **without** EIP-2612, use [ERC-20 approval gas sponsoring](../erc20-approval-gas-sponsoring/README.md) instead.

## End-to-end flow

1. **Resource server** advertises `eip2612GasSponsoring` in `PaymentRequired.extensions` (and uses `assetTransferMethod: "permit2"` with a token that exposes EIP-2612 `name` / `version` in `accepts[].extra`).
2. **Client** builds the normal Permit2 payment payload. If allowance to canonical Permit2 is insufficient, **`ExactEvmScheme`** (and **`UptoEvmScheme`** for the upto scheme) automatically attach `paymentPayload.extensions.eip2612GasSponsoring` with the signed permit when the 402 response included the server extension and the signer exposes `readContract` (see [`scheme.ts`](../../../mechanisms/evm/src/exact/client/scheme.ts) and [`extensions.ts`](../../../mechanisms/evm/src/shared/extensions.ts)).
3. **Facilitator** verifies/settles with `@x402/evm`’s exact or upto facilitator: it detects populated EIP-2612 info and calls **`settleWithPermit`** on `x402ExactPermit2Proxy` / the upto proxy (see [`permit2.ts`](../../../mechanisms/evm/src/exact/facilitator/permit2.ts)).

## Resource server

Declare the extension on routes that use Permit2 and an EIP-2612–capable token. Realistic shape (parsed `price`, Permit2, optional Bazaar, etc.) matches the repo example:

- [examples/typescript/servers/advanced/eip2612-gas-sponsoring.ts](../../../../../examples/typescript/servers/advanced/eip2612-gas-sponsoring.ts)

Example route config (shape matches `@x402/express` / `@x402/next` resource maps: each route has `accepts` plus optional `extensions` at the route level):

```typescript
import { declareEip2612GasSponsoringExtension } from "@x402/extensions";

const payTo = "0xYourPayeeAddress" as `0x${string}`;

const resources = {
  "GET /premium-data": {
    accepts: {
      scheme: "exact",
      network: "eip155:84532",
      payTo,
      // Parsed price + Permit2 forces the Permit2 client path (not EIP-3009).
      price: {
        amount: "1000", // smallest units, e.g. 0.001 USDC with 6 decimals
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // USDC on Base Sepolia
        extra: {
          assetTransferMethod: "permit2",
          // Required for automatic EIP-2612 permit signing — must match the token contract.
          name: "USD Coin",
          version: "2",
        },
      },
    },
    extensions: {
      ...declareEip2612GasSponsoringExtension(),
    },
  },
};
```

`name` and `version` must match the ERC‑20’s EIP‑712 domain (same strings the token uses for `permit`). See [Exact EVM README — Gas sponsoring](../../../mechanisms/evm/src/exact/README.md#gas-sponsoring-extensions-permit2-only).

## Client

**You do not manually add this extension** when using the stock **`ExactEvmScheme`** / **`UptoEvmScheme`** from `@x402/evm`. The client scheme merges `PaymentRequired.extensions` into context, checks for `eip2612GasSponsoring`, reads Permit2 allowance, and only then signs and attaches `extensions.eip2612GasSponsoring.info` with the permit fields (`from`, `asset`, `spender`, `amount`, `nonce`, `deadline`, `signature`, `version`).

Requirements for the automatic path:

- Server advertised `eip2612GasSponsoring` on the selected payment option.
- `assetTransferMethod` is `"permit2"`.
- Signer implements **`readContract`** (and typed-data signing as usual for Permit2).

Custom clients would need to populate the same `extensions.eip2612GasSponsoring` shape if not using `@x402/evm`.

## Facilitator

### Typical stack (`@x402/core` + `@x402/evm`)

You do **not** need to call `extractEip2612GasSponsoringInfo` yourself when using the built-in **`ExactEvmScheme`** / **`UptoEvmScheme`** facilitators: they already branch on the EIP-2612 extension during verify/simulate and call **`settleWithPermit`** when the payload includes valid permit data.

Do register the extension on **`x402Facilitator`** so capability discovery (e.g. `/supported`) lists EIP-2612 gas sponsoring—mirroring the advanced example:

- [examples/typescript/facilitator/advanced/gas_extensions.ts](../../../../../examples/typescript/facilitator/advanced/gas_extensions.ts)

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { EIP2612_GAS_SPONSORING } from "@x402/extensions";

const facilitator = new x402Facilitator()
  .register("eip155:84532", new ExactEvmScheme(evmSigner))
  .registerExtension(EIP2612_GAS_SPONSORING);
```

Settlement gas is paid by the facilitator’s EVM key used for `ExactEvmScheme` / `UptoEvmScheme`.

### Custom facilitator code

If you implement verify/settle outside `@x402/evm`, use the helpers in this package to read and sanity-check the client-supplied struct before you call your own `settleWithPermit` path:

```typescript
import {
  extractEip2612GasSponsoringInfo,
  validateEip2612GasSponsoringInfo,
} from "@x402/extensions";

const info = extractEip2612GasSponsoringInfo(paymentPayload);
if (info && !validateEip2612GasSponsoringInfo(info)) {
  // reject: malformed addresses / numeric fields / signature hex
}
```

## Related exports

See [`index.ts`](./index.ts) for `EIP2612_GAS_SPONSORING`, types, and facilitator helpers.

More context: [Exact EVM README — Gas sponsoring](../../../mechanisms/evm/src/exact/README.md#gas-sponsoring-extensions-permit2-only).
