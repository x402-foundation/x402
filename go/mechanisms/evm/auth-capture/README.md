# Auth-Capture EVM Scheme (`go/mechanisms/evm/auth-capture`)

The **auth-capture** scheme adds refundable payments to x402, built on Base's audited [Commerce Payments Protocol](https://github.com/base/commerce-payments). The client signs a single collect payload (ERC-3009 by default, or Permit2) whose nonce is the payer-agnostic PaymentInfo hash.

See the [auth-capture EVM specification](https://github.com/x402-foundation/x402/blob/main/specs/schemes/auth-capture/scheme_auth_capture_evm.md) for protocol details.

## Import Path

| Role   | Import                                                                      |
| ------ | --------------------------------------------------------------------------- |
| Client | `github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/client` |

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
