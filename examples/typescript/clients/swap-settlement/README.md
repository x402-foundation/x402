# x402 swap-settlement Client Example

Pays a USDC-denominated x402 endpoint while holding a different same-chain asset
(default: WETH on Base). The facilitator swaps the input asset and delivers exact USDC to
the merchant in one atomic transaction — the resource server never knows a swap happened.

The integration is one line: wrap the regular exact scheme with `withSwapSettlement` and
pass the input asset. Quoting, requirements-hash validation and the witness-bound Permit2
signature all happen inside `@x402/extensions`; when the server does not offer swap
settlement, payments fall through to the wrapped scheme unchanged.

```typescript
client.register(
  "eip155:*",
  withSwapSettlement(new ExactEvmScheme(signer), signer, { inputAsset: WETH }),
);
```

See `specs/extensions/swap_settlement.md` for the full protocol.

## Prerequisites

- A resource server whose 402 response declares the `swap-settlement` extension
  (see `examples/typescript/facilitator/swap-settlement` and the server examples)
- A payer wallet holding the input asset with a one-time approval to the canonical
  Permit2 contract (`0x000000000022D473030F116dDEE9F6B43aC78BA3`)

## Setup

```bash
pnpm install
pnpm dev
```

| Variable | Description |
| --- | --- |
| `PRIVATE_KEY` | Payer key (holds the input asset, approved Permit2) |
| `RESOURCE_SERVER_URL` | Default `http://localhost:4021` |
| `ENDPOINT_PATH` | Default `/weather` |
| `INPUT_ASSET` | Default WETH on Base (`0x4200...0006`) |
