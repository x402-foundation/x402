# Auth-Capture EVM Scheme (`go/mechanisms/evm/auth-capture`)

The **auth-capture** scheme adds refundable payments to x402, built on Base's audited [Commerce Payments Protocol](https://github.com/base/commerce-payments). The client signs a single collect payload (ERC-3009 by default, or Permit2) whose nonce is the payer-agnostic PaymentInfo hash.

See the [auth-capture EVM specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture_evm.md) for protocol details.

## Import Path

| Role   | Import                                                                      |
| ------ | --------------------------------------------------------------------------- |
| Client | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client` |
| Server | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server` |
| Facilitator | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator` |

## Client Usage

Register `AuthCaptureEvmScheme` with an `x402Client`. The client signs the payer-agnostic PaymentInfo hash and emits an ERC-3009 (default) or Permit2 payload.

When `extra.receiverAuthorizer` or `extra.policy` is non-zero, salt binding is on: the client emits a random `saltNonce` and a keccak `salt` committing to those addresses. Otherwise the wire shape is unbound (`salt` is random 32 bytes, no `saltNonce`).

The client resolves the commerce-payments deployment from optional `extra.authCaptureEscrow` (v1.1 default when omitted). That selects the escrow bound into the signature nonce and the collector used for `authorization.to` / `permit2Authorization.spender`.

```go
import (
    x402 "github.com/x402-foundation/x402/go/v2"
    authcaptureclient "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client"
    evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

signer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("EVM_PRIVATE_KEY"))

client := x402.Newx402Client()
client.Register("eip155:*", authcaptureclient.NewAuthCaptureEvmScheme(signer))
```

`ClientEvmSigner` only needs `Address()` and `SignTypedData`; no RPC is required for payload construction.

The client participates in the collect (`authorize` / `charge`) step only. Capture, void, and refund lifecycle payloads are server/facilitator responsibilities.

## Server Usage

The server publishes the escrow terms. The `Capture`, `Void`, `Charge` and `Refund` messages that let the facilitator release funds are signed by the receiver authorizer, which is either this server (a `ReceiverAuthorizerSigner`) or the facilitator; see [Receiver authorizer modes](#receiver-authorizer-modes).

```go
import (
    authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
)

receiverAuthorizer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("RECEIVER_AUTHORIZER_PRIVATE_KEY"))

scheme := authcaptureserver.NewAuthCaptureEvmScheme(&authcaptureserver.Config{
    ReceiverAuthorizerSigner: receiverAuthorizer,
})
```

Each route's terms come from a route extra, then `Config`, then what the facilitator advertises in `/supported`. `AuthCaptureRouteExtra` is the typed form: pass `Map()` as the route's `Extra`.

| Field | Values | Behaviour |
| --- | --- | --- |
| `PaymentFlow` | `escrow` (default), `authorization` | `authorization` settles a single `charge` after the handler runs. |
| `CaptureMode` | `sync` (default), `deferred` | `deferred` authorizes only and leaves capture to the `LifecycleManager`. Not allowed with `authorization`. |
| `OperatorType` | `delegated` (default), `custom` | `custom` names a contract as `CaptureAuthorizer`. The facilitator must admit it and it requires `deferred`. |
| `ReceiverAuthorizer` | address | Signer of facilitator-relayed `charge` / `capture` / `void` / `refund`, resolved per [Receiver authorizer modes](#receiver-authorizer-modes). The zero address means collect-only, valid only for `escrow` + `deferred`. It must be non-zero for every `authorization` route and for `escrow` + `sync`. |
| `CaptureAuthorizer`, `FeeRecipient`, `MinFeeBps`, `MaxFeeBps` | | Merchant-set terms. Invalid terms fail when the requirements are built. |
| `CaptureDeadline`, `RefundDeadline` | Unix seconds | Absolute deadlines. |
| `CaptureDeadlineSeconds`, `RefundDeadlineSeconds` | seconds | Offsets from issue time, added to the start of the current minute so 402s issued in the same minute match. |

`captureDeadline` and `refundDeadline` are dynamic extra fields, so the core server ignores them when matching a payment to its requirements. Set both deadlines of one form, never a mix. `maxTimeoutSeconds` must not exceed the capture window. With no fee terms the server publishes the zero address and `0`/`0` bounds, and the facilitator rejects a zero recipient paired with a non-zero bound.

### Settlement flow

- `escrow` + `sync`: the handler runs after `authorize`. A success captures, a failure or cancel voids.
- `escrow` + `deferred`: the handler runs after `authorize` and nothing is captured. A missing record for the payment aborts the settle.
- `authorization`: the server completes the payload with the final amount, fee and signature after the handler runs, and the facilitator submits a single `charge`.
- Overriding the settled amount below the signed amount captures that part and signs a `Void` for the remainder.

Fail-fast in `EnhancePaymentRequirements`:

- an `authorization` route, or `escrow` + `sync`, with no non-zero `ReceiverAuthorizer` (none from the scheme signer, the route, or the facilitator's `/supported`; a route that sets the zero address explicitly is also rejected)
- a route `ReceiverAuthorizer` that conflicts with `ReceiverAuthorizerSigner.Address()`
- a non-zero route `ReceiverAuthorizer` that is neither the scheme signer's address nor the facilitator-advertised address (the server holds no key for it)

Omitting `ReceiverAuthorizer` never implies collect-only: it resolves to the scheme signer or the facilitator-advertised authorizer, and fails when neither exists.

### Receiver authorizer modes

`ReceiverAuthorizer` is the address whose EIP-712 signature the escrow operator needs for `charge`, `capture`, `void`, and `refund`. Three modes exist, and the server picks one per route.

| Mode | `ReceiverAuthorizer` | Who signs | Wire payloads |
| --- | --- | --- | --- |
| Self | The scheme's `ReceiverAuthorizerSigner.Address()` | The server | Signed (`authorizerSignature`, and `voidAuthorizerSignature` when a capture also voids) |
| Delegated | A non-zero address the server holds no key for, normally the one the facilitator advertises in `/supported` | The facilitator, after authenticating the caller | Unsigned: the server omits the signatures |
| Collect-only | The zero address | Nobody onchain (`escrow` + `deferred` only) | None: lifecycle runs out of band |

The server resolves the mode in this order:

1. A configured `ReceiverAuthorizerSigner` wins. A route value that differs from its address fails.
2. Otherwise a route value of the zero address is collect-only, and a route value equal to the facilitator-advertised address is delegated. Any other non-zero route value fails, because nobody could sign for it.
3. Otherwise the facilitator-advertised non-zero address is used (delegated).
4. Otherwise `EnhancePaymentRequirements` fails. Set a `ReceiverAuthorizerSigner`, set `ReceiverAuthorizer` to the zero address on an `escrow` + `deferred` route, or point the server at a facilitator that advertises one.

In delegated mode the facilitator's signature no longer proves the server's intent, so the facilitator authenticates each settle out of band. See [Delegated receiver authorizer](#delegated-receiver-authorizer) for the facilitator side.

`ValidateFacilitatorSupport` runs during `x402ResourceServer` initialization and fails fast when the facilitator omits `captureAuthorizer` or, for delegated receiver signing, `receiverAuthorizer`. Collect-only merchants whose routes always set `ReceiverAuthorizer` to the zero address may set `Config.CollectOnlyRoutes` to skip the receiver check. Route-specific mistakes (for example `escrow` + `sync` without any authorizer) still surface in `EnhancePaymentRequirements`.

### Lifecycle manager

`scheme.NewLifecycleManager(facilitator)` captures, voids and refunds payments recorded in `Config.Storage` (in memory by default, implement `AuthorizedPaymentStorage` for durability). `Capture` takes optional `CaptureOptions` (amount, fee, `VoidRemainder`). `Refund` needs the facilitator to run with `RefundFunding`. Payments on custom operators and `authorization` payments cannot be captured or voided through the manager. It supports self and delegated payments: delegated payloads are sent unsigned, with `voidRemainder: true` in place of `voidAuthorizerSignature`. It fails with `ErrLifecycleUnavailable` for a collect-only payment, whose lifecycle is out of band.

## Facilitator Usage

The facilitator is the delegated escrow operator: it verifies and settles the collect (`authorize`), then relays the `capture`, `void` or `refund` (signed by the server, or by the facilitator itself when the authorizer is delegated). It also submits the server-completed `charge` of an `authorization` flow.

```go
import (
    authcapturefacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
)

scheme, err := authcapturefacilitator.NewAuthCaptureEvmSchemeWithError(signer, authcapturefacilitator.AuthCaptureEvmSchemeConfig{
    CaptureAuthorizers: signer.GetAddresses(),
})
```

`NewAuthCaptureEvmSchemeWithError` returns a misconfiguration as an error; `NewAuthCaptureEvmScheme` panics instead.

`CaptureAuthorizers` is the pool of operator addresses, each one of the signer's addresses (`CaptureAuthorizer` is a one-element shorthand). Each `/supported` response advertises one pool member, picked at random or by `SelectCaptureAuthorizer`. That address is committed onchain as the payment's operator, so every pool member must stay usable, and funded when `RefundFunding` is on, until its payments pass `refundDeadline`.

The escrow gates `authorize`, `capture` and `void` on `msg.sender`, so simulations and writes are sent from the operator through the signer's `ReadContractFrom` and `WriteContractFrom`. Simulation failures map to the spec's `invalid_auth_capture_evm_*` reasons. For counterfactual payers, list the wallet factories in `EIP6492AllowedFactories`; verification then simulates only the factory deployment, since the collect cannot be simulated before the wallet exists.

### Delegated receiver authorizer

To let servers omit their own authorizer key, configure all four fields together (a partial configuration is rejected):

```go
scheme := authcapturefacilitator.NewAuthCaptureEvmScheme(signer, authcapturefacilitator.AuthCaptureEvmSchemeConfig{
    CaptureAuthorizers: signer.GetAddresses(),
    AuthorizerSigner:   authorizerSigner, // advertised in /supported as extra.receiverAuthorizer
    // Return a stable identity for the caller (for example from an API key or mTLS client
    // certificate). An empty string or an error rejects the settle.
    ResolveCallerIdentity: func(ctx context.Context, settle authcapturefacilitator.DelegatedSettleContext) (string, error) {
        return lookupMerchant(settle.Payload)
    },
    DelegatedAuthStorage: store, // implements AuthCaptureDelegatedAuthStorage
    OnStorageError: func(err error, network x402.Network, paymentInfoHash string) {
        reportBindingFailure(err, network, paymentInfoHash)
    },
    // RefundFunding: true, // needed to relay delegated refunds
})
```

How the facilitator uses the identity:

- `Verify` never resolves identity and never writes a binding.
- On `Settle` of an `authorize`, or of a `charge` with `RefundFunding`, the facilitator re-verifies, resolves the identity, binds it to the `paymentInfoHash` (with `ExpiresAt` set to `refundDeadline`), then broadcasts. If the bind fails (another identity already holds it, or the storage is down) nothing is broadcast and the settle fails with `invalid_auth_capture_evm_unauthenticated_authorizer_request` or `invalid_auth_capture_evm_delegated_auth_unavailable`.
- The binding is reverted only when this call created it and the send failed or the transaction reverted onchain. It is kept when the outcome is unknown, such as a receipt timeout.
- Each later `capture`, `void`, or `refund` must resolve to the bound identity before the facilitator signs. A missing, expired, or different binding is rejected.
- A confirmed settle that leaves nothing capturable or refundable deletes the binding early. This is best effort and failures are reported through `OnStorageError`.
- A capture that also voids the remainder carries `voidRemainder: true` instead of `voidAuthorizerSignature`; the facilitator signs both legs.

Operational notes:

- `InMemoryAuthCaptureDelegatedAuthStorage` is for local testing only. Use a durable store with an atomic insert-if-absent `Bind` when more than one process serves the same payments.
- Identity is first-writer-wins, so anyone who can present the same credential can drive that payment's lifecycle. Give each merchant its own credential.

### Custom operators

A custom operator is a contract that forwards to the escrow. The facilitator relays its collect only when listed in `Operators` (an entry with address `*` admits every custom operator) and the signer implements `CallSimulator` and `GasLimitWriter`. It simulates the call under `CustomOperatorGasLimit`, then checks the escrow event, the payment state and every balance delta before broadcasting, and again against the receipt after. It never relays `capture`, `void` or `refund` for a custom operator. When it supports custom operators, `/supported` advertises them in `extra.operators`.

### Refund funding

The refund collector pulls the refunded tokens from the payment's operator, any member of `CaptureAuthorizers`. Set `RefundFunding` only with an out-of-band funding agreement that keeps every advertised submitter funded and approved. Without it a delegated operator's refund is rejected with `invalid_auth_capture_evm_refund_funding_unavailable`.
