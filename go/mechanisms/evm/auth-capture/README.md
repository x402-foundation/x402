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

The server publishes the escrow terms and, after the handler runs, signs the `Capture` (success) or `Void` (failure or cancel) message that lets the facilitator release the hold. The receiver-authorizer signer is required.

```go
import (
    authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
)

receiverAuthorizer, _ := evmsigners.NewClientSignerFromPrivateKey(os.Getenv("RECEIVER_AUTHORIZER_PRIVATE_KEY"))

scheme := authcaptureserver.NewAuthCaptureEvmScheme(&authcaptureserver.Config{
    ReceiverAuthorizerSigner: receiverAuthorizer,
})
```

`CaptureAuthorizer`, `FeeRecipient` and the fee bounds default to what the facilitator advertises in `/supported`. With no fee terms the server publishes the zero address and `0`/`0` bounds, and the facilitator rejects a zero recipient paired with a non-zero bound. `maxTimeoutSeconds` must not exceed the capture deadline (`CaptureDeadline`, default 10 minutes).

## Facilitator Usage

The facilitator is the delegated escrow operator: it verifies and settles the collect (`authorize`), then relays the server-signed `capture` or `void`. Autocapture (`charge`) is not supported.

```go
import (
    authcapturefacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
)

scheme := authcapturefacilitator.NewAuthCaptureEvmScheme(signer, authcapturefacilitator.AuthCaptureEvmSchemeConfig{
    CaptureAuthorizer: signer.GetAddresses()[0],
})
```

`CaptureAuthorizer` must be one of the signer's addresses. The escrow gates `authorize`, `capture` and `void` on `msg.sender`, so simulations must `eth_call` from that address. A signer that implements the optional `SenderReader` (`ReadContractFrom`) is called with the operator as the sender explicitly. Otherwise its `ReadContract` must itself call from the operator. Simulation failures map to the spec's `invalid_auth_capture_evm_*` reasons. For counterfactual payers, list the wallet factories in `EIP6492AllowedFactories`; verification then simulates only the factory deployment, since the collect cannot be simulated before the wallet exists.
