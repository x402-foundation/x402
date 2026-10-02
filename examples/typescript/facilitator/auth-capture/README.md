# Auth-Capture Facilitator Example

Express.js facilitator for the **auth-capture** EVM scheme (v1.1) on Base Sepolia. It exposes standard x402 facilitator endpoints and submits collect (`authorize` / `charge`) and lifecycle (`capture` / `void` / `refund`) calls to `AuthCaptureEscrow` or an allowlisted custom operator.

See the [v1.1 proposed specification](../../../../specs/proposed/scheme_auth_capture_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/auth-capture/README.md).

## Two Signer Roles

| Env var | Role | Onchain effect |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | **Relayer** — submits transactions | Pays gas; for `"delegated"` routes this address is `extra.captureAuthorizer` |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | **Receiver authorizer** (optional) | When set, advertised in `/supported` as `extra.receiverAuthorizer` for servers that delegate lifecycle signatures |

For local delegated **sync** flows, the server still needs its own authorizer key to sign capture/void during the request. The facilitator key is only advertised so merchants can omit `extra.receiverAuthorizer` when they prefer facilitator-delegated signing — this example keeps keys separate to mirror production separation of duties.

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
