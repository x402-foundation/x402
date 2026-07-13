# x402 swap-settlement Facilitator Example

A minimal facilitator implementing the `swap-settlement` extension
(`specs/extensions/swap_settlement.md`) on top of a standard exact-scheme facilitator:

1. **Quote API** — `POST /x402/swap/quote` issues short-lived, single-use quotes sized in
   exact-output mode (`maxAmountIn` = route spend + slippage buffer + facilitator fee)
2. **Verification** — payloads carrying `extensions["swap-settlement"]` are validated
   against the quote: requirements hash, Permit2 witness field equality, signature
   recovery, payer balance
3. **Settlement** — one atomic transaction through the `x402SwapSettler` reference
   contract (`contracts/evm/src/x402SwapSettler.sol`): acquire → swap via the whitelisted
   target → minimum-output check → exact delivery → surplus refund

Intentionally minimal: only the `permit2` method, a fixed swap target and a stub route
provider, in-memory quotes. A production facilitator adds the other three authorization
methods, a real routing provider (aggregator API) for calldata and pricing, settlement
re-simulation, and idempotency across concurrent settles.

## Setup

```bash
pnpm install
pnpm dev
```

| Variable                           | Description                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `EVM_PRIVATE_KEY`                  | Facilitator sender — must be authorized on the settler (`setFacilitator`) |
| `SWAP_SETTLER_ADDRESS`             | Deployed `x402SwapSettler`                                                |
| `SWAP_TARGET_ADDRESS`              | Whitelisted swap target (`setSwapTarget`) the route calldata calls        |
| `RPC_URL`                          | Optional RPC override (defaults to the chain's public RPC)                |
| `FIXED_RATE_OUTPUT_PER_INPUT_UNIT` | Stub route rate: output amount per 1 input unit                           |

## Local demo on an anvil fork

The stub route provider emits `swap(input, output)` calldata matching the repo's
`MockSwapRouter` (`contracts/evm/test/mocks/MockSwapRouter.sol`), so the whole flow runs
on a fork without an aggregator:

```bash
anvil --fork-url <base-rpc> --optimism
# deploy the settler (script/DeploySwapSettler.s.sol), deploy + fund MockSwapRouter,
# setFacilitator + setSwapTarget, then point this example at them
```

Pair it with `examples/typescript/clients/swap-settlement` and any server example whose
route declares the extension via `declareSwapSettlementExtension`.
