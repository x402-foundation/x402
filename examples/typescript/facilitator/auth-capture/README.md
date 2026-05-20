# auth-capture Facilitator Example

Standard x402 facilitator that exposes `POST /verify`, `POST /settle`, and `GET /supported`, with the [auth-capture](../../../specs/schemes/auth-capture/scheme_auth-capture_evm.md) scheme registered for Base Sepolia (`eip155:84532`).

The facilitator submits `AuthCaptureEscrow.authorize(...)` on settle (two-phase). When `captureAuthorizer` is a smart contract, the SDK routes the call through that contract (which forwards to the escrow). Capture, void, and refund operations are the **captureAuthorizer's** responsibility and are not handled by this facilitator.

## Prerequisites

- Node.js v20+, pnpm v10
- A funded EVM key with enough ETH for tx submissions on Base Sepolia

## Setup

```bash
cp .env-local .env
# Fill EVM_PRIVATE_KEY

cd ../../..
pnpm install && pnpm build
cd examples/facilitator/auth-capture

pnpm start
```

## Environment

| Variable          | Required | Default                    | Notes                                                      |
| :---------------- | :------- | :------------------------- | :--------------------------------------------------------- |
| `EVM_PRIVATE_KEY` | Yes      | —                          | Submits `authorize` / `charge` transactions to the escrow. |
| `EVM_RPC_URL`     | No       | `https://sepolia.base.org` | Base Sepolia RPC endpoint.                                 |
| `PORT`            | No       | `4022`                     | Local listen port.                                         |

## Endpoints

```
POST /verify     # off-chain verification (signature + payload + simulate)
POST /settle     # submits AuthCaptureEscrow.authorize(...) on success
GET  /supported  # advertises the auth-capture scheme on eip155:84532
```
