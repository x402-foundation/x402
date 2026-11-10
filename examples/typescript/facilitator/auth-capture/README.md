# Auth-Capture Facilitator Example

Express.js facilitator for the **auth-capture** EVM scheme (v1.1) on Base Sepolia. It exposes standard x402 facilitator endpoints and submits collect (`authorize` / `charge`) and lifecycle (`capture` / `void` / `refund`) calls to `AuthCaptureEscrow` or an allowlisted custom operator.

See the [v1.1 proposed specification](../../../../specs/proposed/scheme_auth_capture_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/auth-capture/README.md).

## Two Signer Roles

| Env var | Role | Onchain effect |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | **Relayer** — submits transactions | Pays gas; for `"delegated"` routes this address is `extra.captureAuthorizer` |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | **Receiver authorizer** (optional) | When set, advertised in `/supported` as `extra.receiverAuthorizer`. Resource servers that omit their own authorizer key send unsigned payloads; this facilitator signs after `resolveCallerIdentity` authenticates the caller |

Without `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`, `/supported` advertises only `extra.captureAuthorizer`. Resource servers must configure `receiverAuthorizerSigner` locally.

## Receiver authorizer delegation (optional)

To let resource servers delegate capture/void/refund signing to this facilitator, set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` (recommended: a key separate from the relayer). `GET /supported` then includes `extra.receiverAuthorizer`:

```json
{
  "kinds": [
    {
      "scheme": "auth-capture",
      "network": "eip155:84532",
      "extra": {
        "captureAuthorizer": "...",
        "receiverAuthorizer": "..."
      }
    }
  ]
}
```

This example wires the facilitator SDK opt-in (all four fields required):

- `authorizerSigner` from `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`
- `resolveCallerIdentity` — implemented on `AuthCaptureEvmScheme` config; invoked by the SDK during delegated settles with a `DelegatedSettleContext` (`step`, `paymentInfoHash`, `payload`, `requirements`, optional `facilitatorContext`)
- `delegatedAuthStorage` — this example uses `InMemoryAuthCaptureDelegatedAuthStorage` for local testing only
- `onStorageError` — reports binding revert/delete failures

`POST /settle` is a thin wrapper around `facilitator.settle()`; it does not implement custom identity plumbing. Caller authentication belongs in `resolveCallerIdentity` (see the [scheme README](../../../../typescript/packages/mechanisms/evm/src/auth-capture/README.md#receiver-authorizer-modes)).

```typescript
import type { DelegatedSettleContext } from "@x402/evm/auth-capture/facilitator";

new AuthCaptureEvmScheme(evmSigner, {
  authorizerSigner,
  delegatedAuthStorage,
  onStorageError: (error, network, paymentInfoHash) => {
    /* ... */
  },
  resolveCallerIdentity: async (ctx: DelegatedSettleContext) => {
    // Authenticate the resource server (API key, mTLS, JWT, etc.) using ctx and/or
    // ctx.facilitatorContext?.getExtension(...). Return a stable merchant id, or
    // undefined to reject. Local testing only:
    return "example-local-caller";
  },
});
```

The first authenticated caller to settle a payment is bound to its `paymentInfoHash`; later lifecycle settles must resolve to the same identity. For production, replace the in-memory store with a durable, atomic implementation (Redis, SQL, etc.) when more than one facilitator process serves the same payments.

> ⚠️ **Local testing only:** this example returns a fixed identity from `resolveCallerIdentity`. Do not advertise `receiverAuthorizer` without real authentication.

Pair with the [auth-capture server example](../../servers/auth-capture/): run this facilitator with `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` set and omit `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the resource server for facilitator-delegated sync/deferred flows.

## Custom-operator allowlist

`CUSTOM_OPERATOR_ALLOWLIST` is a comma-separated list of operator addresses the facilitator will relay collect for, advertised in `/supported` as `extra.operators` when `simulateCalls` is wired on the signer. Leave it empty to admit no custom operator; set it to the operator address the [custom-escrow server example](../../servers/auth-capture/) deploys so that flow can relay collect-only `authorize` through it.

Custom collect verification uses `eth_simulateV1` with a gas cap (`customOperatorAuthorizeGasLimit`, default `1_000_000`) and outcome checks before broadcast.

## Prerequisites

- Node.js v20+, pnpm v10
- Base Sepolia ETH on the **relayer** address (gas)
- USDC on Base Sepolia for client payments

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY (and optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY,
# CUSTOM_OPERATOR_ALLOWLIST, EVM_RPC_URL, PORT)

cd ../../
pnpm install && pnpm build
cd facilitator/auth-capture

pnpm dev
```

The facilitator listens on `http://localhost:4022` by default. Delegated server flows pick up the relayer address from `GET /supported` extra.captureAuthorizer.

## API Surface

Standard x402 facilitator endpoints: `POST /verify`, `POST /settle`, `GET /supported`.

| Collect settle (no `payload.type`) | `extra.paymentFlow`  | Contract call    |
| ---------------------------------- | -------------------- | ---------------- |
| Escrow hold                        | `"escrow"` (default) | `authorize(...)` |
| Terminal charge                    | `"authorization"`    | `charge(...)`    |

| Lifecycle settle (`payload.type`) | Contract call |
| --- | --- |
| `"capture"` | `capture(...)` (+ optional void when `voidAuthorizerSignature` present) |
| `"void"` | `void(...)` |
| `"refund"` | `refund(...)` |

Settle target is the canonical escrow for `"delegated"` and `extra.captureAuthorizer` for `"custom"`.
