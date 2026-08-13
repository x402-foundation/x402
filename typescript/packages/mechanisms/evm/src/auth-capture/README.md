# auth-capture EVM Scheme (client)

The **auth-capture** scheme adds refundable payments to x402, built on Base's audited [Commerce Payments Protocol](https://github.com/base/commerce-payments). The client signs a single payload (ERC-3009 or Permit2) over a payer-agnostic PaymentInfo hash. A facilitator later submits that payload to `AuthCaptureEscrow`, where funds are held under a `captureAuthorizer` role rather than transferred straight to the merchant, enabling capture, void, and refund flows before settlement is final.

This package currently ships the **client only**: detecting auth-capture payment requirements and signing the payment payload. Server and facilitator support follow in a later change.

See the [scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth-capture_evm.md) for full protocol details.

## Import

| Role   | Import                          |
| ------ | ------------------------------- |
| Client | `@x402/evm/auth-capture/client` |

## Usage

Register `AuthCaptureEvmScheme` with an `x402Client`. The client validates the requirement's `extra` fields, reconstructs the PaymentInfo struct, computes the payer-agnostic hash, and emits an ERC-3009 (default) or Permit2 payload.

```typescript
import { x402Client } from "@x402/core/client";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

const client = new x402Client();
client.register("eip155:*", new AuthCaptureEvmScheme(account));
```

`ClientEvmSigner` only needs `address` + `signTypedData`; a bare viem `LocalAccount` satisfies the shape, with no `PublicClient` required.

## Payment requirements the client reads

The client reads these fields from `requirements.extra` and throws if any required field is missing or wrongly typed:

| Field | Type | Notes |
| --- | --- | --- |
| `captureAuthorizer` | `address` | Committed on-chain as `PaymentInfo.operator`. |
| `feeRecipient` | `address` | Address that receives the fee portion. |
| `captureDeadline` | `uint48` | Absolute Unix seconds; capture must occur before this. |
| `refundDeadline` | `uint48` | Absolute Unix seconds; refunds allowed until this. |
| `minFeeBps` | `uint16` | Floor on the `captureAuthorizer`'s fee. `0` = no minimum. |
| `maxFeeBps` | `uint16` | Cap on the `captureAuthorizer`'s fee. |
| `name` | `string` | EIP-712 token-domain name (e.g. `"USDC"`). |
| `version` | `string` | EIP-712 token-domain version (e.g. `"2"`). |

`maxTimeoutSeconds` on the requirements (not `extra`) is used to derive the authorization's `preApprovalExpiry`.

Optional:

| Field | Default | Notes |
| --- | --- | --- |
| `assetTransferMethod` | `"eip3009"` | `"eip3009"` (ERC-3009) or `"permit2"` (Uniswap Permit2). See below. |

## Asset transfer methods

The `assetTransferMethod` field selects how the signed authorization is shaped:

| Method | Description | Wire shape |
| --- | --- | --- |
| `"eip3009"` (default) | ERC-3009 `ReceiveWithAuthorization` to the canonical EIP-3009 token collector. EIP-712 domain is bound to the **token contract**. | `Eip3009Payload` |
| `"permit2"` | Uniswap Permit2 `PermitTransferFrom` to the canonical Permit2 token collector. Useful for tokens without `receiveWithAuthorization` (e.g. BSC USDC). | `Permit2Payload` |

A server may advertise multiple `accepts[]` entries with different `assetTransferMethod` values so the client picks whichever matches its token approvals.

## Supported networks

| Network      | CAIP-2 ID      |
| ------------ | -------------- |
| Base Mainnet | `eip155:8453`  |
| Base Sepolia | `eip155:84532` |

Canonical `AuthCaptureEscrow` and EIP-3009 / Permit2 token collector addresses live in [`./constants.ts`](./constants.ts).

## Examples

- [Client example](../../../../../examples/clients/auth-capture)

## See also

- [Scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth-capture_evm.md)
- [`AuthCaptureEscrow` contract](https://github.com/base/commerce-payments)
