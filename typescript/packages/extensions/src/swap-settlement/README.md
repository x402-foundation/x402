# Swap settlement extension

Part of [`@x402/extensions`](../README.md). **Import from the package root:** `import { ... } from "@x402/extensions"` (this module is not a separate npm export subpath).

Enables **token-agnostic payments**: a payer can satisfy a `PaymentRequirements` entry denominated in one asset (e.g. USDC) while holding a **different asset on the same network** (e.g. WETH, cbBTC). The facilitator atomically swaps the payer's input asset and delivers the exact required asset and amount to `payTo` in a single settlement transaction. The resource server is unaffected and always receives exactly the required asset.

Spec: [`specs/extensions/swap_settlement.md`](../../../../../specs/extensions/swap_settlement.md).

## End-to-end flow

1. **Resource server** advertises `swap-settlement` in `PaymentRequired.extensions` via `declareSwapSettlementExtension` (discovery data only — quotes are short-lived and fetched live).
2. **Client** requests a quote from the advertised `quoteUrl` (`buildQuoteRequest`), **recomputes `requirementsHash` locally** (`assertRequirementsHashMatches` — MUST pass before signing), builds the witness (`buildSwapWitness`), signs the typed data for the chosen method (`buildPermit2WitnessTypedData`, `buildEip3009TypedData`, or `buildIntentTypedData`), and merges `buildSwapSettlementExtension(info)` into `paymentPayload.extensions`.
3. **Facilitator** reads the payload with `extractSwapSettlementInfo` / `validateSwapSettlementInfo`, verifies the authorization against the quote, and settles atomically through the settler contract.

## Authorization methods

| Method | Mechanism | Quote binding |
| --- | --- | --- |
| `permit2` | Permit2 `PermitWitnessTransferFrom` with the normative `SwapWitness` | Witness (strongest) |
| `eip3009` | `ReceiveWithAuthorization`, `to = settler` | `nonce = keccak256(abi.encode(quoteIdHash, requirementsHash))` |
| `eip2612` | `permit` as gasless approval bootstrap; Permit2 witness alongside when `spender` is Permit2. Sign the permit itself with `@x402/evm`'s existing EIP-2612 helpers (`signEip2612Permit`) | Witness via the accompanying `permit2Authorization` (Permit2-bootstrap form), otherwise off-chain |
| `allowance` | Pre-existing ERC-20 allowance + signed EIP-712 `SwapSettlementIntent` | Intent struct |

## Resource server

```typescript
import { declareSwapSettlementExtension } from "@x402/extensions";

const routes = [
  {
    path: "/api/data",
    price: "$0.01",
    extensions: {
      ...declareSwapSettlementExtension({
        quoteUrl: "https://facilitator.example.com/x402/swap/quote",
        networks: ["eip155:8453", "eip155:42161"],
        authorizationMethods: ["eip3009", "permit2", "eip2612", "allowance"],
      }),
    },
  },
];
```

## Automatic client integration

Wrap a registered scheme client with `withSwapSettlement` and swap payments happen automatically whenever the server advertises the extension. The wrapper uses only the `permit2` method (a one-time Permit2 approval of the input asset is required); the other methods are available via the manual builders below.

```typescript
const client = new x402Client();
client.register(
  "eip155:*",
  withSwapSettlement(new ExactEvmScheme(signer), signer, { inputAsset: WETH }),
);
const fetchWithPayment = wrapFetchWithPayment(fetch, new x402HTTPClient(client));
// paying a USDC endpoint from a WETH balance now happens automatically
```

## Client

```typescript
import {
  buildQuoteRequest,
  assertRequirementsHashMatches,
  buildSwapWitness,
  buildPermit2WitnessTypedData,
  buildSwapSettlementExtension,
} from "@x402/extensions";

const quote = await postJson(quoteUrl, buildQuoteRequest(requirements, payer, inputAsset));
assertRequirementsHashMatches(requirements, quote); // throws on mismatch — do not sign

const witness = buildSwapWitness(quote, requirements);
const typedData = buildPermit2WitnessTypedData({
  chainId: 8453,
  settler: quote.settler,
  inputAsset: quote.inputAsset,
  maxAmountIn: quote.maxAmountIn,
  nonce,
  deadline,
  witness,
});
const signature = await account.signTypedData(typedData);

const paymentPayload = {
  ...basePayload,
  extensions: {
    ...basePayload.extensions,
    ...buildSwapSettlementExtension({
      version: "1",
      quoteId: quote.quoteId,
      inputAsset: quote.inputAsset,
      method: "permit2",
      permit2Authorization: { /* wire fields + signature */ },
    }),
  },
};
```

## Facilitator

```typescript
import { extractSwapSettlementInfo, validateSwapSettlementInfo } from "@x402/extensions";

const info = extractSwapSettlementInfo(paymentPayload);
if (info && !validateSwapSettlementInfo(info)) {
  // reject: authorization_invalid (malformed shape / method-authorization mismatch)
}
```

Shared canonical helpers (`jcsSerialize`, `computeRequirementsHash`, `computeQuoteIdHash`, `deriveEip3009Nonce`) are exported for both sides; clients and facilitators MUST derive identical bytes. `jcsSerialize` implements a deliberate RFC 8785 subset (strings/objects/arrays/booleans/null/safe integers) and throws on other numbers to fail closed rather than risk hash divergence.

## Related exports

See [`index.ts`](./index.ts) for `SWAP_SETTLEMENT_KEY`, `SWAP_SETTLEMENT`, `SWAP_WITNESS_TYPE_STRING`, types, canonical helpers, typed-data builders, and facilitator helpers.
