# Auth-Capture EVM Scheme (`@x402/evm/auth-capture`)

The **auth-capture** scheme adds refundable payments to x402, built on Base's audited [Commerce Payments Protocol](https://github.com/base/commerce-payments). The client signs a single payload (ERC-3009 or Permit2). The facilitator submits to `AuthCaptureEscrow`, where funds are escrowed under a `captureAuthorizer` role rather than transferred straight to the merchant, enabling capture, void, and refund before settlement is final.

Two payment flows, selected per route by `extra.paymentFlow` (default `"escrow"`):

- **Escrow**: first settle is `authorize` (hold). After the resource runs, finalize with `capture` / `void` (`captureMode: "sync"`, default) or skip that settle and capture later (`captureMode: "deferred"`).
- **Authorization**: verify, run the resource, then settle as a terminal `charge`. No hold, therefore no `capture` / `void`.

See the [auth-capture EVM specification](../../../../../specs/schemes/auth-capture/scheme_auth_capture_evm.md) for protocol details.

## Import Paths

| Role        | Import                               |
| ----------- | ------------------------------------ |
| Client      | `@x402/evm/auth-capture/client`      |
| Server      | `@x402/evm/auth-capture/server`      |
| Facilitator | `@x402/evm/auth-capture/facilitator` |

## Client Usage

Register `AuthCaptureEvmScheme` with an `x402Client`. The client signs the payer-agnostic PaymentInfo hash and emits an ERC-3009 (default) or Permit2 payload.

When `extra.receiverAuthorizer` or `extra.policy` is non-zero, salt binding is on: the client emits a random `saltNonce` and a keccak `salt` committing to those addresses. Otherwise the wire is the v1.0 unbound shape (`salt` is random 32 bytes, no `saltNonce`).

```typescript
import { x402Client } from "@x402/core/client";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/client";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

const client = new x402Client();
client.register("eip155:*", new AuthCaptureEvmScheme(account));
```

`ClientEvmSigner` only needs `address` + `signTypedData`; a bare viem `LocalAccount` satisfies the shape, no `PublicClient` required.

## Server Usage

Register `AuthCaptureEvmScheme` with an `x402ResourceServer` and publish payment requirements with the spec-mandated `extra` fields. `paymentFlows` is static: both collectors support `"escrow"` (default) and `"authorization"`. Choose the flow and capture mode on the route's `extra`.

The example below is collect-only escrow (`captureMode: "deferred"`): the facilitator relays `authorize`, and later lifecycle runs out of band (or through `createLifecycleManager` once you add a `receiverAuthorizerSigner`).

```typescript
import { HTTPFacilitatorClient } from "@x402/core/server";
import {
  AuthCaptureEvmScheme,
  type AuthCaptureRouteExtra,
} from "@x402/evm/auth-capture/server";
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
          scheme: "auth-capture",
          price: "$0.01",
          network: "eip155:84532",
          payTo: receiverAddress,
          extra: {
            captureDeadlineSeconds: 3600, // seconds-from-now; scheme converts to absolute per request
            refundDeadlineSeconds: 7200,
            feeRecipient: zeroAddress, // address(0) with zero bounds: no facilitator fee
            minFeeBps: 0,
            maxFeeBps: 0,
            captureMode: "deferred",
          } satisfies AuthCaptureRouteExtra,
        },
        description: "Weather data",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);
```

Import `AuthCaptureRouteExtra` from `@x402/evm/auth-capture/server` if you want the compiler to reject forbidden combinations (`captureMode` on an authorization route, mixed absolute/relative deadlines). `PaymentOption.extra` is `Record<string, unknown>` on the wire, so the `satisfies` check only applies to the literal you write. Escrow sync and authorization routes derive `receiverAuthorizer` from the scheme's `receiverAuthorizerSigner` when the route omits it.

### Required `extra` fields

| Field | Type | Notes |
| --- | --- | --- |
| `captureAuthorizer` | `address` | Committed onchain as `PaymentInfo.operator`. For `operatorType: "delegated"`, omit this — the scheme copies `extra.captureAuthorizer` from the facilitator's `/supported` kind (like SVM `feePayer`). Required for `"custom"`. See [Operator types](#operator-types) below. |
| `feeRecipient` | `address` | `address(0)` lets the captureAuthorizer pick a non-zero recipient at capture/charge time. |
| `minFeeBps` | `uint16` | Floor on the captureAuthorizer's fee. `0` = no minimum. |
| `maxFeeBps` | `uint16` | Cap on the captureAuthorizer's fee. |

Either set **both** deadline windows as relative offsets (recommended) or **both** as absolute Unix seconds. Mixing one absolute with one relative throws at enhance time.

| Field | Type | Notes |
| --- | --- | --- |
| `captureDeadlineSeconds` | `number` | Seconds-from-now. The scheme converts to `captureDeadline` (absolute) inside `enhancePaymentRequirements` per request, then strips this key from the published `extra`. |
| `refundDeadlineSeconds` | `number` | Seconds-from-now. Converted to `refundDeadline` the same way. |
| `captureDeadline` | `uint48` | Absolute Unix seconds. Use this when the deadline is tied to an external commitment (e.g., a delivery date). |
| `refundDeadline` | `uint48` | Absolute Unix seconds. |

If neither pair is set, `enhancePaymentRequirements` throws server-side with a message naming the missing field, so misconfiguration surfaces in the merchant's logs immediately rather than as an `invalid_auth_capture_evm_extra` 402 to the payer.

The server-side fail-fast also covers the other directly-merchant-set fields (`captureAuthorizer`, `feeRecipient`, `minFeeBps`, `maxFeeBps`); a missing or wrongly-typed value throws at enhance time with a message naming the offending key. `autoCapture` is rejected outright — v1.1 replaced it with `paymentFlow`.

### Auto-populated by the scheme

`AuthCaptureEvmScheme.parsePrice` resolves decimal prices like `"$0.01"` (or ticker-suffixed ones like `"0.01 USDC"`, which select among the network's default assets) against `@x402/evm`'s default-asset table and writes `name` / `version` (EIP-712 token domain) and, where the chain's default uses Permit2, `assetTransferMethod: "permit2"` into the resulting `AssetAmount.extra` for you. The middleware merges these into the published `requirements.extra`, so merchants using decimal pricing do not need to set them by hand. Merchants supplying their own `AssetAmount` (custom token) must set `name` / `version` themselves on the `AssetAmount.extra`; the facilitator's `isAuthCaptureExtra` guard catches the case where they're missing on the wire side (no server-side fail-fast, matching how `batch-settlement` handles its scheme-auto-populated EIP-712 domain fields).

### Optional `extra` fields

| Field | Default | Notes |
| --- | --- | --- |
| `paymentFlow` | `"escrow"` | `"escrow"` → `authorize` then capture/void. `"authorization"` → terminal `charge`. Written back onto extra so core cannot drop it. |
| `captureMode` | `"sync"` | Escrow only. `"sync"` authors a signed capture (or void) on the after-handler settle. `"deferred"` skips that settle; capture later via helpers. Forbidden on `"authorization"`. Must be `"deferred"` for `operatorType: "custom"`, which is collect-only. |
| `receiverAuthorizer` | zero address | Signer of facilitator-relayed `charge` / `capture` / `void` / `refund`. Derived from `receiverAuthorizerSigner.address` when that signer is configured. Must be non-zero for every authorization route and for escrow + sync. Non-zero turns salt binding on. |
| `policy` | zero address | Reserved. Non-zero is rejected for `"delegated"` and `"custom"` (`operatorType: "policy"` is not implemented). Still bound into the salt derivation. |
| `operatorType` | `"delegated"` | `"delegated"` (facilitator is the operator) or `"custom"` (allowlisted contract operator). `"policy"` is rejected. |
| `assetTransferMethod` | `"eip3009"` | `"eip3009"` (ERC-3009) or `"permit2"` (Uniswap Permit2). See [Asset Transfer Methods](#asset-transfer-methods). |
| `authCaptureEscrow` | v1.1 escrow | Selects the commerce-payments deployment (v1.1 default, or v1.0 when pinned). The server writes the resolved address out on publish. Collectors follow from the deployment — they are not on `extra`. |

Fail-fast in `enhancePaymentRequirements`:

- escrow + sync on an `operatorType: "custom"` route (collect-only: the facilitator refuses relayed capture/void, so the hold could never be finalized)
- escrow + sync without a `receiverAuthorizerSigner` on the scheme
- an authorization route without a non-zero `receiverAuthorizer` from the route, configured signer, or facilitator
- a route `receiverAuthorizer` that conflicts with `receiverAuthorizerSigner.address`
- `captureMode` set on an authorization route
- `autoCapture` present at all

Escrow + deferred is allowed without a `receiverAuthorizer`: that is collect-only, whose lifecycle runs out of band. With a `receiverAuthorizerSigner` configured, escrow + deferred also derives the field so later `createLifecycleManager` captures have salt binding on.

## Deferred lifecycle: storage and helpers

Pass `receiverAuthorizerSigner` (and optional `storage`) to the scheme constructor. Successful collect settles persist an `AuthorizedPayment` record via `onAfterSettle` (the before-handler `authorize` under escrow, or the after-handler `charge` under authorization). Sync routes persist too, because a later refund still needs durable state.

Out-of-band `capture` / `void` / `refund` go through `scheme.createLifecycleManager(facilitator)`. In-request hooks stay on the scheme.

The default `InMemoryAuthorizedPaymentStorage` is atomic only inside one JS runtime and loses deferred captures on restart; the payer's protection in that case is `reclaim` after the capture deadline. Production multi-instance deployments need a backend with atomic conditional mutation.

```typescript
const scheme = new AuthCaptureEvmScheme({
  receiverAuthorizerSigner,
  // storage: new MyAuthorizedPaymentStorage(), // optional; in-memory default
});
const lifecycle = scheme.createLifecycleManager(facilitator);

const response = await lifecycle.capture(paymentInfoHash, {
  amount: "500000",
  voidRemainder: true, // requires an explicit partial amount
});
await lifecycle.voidPayment(paymentInfoHash);
await lifecycle.refund(paymentInfoHash, { amount: "100000" });
await lifecycle.getAuthorizedPayment(paymentInfoHash);
await lifecycle.listAuthorizedPayments();
```

Each helper builds the lifecycle payload, signs it with the receiver authorizer, POSTs it to the facilitator's `/settle`, and writes the new balances back. `voidPayment` rather than `void` because `void` is a reserved word.

Sync escrow routes author the signed capture in `enrichSettlementPayload` (additive: `type`, `paymentInfo`, amounts, fees, signatures — never re-emitting `saltNonce`). Deferred routes implement `onBeforeSettle` and return `{ skip: true, result }` so core never calls the facilitator for that after-handler settle. Handler failures go through `settleOnCancel`, which returns requirements for a void.

Partial capture amount uses the same settlement-overrides response header as `upto`: core resolves it into `ctx.requirements.amount` before the scheme sees it.

## Facilitator Usage

Register the scheme with an `x402Facilitator` instance. Optional config groups fee terms and the custom-operator allowlist advertised on `/supported`:

```typescript
import { x402Facilitator } from "@x402/core/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/facilitator";
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
  simulateCalls: args => viemClient.simulateCalls(args),
  verifyTypedData: args => viemClient.verifyTypedData(args),
  writeContract: args => viemClient.writeContract(args),
  sendTransaction: args => viemClient.sendTransaction(args),
  waitForTransactionReceipt: args => viemClient.waitForTransactionReceipt(args),
});

const facilitator = new x402Facilitator();
facilitator.register(
  "eip155:84532",
  new AuthCaptureEvmScheme(evmSigner, {
    feeTerms: { feeRecipient, minFeeBps: 100, maxFeeBps: 100 },
    operators: [{ address: customOperatorAddress, operatorType: "custom" }],
    customOperatorAuthorizeGasLimit: 1_000_000n,
    eip6492AllowedFactories: [smartWalletFactoryAddress], // omit to reject undeployed payers
    refundFunding: false, // set true only with an out-of-band funding agreement
  }),
);
```

`operators` admits by address, not by code: an operator behind a proxy can swap its implementation after you allowlist it, and `{ address: "*" }` admits contracts you have never reviewed. Prefer immutable operator contracts, re-review on every upgrade, and treat the per-relay outcome checks below as the thing that actually bounds the exposure.

`getExtra` advertises a randomly selected `captureAuthorizer` from the signer set so delegated servers copy it into payment requirements (same rotation pattern as SVM `feePayer`). A facilitator that rotates submitters MUST remain able to submit from every address it has advertised until those payments pass `refundDeadline`, and with `refundFunding: true` MUST fund and approve every address in the rotation. Multiple submitters go into one constructor array — do not `facilitator.register` the scheme twice on the same network; the second registration is silently unreachable.

```typescript
const signerA = toFacilitatorEvmSigner({ address: accountA.address, ...clientA });
const signerB = toFacilitatorEvmSigner({ address: accountB.address, ...clientB });
facilitator.register("eip155:84532", new AuthCaptureEvmScheme([signerA, signerB], config));
```

Each submitter gets its own CREATE2 token store on first authorize, so N keys mean N first-authorize deployment costs and escrow-held balances split N ways.

`verify` performs envelope shape checks, scheme/network agreement, `extra` validation, operator-type / allowlist rules, salt binding, deadline-ordering invariants, per-method field checks, client signature verification (ECDSA, ERC-1271, or the inner signature of an EIP-6492 envelope), nonce binding to the payer-agnostic PaymentInfo hash, authorizer EIP-712 signatures on lifecycle / completed charge payloads, single-use `paymentState` checks, and an onchain simulation of the target call so typed escrow reverts surface as stable `invalid_auth_capture_evm_*` reasons. The initial verification of an authorization-flow client payload has no server-authored completion fields, so it provisionally simulates a full-amount charge with default fee terms; settlement re-verification requires `amount`, `feeBps`, `feeReceiver`, and `authorizerSignature`, then simulates that exact signed charge. For `"custom"` operators, collect verification uses `eth_simulateV1` (`simulateCalls`) with a facilitator-chosen gas cap and outcome checks (canonical escrow event, `paymentState`, token deltas, facilitator balance unchanged). That costs materially more RPC than a `"delegated"` verify, which preflights with a single `eth_call`: the custom path reads the operator's token store and then simulates a bundle of 9 calls for `authorize` (11 for `charge`) to snapshot state on both sides of the relay. When extension context adds a calldata suffix, the custom-operator simulation includes the same suffix that settlement broadcasts. The mined transaction is checked against the same payment-state and payment-token balance invariants before settlement is reported as successful. Facilitators that advertise `"custom"` on `/supported` must wire `simulateCalls` on every signer; otherwise `operators` is omitted from `getExtra`.

`settle` re-verifies then dispatches:

- no `payload.type` + `paymentFlow: "escrow"` (default) → `authorize`
- no `payload.type` + `paymentFlow: "authorization"` → `charge`
- `payload.type` of `"capture"` / `"void"` / `"refund"` → lifecycle (capture-and-void when `voidAuthorizerSignature` is present)

The settle target is the canonical escrow for `"delegated"` and `extra.captureAuthorizer` for `"custom"`. Bytecode is not probed. `collectorData` is payer-controlled opaque bytes; custom operators must forward it unchanged. ERC-6492 preparation calldata is executed by the token collector through a neutral Multicall3 sender, not as the facilitator or operator.

### Undeployed (counterfactual) payer wallets

`collectorData` is submitted as the client signed it, ERC-6492 wrapper included. The collector's `ERC6492SignatureHandler` strips the wrapper onchain, runs the preparation call through Multicall3, and only then hands the inner signature to the token or Permit2 — so unwrapping before submitting would drop the deployment an undeployed wallet needs.

A payer whose wallet is not deployed yet has no `isValidSignature` to call, so `verify` cannot check its signature locally. It instead requires the preparation target to appear in `eip6492AllowedFactories` and leaves the signature to the onchain simulation, which deploys the wallet and then validates. A target outside the list is rejected with `invalid_auth_capture_evm_erc6492_factory_not_allowed`, and an omitted list rejects every counterfactual payer. The allowlist is about gas, not authority: Multicall3 makes the facilitator a bystander to the preparation call, but an unknown target can still burn gas inside the facilitator's transaction. A deployed wallet that still sends a wrapped signature takes the normal ERC-1271 path and needs no allowlist entry.

## Supported Networks

| Network      | CAIP-2 ID      |
| ------------ | -------------- |
| Base Mainnet | `eip155:8453`  |
| Base Sepolia | `eip155:84532` |

Requires the canonical `AuthCaptureEscrow` and EIP-3009 / Permit2 / operator-refund token collectors deployed at universal CREATE2 addresses on the target network. The constants live in [`./constants.ts`](./constants.ts).

## Payment flows and capture modes

| `paymentFlow` | `captureMode` | First settle | After the resource |
| --- | --- | --- | --- |
| `"escrow"` (default) | `"sync"` (default) | `escrow.authorize(...)` | Second settle relays signed `capture` / `void`. Requires `receiverAuthorizerSigner` on the scheme. |
| `"escrow"` | `"deferred"` | `escrow.authorize(...)` | After-handler settle is skipped. Capture later via `createLifecycleManager(facilitator).capture` / `voidPayment` / `refund`, or out of band. |
| `"authorization"` | n/a | (verify only) | `escrow.charge(...)` with an authorizer-signed completion. A non-zero `receiverAuthorizer` is required and `captureMode` must be omitted. |

## Operator types

`extra.operatorType` names the kind of `extra.captureAuthorizer`, committed onchain as `PaymentInfo.operator`.

| Type | Settle target | Facilitator relays |
| --- | --- | --- |
| `"delegated"` (default) | Canonical `AuthCaptureEscrow` | `authorize` always; `charge` and lifecycle only when `receiverAuthorizer` is non-zero. `captureAuthorizer` must be an address the facilitator submits from (EOA or smart-contract account). |
| `"custom"` | `extra.captureAuthorizer` | Collect only, and only if that address is on the facilitator's operator allowlist. `charge` requires a non-zero `receiverAuthorizer`; lifecycle is out of band, so escrow routes must set `captureMode: "deferred"`. |
| `"policy"` | — | Reserved. Rejected with `invalid_auth_capture_evm_unsupported_operator_type`. |

## Asset Transfer Methods

The `assetTransferMethod` field on `extra` selects how the payer's funds reach escrow:

| Method | Description | Wire shape |
| --- | --- | --- |
| `"eip3009"` (default) | ERC-3009 `ReceiveWithAuthorization` to the canonical EIP-3009 token collector. EIP-712 domain is bound to the **token contract**. | `Eip3009Payload` |
| `"permit2"` | Uniswap Permit2 `PermitTransferFrom` to the canonical Permit2 token collector. Useful for tokens without `receiveWithAuthorization` (e.g., BSC USDC, Tempo pathUSD). | `Permit2Payload` |

A server MAY advertise multiple `accepts[]` entries with different `assetTransferMethod` values so the client picks whichever matches its token approvals.

## Examples

- [Client example](../../../../../examples/typescript/clients/fetch)
- [Server example](../../../../../examples/servers/auth-capture)
- [Facilitator example](../../../../../examples/facilitator/auth-capture)

## See Also

- [Proposed v1.1 scheme specification](../../../../../specs/proposed/scheme_auth_capture_evm.md)
- [Frozen v1.0 scheme specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth-capture_evm.md)
- [`AuthCaptureEscrow` contract](https://github.com/base/commerce-payments)
