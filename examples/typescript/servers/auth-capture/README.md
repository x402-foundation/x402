# Auth-Capture Server Example

Express server that protects a resource with the **auth-capture** EVM scheme (v1.1). Three entry scripts demonstrate the main operator and capture-mode combinations.

See the [v1.1 proposed specification](../../../../specs/proposed/scheme_auth_capture_evm.md) and the [scheme README](../../../../typescript/packages/mechanisms/evm/src/auth-capture/README.md).

## Flows

Pick **one** script at a time (all listen on port `4021`):

| Script | `operatorType` | `captureMode` | Behavior |
| --- | --- | --- | --- |
| `pnpm delegated-sync` | `"delegated"` | `"sync"` | Authorize before the handler, signed capture after (supports partial billing via `setSettlementOverrides`) |
| `pnpm delegated-deferred` | `"delegated"` | `"deferred"` | Authorize during the request; skip after-handler settle; capture later via admin routes or `pnpm capture-pending` |
| `pnpm custom-escrow` | `"custom"` | `"deferred"` | Collect-only `authorize` through a custom operator contract; lifecycle is out of band |

### Delegated sync

The facilitator relays `authorize`, the resource handler runs, then the server signs and relays `capture` (or `void` on handler failure). Requires:

- `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` = local authorizer that signs capture/void

`extra.captureAuthorizer` for delegated flows is copied from the facilitator's `/supported` extra.captureAuthorizer (the advertised relayer).

The `/weather` route bills a random fraction of the authorized `$0.01` ceiling to demonstrate usage-based capture.

### Delegated deferred (async capture)

Funds are held in escrow during the request, but the after-handler facilitator settle is skipped. Capture runs **asynchronously** through:

- `GET /admin/payments` — list in-memory authorized payments
- `POST /admin/capture` — `{ "paymentInfoHash": "0x...", "voidRemainder": true }`
- `POST /admin/void` — release the hold without capturing
- `pnpm capture-pending` — CLI that captures (and voids remainder) on the latest payment

**In-memory storage:** the default `InMemoryAuthorizedPaymentStorage` only survives within one Node process. Deferred captures must be triggered before restarting the server; otherwise the payer can `reclaim` after the capture deadline. Production deployments need durable, atomically updatable storage (Redis, SQL, etc.).

### Custom escrow (collect-only)

`extra.captureAuthorizer` is a deployed custom operator. The facilitator relays only the collect `authorize`; capture/void/refund happen on the operator contract outside x402.

Set `CUSTOM_OPERATOR_ADDRESS` to that operator. The example facilitator allowlists all custom operators for local testing.

## Prerequisites

- Node.js v20+, pnpm v10
- A running [auth-capture facilitator](../../facilitator/auth-capture)
- An EVM `payTo` address (`EVM_ADDRESS`)
- For delegated flows: receiver authorizer key (capture authorizer comes from facilitator `/supported` extra.captureAuthorizer)
- For custom escrow: deployed custom operator on Base Sepolia

## Setup

```bash
cp .env-local .env
# fill EVM_ADDRESS, FACILITATOR_URL, and flow-specific vars (see .env-local)

cd ../../
pnpm install && pnpm build
cd servers/auth-capture

# Terminal 1 — pick a flow
pnpm delegated-sync
# or: pnpm delegated-deferred
# or: pnpm custom-escrow

# Terminal 2 — pay the endpoint (TypeScript)
cd ../../clients/fetch && pnpm start
# or: cd ../../clients/axios && pnpm start
# or (Go): cd ../../../go/clients/http && go run .

# Terminal 3 (deferred only) — capture after the client pays
cd ../../servers/auth-capture && pnpm capture-pending
```

## Environment

| Variable | Required | Description |
| --- | --- | --- |
| `EVM_ADDRESS` | yes | `payTo` receiver address |
| `FACILITATOR_URL` | yes | Auth-capture facilitator endpoint |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | delegated flows | Signs capture/void/refund lifecycle payloads |
| `CUSTOM_OPERATOR_ADDRESS` | custom-escrow | Allowlisted custom operator contract |
