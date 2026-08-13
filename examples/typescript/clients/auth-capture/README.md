# auth-capture Client Example

Fetch-based client that pays for a single request to an [auth-capture](../../../specs/schemes/auth-capture/scheme_auth-capture_evm.md)-protected endpoint. Signs an ERC-3009 `ReceiveWithAuthorization` whose `nonce` is the payer-agnostic PaymentInfo hash (per the [scheme spec](../../../specs/schemes/auth-capture/scheme_auth-capture_evm.md#nonce-derivation-both-methods)).

## Prerequisites

- Node.js v20+, pnpm v10
- A running auth-capture server to pay against (the server/facilitator SDK lands separately; point `RESOURCE_SERVER_URL` at any auth-capture endpoint)
- A funded EVM key holding the requested asset (USDC on Base Sepolia by default)

## Setup

```bash
cp .env-local .env
# Fill EVM_PRIVATE_KEY (and override RESOURCE_SERVER_URL if needed)

cd ../../..
pnpm install && pnpm build
cd examples/clients/auth-capture

pnpm start
```

## Environment

| Variable              | Required | Default                 |
| :-------------------- | :------- | :---------------------- |
| `EVM_PRIVATE_KEY`     | Yes      | (none)                  |
| `RESOURCE_SERVER_URL` | No       | `http://localhost:4021` |
| `ENDPOINT_PATH`       | No       | `/weather`              |

## What happens

1. Client builds and signs an ERC-3009 payload with the `Eip3009Payload` shape.
2. `wrapFetchWithPayment` retries the request with the `PAYMENT-SIGNATURE` header on first `402`.
3. Server verifies, then asks the facilitator to settle.
4. Facilitator submits `AuthCaptureEscrow.authorize(...)` (two-phase); funds are locked in escrow under the captureAuthorizer's control.
5. Server returns the resource; the example prints the body and the payment response.

Capture, void, and refund are performed by whoever holds the `captureAuthorizer` role and are out of scope for the client.
