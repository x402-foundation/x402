# Auth-Capture Facilitator (Go)

Standalone HTTP facilitator with the auth-capture EVM scheme registered for
Base Sepolia. Exposes the standard x402 endpoints:

- `GET /supported`
- `POST /verify`
- `POST /settle`

This facilitator is the escrow operator (`captureAuthorizer`): it verifies and
settles the client's initial authorize (collect) onchain, then later relays
the resource server's `capture`/`void` lifecycle calls.

| Env var | Role | Onchain effect |
| --- | --- | --- |
| `EVM_PRIVATE_KEY` | **Relayer** — submits transactions | Pays gas; for `"delegated"` routes this address is `extra.captureAuthorizer` |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | **Receiver authorizer** (optional) | When set, advertised in `/supported` as `extra.receiverAuthorizer`. Resource servers that omit their own authorizer key send unsigned payloads; this facilitator signs after `ResolveCallerIdentity` authenticates the caller |

Without `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`, `/supported` advertises only `extra.captureAuthorizer`. Resource servers must configure `ReceiverAuthorizerSigner` locally.

## Receiver authorizer delegation (optional)

To let resource servers delegate capture/void/refund signing to this facilitator, set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` (recommended: a key separate from the relayer). `GET /supported` then includes `extra.receiverAuthorizer`:

```json
{
  "kinds": [
    {
      "scheme": "auth-capture",
      "network": "eip155:84532",
      "extra": {
        "captureAuthorizer": "...",
        "receiverAuthorizer": "..."
      }
    }
  ]
}
```

This example wires the facilitator SDK opt-in (all four fields required, otherwise `NewAuthCaptureEvmScheme` panics):

- `AuthorizerSigner` from `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`
- `ResolveCallerIdentity` — invoked by the SDK during delegated settles with a `DelegatedSettleContext` (`Step`, `PaymentInfoHash`, `Payload`, `Requirements`, optional `FacilitatorContext`)
- `DelegatedAuthStorage` — this example uses `InMemoryAuthCaptureDelegatedAuthStorage` for local testing only
- `OnStorageError` — reports binding revert/delete failures

`POST /settle` is a thin wrapper around `facilitator.Settle()`; it does not implement custom identity plumbing. Caller authentication belongs in `ResolveCallerIdentity` (see the [scheme README](../../../../go/mechanisms/evm/auth-capture/README.md#receiver-authorizer-modes)).

```go
config.AuthorizerSigner = authorizerSigner
config.DelegatedAuthStorage = authcapturefac.NewInMemoryAuthCaptureDelegatedAuthStorage()
config.OnStorageError = func(err error, network x402.Network, paymentInfoHash string) {
	/* ... */
}
config.ResolveCallerIdentity = func(ctx context.Context, settle authcapturefac.DelegatedSettleContext) (string, error) {
	// Authenticate the resource server (API key, mTLS, JWT, etc.) using settle and/or
	// settle.FacilitatorContext. Return a stable merchant id, or an empty string to
	// reject. Local testing only:
	return "example-local-caller", nil
}
```

The first authenticated caller to settle a payment is bound to its `paymentInfoHash`; later lifecycle settles must resolve to the same identity. For production, replace the in-memory store with a durable, atomic implementation (Redis, SQL, etc.) when more than one facilitator process serves the same payments.

> ⚠️ **Local testing only:** this example returns a fixed identity from `ResolveCallerIdentity`. Do not advertise `receiverAuthorizer` without real authentication.

Pair with the [auth-capture server example](../../servers/auth-capture/): run this facilitator with `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` set and omit `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the resource server for facilitator-delegated sync flows.

## Custom-operator allowlist

`CUSTOM_OPERATOR_ALLOWLIST` is a comma-separated list of operator addresses the facilitator will relay collect for, advertised in `/supported` as `extra.operators` when the signer implements `SimulateCalls` and `WriteContractWithGas` (this example wires both via `eth_simulateV1`). Leave it empty to admit no custom operator; set it to the operator address the [custom-escrow server example](../../servers/auth-capture/) deploys so that flow can relay collect-only `authorize` through it.

Custom collect verification uses `eth_simulateV1` with a gas cap (`CustomOperatorGasLimit`, default `1_000_000`) and outcome checks before broadcast.

## Run

```bash
cp .env-example .env
# fill in EVM_PRIVATE_KEY (and optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY,
# CUSTOM_OPERATOR_ALLOWLIST, EVM_RPC_URL, PORT)

go run .
```

Listens on `http://localhost:4022` by default (`PORT` overrides).

## Environment

| Variable             | Description |
|-----------------------|-------------|
| `EVM_PRIVATE_KEY` (required) | Facilitator/operator wallet — signs and submits onchain transactions |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | Optional dedicated receiver authorizer; enables facilitator-delegated signing |
| `EVM_RPC_URL`         | Default `https://sepolia.base.org` |
| `FEE_RECIPIENT`       | Optional advertised fee recipient |
| `MIN_FEE_BPS`/`MAX_FEE_BPS` | Optional advertised fee bounds |
| `CUSTOM_OPERATOR_ALLOWLIST` | Comma-separated custom operator addresses to admit (empty admits none) |
| `PORT`                | Listen port (default `4022`) |
