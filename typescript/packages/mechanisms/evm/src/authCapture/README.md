# AuthCapture EVM Scheme (`@x402r/evm/authCapture`)

The **authCapture** scheme adds refundable payments to x402, built on Base's audited [Commerce Payments Protocol](https://github.com/base/commerce-payments). The client signs a single payload (ERC-3009 or Permit2). The facilitator submits to `AuthCaptureEscrow`, where funds are escrowed under a `captureAuthorizer` role rather than transferred straight to the merchant — enabling capture, void, and refund flows before settlement is final.

Two settle paths:

- **Two-phase** (`autoCapture: false`, default) — funds are authorized into escrow; the captureAuthorizer captures (or voids) later.
- **Single-shot** (`autoCapture: true`) — `authorize` and `capture` collapse into one transaction, with a refund window until `refundDeadline`.

See the [scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/authCapture/scheme_authCapture_evm.md) for full protocol details.

## Import Paths

| Role        | Import                               |
| ----------- | ------------------------------------ |
| Client      | `@x402r/evm/authCapture/client`      |
| Server      | `@x402r/evm/authCapture/server`      |
| Facilitator | `@x402r/evm/authCapture/facilitator` |

## Client Usage

Register `AuthCaptureEvmScheme` with an `x402Client`. The client signs the payer-agnostic PaymentInfo hash and emits an ERC-3009 (default) or Permit2 payload.

```typescript
import { x402Client } from "@x402/core/client";
import { AuthCaptureEvmScheme } from "@x402r/evm/authCapture/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

const client = new x402Client();
client.register("eip155:*", new AuthCaptureEvmScheme(account));
```

`ClientEvmSigner` only needs `address` + `signTypedData`; a bare viem `LocalAccount` satisfies the shape, no `PublicClient` required.

## Server Usage

Register `AuthCaptureEvmScheme` with an `x402ResourceServer` and publish payment requirements with the spec-mandated `extra` fields:

```typescript
import { HTTPFacilitatorClient } from "@x402/core/server";
import { AuthCaptureEvmScheme } from "@x402r/evm/authCapture/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { zeroAddress } from "viem";

const facilitator = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL! });
const resourceServer = new x402ResourceServer(facilitator).register(
  "eip155:84532",
  new AuthCaptureEvmScheme(),
);

app.use(
  paymentMiddleware(
    {
      "GET /weather": {
        accepts: {
          scheme: "authCapture",
          price: "$0.01",
          network: "eip155:84532",
          payTo: receiverAddress,
          extra: {
            captureAuthorizer, // EOA = facilitator submitter, or contract that forwards to escrow
            captureDeadlineSeconds: 3600, // seconds-from-now; scheme converts to absolute per request
            refundDeadlineSeconds: 7200,
            feeRecipient: zeroAddress, // address(0) = captureAuthorizer picks at capture time
            minFeeBps: 0,
            maxFeeBps: 100,
          },
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);
```

### Required `extra` fields

| Field | Type | Notes |
| --- | --- | --- |
| `captureAuthorizer` | `address` | Committed on-chain as `PaymentInfo.operator`. See [captureAuthorizer](#captureauthorizer) below. |
| `feeRecipient` | `address` | `address(0)` lets the captureAuthorizer pick a non-zero recipient at capture/charge time. |
| `minFeeBps` | `uint16` | Floor on the captureAuthorizer's fee. `0` = no minimum. |
| `maxFeeBps` | `uint16` | Cap on the captureAuthorizer's fee. |

Either set the deadline windows as relative offsets (recommended) or as absolute Unix seconds:

| Field | Type | Notes |
| --- | --- | --- |
| `captureDeadlineSeconds` | `number` | Seconds-from-now. The scheme converts to `captureDeadline` (absolute) inside `enhancePaymentRequirements` per request, then strips this key from the published `extra`. |
| `refundDeadlineSeconds` | `number` | Seconds-from-now. Converted to `refundDeadline` the same way. |
| `captureDeadline` | `uint48` | Absolute Unix seconds. Use this when the deadline is tied to an external commitment (e.g., a delivery date). Wins over `captureDeadlineSeconds` if both are set. |
| `refundDeadline` | `uint48` | Absolute Unix seconds. Same precedence rule as `captureDeadline`. |

If neither is set for a window, `enhancePaymentRequirements` throws server-side with a message naming the missing field, so misconfiguration surfaces in the merchant's logs immediately rather than as an `invalid_authCapture_extra` 402 to the payer. Capture / refund windows are arbiter policy; pick what your captureAuthorizer actually supports.

The server-side fail-fast also covers the other directly-merchant-set fields (`captureAuthorizer`, `feeRecipient`, `minFeeBps`, `maxFeeBps`); a missing or wrongly-typed value throws at enhance time with a message naming the offending key.

### Auto-populated by the scheme

`AuthCaptureEvmScheme.parsePrice` resolves decimal prices like `"$0.01"` against `@x402/evm`'s default-asset table and writes `name` / `version` (EIP-712 token domain) and, where the chain's default uses Permit2, `assetTransferMethod: "permit2"` into the resulting `AssetAmount.extra` for you. The middleware merges these into the published `requirements.extra`, so merchants using decimal pricing do not need to set them by hand. Merchants supplying their own `AssetAmount` (custom token) must set `name` / `version` themselves on the `AssetAmount.extra`; the facilitator's `isAuthCaptureExtra` guard catches the case where they're missing on the wire side (no server-side fail-fast, matching how `batch-settlement` handles its scheme-auto-populated EIP-712 domain fields).

### Optional `extra` fields

| Field | Default | Notes |
| --- | --- | --- |
| `autoCapture` | `false` | `true` → `charge` (atomic). `false` → `authorize` (two-phase). See [Settle Paths](#settle-paths). |
| `assetTransferMethod` | `"eip3009"` | `"eip3009"` (ERC-3009) or `"permit2"` (Uniswap Permit2). See [Asset Transfer Methods](#asset-transfer-methods). |

## Facilitator Usage

Register the scheme with an `x402Facilitator` instance:

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { AuthCaptureEvmScheme } from "@x402r/evm/authCapture/facilitator";
import { createWalletClient, http, publicActions, nonceManager } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`, { nonceManager });
const viemClient = createWalletClient({
  account,
  chain: baseSepolia,
  transport: http(),
}).extend(publicActions);

const evmSigner = toFacilitatorEvmSigner({
  address: account.address,
  getCode: args => viemClient.getCode(args),
  readContract: args => viemClient.readContract(args),
  verifyTypedData: args => viemClient.verifyTypedData(args),
  writeContract: args => viemClient.writeContract(args),
  sendTransaction: args => viemClient.sendTransaction(args),
  waitForTransactionReceipt: args => viemClient.waitForTransactionReceipt(args),
});

const facilitator = new x402Facilitator();
facilitator.register("eip155:84532", new AuthCaptureEvmScheme(evmSigner));
```

`verify` performs envelope shape checks, scheme/network agreement, `extra` validation, deadline-ordering invariants, per-method field checks, signature verification (with EIP-6492 unwrap), nonce binding to the payer-agnostic PaymentInfo hash, and an on-chain `simulateContract` of `authorize` / `charge` so typed escrow reverts surface as stable `invalidReason` strings.

`settle` re-verifies then submits `authorize` (two-phase) or `charge` (single-shot) to the escrow contract, or — if the `captureAuthorizer` is a smart contract — routes the call through that contract (auto-detected, see below).

## Supported Networks

| Network      | CAIP-2 ID      |
| ------------ | -------------- |
| Base Mainnet | `eip155:8453`  |
| Base Sepolia | `eip155:84532` |

Requires the canonical `AuthCaptureEscrow` and EIP-3009 / Permit2 token collectors deployed at universal CREATE2 addresses on the target network. The constants live in [`./constants.ts`](./constants.ts).

## Settle Paths

| `autoCapture` | Contract call | Settlement semantics |
| --- | --- | --- |
| `false` (default) | `escrow.authorize(...)` | Two-phase. Funds locked under `captureAuthorizer`; capture / void / refund happens separately via the captureAuthorizer. |
| `true` | `escrow.charge(...)` | Single-shot. `authorize` + `capture` in one transaction. Refunds still possible until `refundDeadline`. |

## Asset Transfer Methods

The `assetTransferMethod` field on `extra` selects how the payer's funds reach escrow:

| Method | Description | Wire shape |
| --- | --- | --- |
| `"eip3009"` (default) | ERC-3009 `ReceiveWithAuthorization` to the canonical EIP-3009 token collector. EIP-712 domain is bound to the **token contract**. | `Eip3009Payload` |
| `"permit2"` | Uniswap Permit2 `PermitTransferFrom` to the canonical Permit2 token collector. Useful for tokens without `receiveWithAuthorization` (e.g., BSC USDC, Tempo pathUSD). | `Permit2Payload` |

A server MAY advertise multiple `accepts[]` entries with different `assetTransferMethod` values so the client picks whichever matches its token approvals.

## captureAuthorizer

`extra.captureAuthorizer` is the address authorized to call `authorize`, `capture`, `void`, `refund`, and `charge` against the escrow. The escrow gates those operations on `msg.sender == paymentInfo.operator`, so in the facilitator-submits flow the value must satisfy one of:

- An **EOA** — must equal the facilitator's submitter address (its tx `msg.sender` equals `paymentInfo.operator`).
- A **smart contract** that forwards calls to the escrow — the contract becomes `msg.sender` at the escrow.

The SDK auto-detects which path applies via `getCode(captureAuthorizer)`: empty bytecode routes the settle call directly to escrow; non-empty bytecode routes through the captureAuthorizer contract using the same ABI selectors. See the spec for protocol-level detail.

If neither condition holds (e.g., an unrelated EOA), the escrow's `onlySender` gate reverts with `InvalidSender` during the verify-step simulation, which the SDK maps to `invalid_capture_authorizer` on the `VerifyResponse`.

## Examples

- [Client example](../../../../../examples/clients/authCapture)
- [Server example](../../../../../examples/servers/authCapture)
- [Facilitator example](../../../../../examples/facilitator/authCapture)

## See Also

- [Scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/authCapture/scheme_authCapture_evm.md)
- [`AuthCaptureEscrow` contract](https://github.com/base/commerce-payments)
