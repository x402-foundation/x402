# auth-capture Server Example

Express resource server protected by the [auth-capture](../../../specs/schemes/auth-capture/scheme_auth-capture_evm.md) scheme. The server publishes payment requirements with all spec-mandated `extra` fields and delegates verify/settle to a configured facilitator.

`autoCapture` is omitted (defaults to `false`), so the facilitator calls `AuthCaptureEscrow.authorize(...)`, the canonical two-phase flow. Funds are locked in the escrow under the captureAuthorizer's control. Capture, void, and refund happen separately, decided by whichever entity holds the captureAuthorizer role.

## Prerequisites

- Node.js v20+, pnpm v10
- A running [auth-capture facilitator](../../facilitator/auth-capture)
- An EVM address to receive payments (`EVM_ADDRESS`)
- The address that holds capture authority (`CAPTURE_AUTHORIZER`). Per [spec](../../../specs/schemes/auth-capture/scheme_auth-capture_evm.md), in a facilitator-submits flow this must be **either the facilitator's EOA** (so the facilitator's transaction passes the escrow's `onlySender(paymentInfo.operator)` gate) **or a smart contract** that forwards calls to the escrow (the contract then becomes `msg.sender` at escrow). The SDK auto-detects which via `getCode`. If neither condition holds (e.g., an unrelated EOA), the escrow's `onlySender` gate reverts with `InvalidSender` during the facilitator's verify-step simulation, which the SDK maps to `invalid_capture_authorizer` on the `VerifyResponse`.

## Setup

```bash
cp .env-local .env
# Fill EVM_ADDRESS, CAPTURE_AUTHORIZER, FACILITATOR_URL

cd ../../..
pnpm install && pnpm build
cd examples/servers/auth-capture

pnpm start
```

## Environment

| Variable             | Required | Default | Notes                                                                                                                                                              |
| :------------------- | :------- | :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EVM_ADDRESS`        | Yes      | (none)  | Pay-to address (the merchant's receiver).                                                                                                                          |
| `CAPTURE_AUTHORIZER` | Yes      | (none)  | Committed on-chain as `PaymentInfo.operator`. EOA path: must equal the facilitator's submitter EOA. Contract path: any contract that forwards calls to the escrow. |
| `FACILITATOR_URL`    | Yes      | (none)  | Base URL of the auth-capture facilitator (POST `/verify`, POST `/settle`).                                                                                          |
| `PORT`               | No       | `4021`  | Local listen port.                                                                                                                                                 |

## Deadlines

The example sets `captureDeadline` and `refundDeadline` once at boot, as absolute Unix seconds 30 / 60 days into the future. Every authorization the server hands out shares the same absolute deadline. Production servers commonly compute these per request via custom middleware so each authorization has a fresh window, out of scope for this minimal demo.

## Lifecycle beyond authorize

This example demonstrates the authorize phase only. Capture, void, and refund are the captureAuthorizer's responsibility and are not handled by this server; refer to the [scheme spec](../../../specs/schemes/auth-capture/scheme_auth-capture_evm.md) for the protocol-level surface.
