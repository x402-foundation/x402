# ERC-20 approval gas sponsoring extension

Part of [`@x402/extensions`](../README.md). **Import from the package root:** `import { ... } from "@x402/extensions"` (this module is not a separate npm export subpath).

For **Permit2** payments on tokens that **do not** implement [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612), the payer can sign a raw **`approve(Permit2, …)`** transaction off-chain. The facilitator broadcasts that approval, then settles the Permit2 payment (payer pays no gas for the approval).

If the token supports EIP-2612, prefer [EIP-2612 gas sponsoring](../eip2612-gas-sponsoring/README.md); the client tries that path first when both extensions are advertised.

## End-to-end flow

1. **Resource server** advertises `erc20ApprovalGasSponsoring` in `PaymentRequired.extensions` (with `assetTransferMethod: "permit2"`). Omitting EIP-2612 `name` / `version` from token `extra` steers clients away from the EIP-2612 path when both extensions exist (see [Extension priority](../../../mechanisms/evm/src/exact/README.md#extension-priority)).
2. **Client** builds the normal Permit2 payload. If EIP-2612 is not used and allowance is insufficient, **`ExactEvmScheme`** / **`UptoEvmScheme`** attach `paymentPayload.extensions.erc20ApprovalGasSponsoring` with a **serialized signed approve tx** when the server advertised the extension and the signer supports **`readContract`**, **`signTransaction`**, and **`getTransactionCount`** (see [`extensions.ts`](../../../mechanisms/evm/src/shared/extensions.ts)).
3. **Facilitator** uses `@x402/evm` facilitators plus **`createErc20ApprovalGasSponsoringExtension(signer)`**: the extension supplies a signer with **`sendTransactions`** to broadcast the client’s raw tx before **`settle()`**.

## Resource server

```typescript
import { declareErc20ApprovalGasSponsoringExtension } from "@x402/extensions";

// Permit2 route — typically structured price + extra.assetTransferMethod
extensions: {
  ...declareErc20ApprovalGasSponsoringExtension(),
},
```

See [Exact EVM README — ERC-20 approval gas sponsoring](../../../mechanisms/evm/src/exact/README.md#erc-20-approval-gas-sponsoring).

## Client

**You do not manually add this extension** when using **`ExactEvmScheme`** / **`UptoEvmScheme`**: the scheme appends `extensions.erc20ApprovalGasSponsoring.info` (including `signedTransaction`) when the server advertised the extension, EIP-2612 signing was skipped or unavailable, allowance is low, and the signer exposes the transaction-signing hooks listed above.

Custom clients must reproduce the same payload shape if not using `@x402/evm`.

## Facilitator

### Typical stack (`@x402/core` + `@x402/evm`)

The exact/upto **Permit2 facilitator** already reads `erc20ApprovalGasSponsoring` from the payment payload and broadcasts the approval when registered with a capable extension—see [`permit2.ts`](../../../mechanisms/evm/src/exact/facilitator/permit2.ts).

Register **`createErc20ApprovalGasSponsoringExtension`** with a facilitator EVM signer extended to **`sendTransactions`** (raw and/or unsigned calldata), as in:

- [examples/typescript/facilitator/advanced/gas_extensions.ts](../../../../../examples/typescript/facilitator/advanced/gas_extensions.ts)

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { createErc20ApprovalGasSponsoringExtension } from "@x402/extensions";

const erc20ApprovalSigner = {
  ...evmSigner,
  sendTransactions: async (transactions) => {
    /* broadcast each tx, wait for receipt, return hashes */
  },
};

const facilitator = new x402Facilitator()
  .register("eip155:84532", new ExactEvmScheme(evmSigner))
  .registerExtension(createErc20ApprovalGasSponsoringExtension(erc20ApprovalSigner));
```

Gas for the approval broadcast and for settlement is paid from the facilitator’s funded EVM account.

### Custom facilitator code

If you implement settlement yourself, use **`extractErc20ApprovalGasSponsoringInfo`** and **`validateErc20ApprovalGasSponsoringInfo`** from `@x402/extensions` to parse and validate the client payload before you broadcast `signedTransaction` and invoke your Permit2 settle path.

## Related exports

See [`index.ts`](./index.ts) for `ERC20_APPROVAL_GAS_SPONSORING`, `createErc20ApprovalGasSponsoringExtension`, and types.

More context: [Exact EVM README — Gas sponsoring](../../../mechanisms/evm/src/exact/README.md#gas-sponsoring-extensions-permit2-only).
