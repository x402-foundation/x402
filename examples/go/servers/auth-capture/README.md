# Auth-Capture Server (Go)

Demo resource server using the auth-capture scheme's escrow payment flow: the
facilitator authorizes funds into escrow *before* the handler runs, the
handler serves the request, and then this server signs a Capture (success)
or Void (failure/cancel) message that lets the facilitator release the
escrowed funds.

The receiver authorizer that signs Capture/Void is either:

- **Self:** set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`; its address is published as `extra.receiverAuthorizer`
- **Delegated:** omit the key; `extra.receiverAuthorizer` is taken from the facilitator's `/supported`, this server sends unsigned payloads, and the facilitator signs them after authenticating the caller

## Flows

| Command | `operatorType` | `captureMode` | Behavior |
| --- | --- | --- | --- |
| `go run .` | `"delegated"` (default) | `"sync"` (default) | Escrow authorize, then capture/void after the handler |
| `go run . custom-escrow` | `"custom"` | `"deferred"` | Collect-only `authorize` through a custom operator; lifecycle is out of band |

### Custom escrow (collect-only)

`extra.captureAuthorizer` is a deployed custom operator contract. The facilitator relays only the collect `authorize`; capture/void/refund happen on the operator outside x402.

1. Facilitator: set `CUSTOM_OPERATOR_ALLOWLIST` to the operator address (see [facilitator example](../../facilitator/auth-capture/)).
2. Server: set `CUSTOM_OPERATOR_ADDRESS` to the same address and run `go run . custom-escrow`.

Collect-only routes use `extra.receiverAuthorizer` of the zero address and `CollectOnlyRoutes` on the scheme so startup does not require a facilitator `receiverAuthorizer`.

## Run

```bash
cp .env-example .env
# fill in EVM_PAYEE_ADDRESS, FACILITATOR_URL, and optionally EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY

go run .

# or custom-operator collect-only:
# CUSTOM_OPERATOR_ADDRESS=0x8FE415CdB559fBF5B235B81CC4F7a69684A274bb
go run . custom-escrow
```

The server listens on `http://localhost:4021` by default (`PORT` overrides). Pair
with `examples/go/clients/http` and `examples/go/facilitator/auth-capture`.

## Environment

| Variable                              | Required | Description |
|----------------------------------------|----------|-------------|
| `EVM_PAYEE_ADDRESS`                    | yes      | `payTo` address (escrow receiver) |
| `FACILITATOR_URL`                      | yes      | Auth-capture facilitator endpoint (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`  | no       | Self-managed receiver authorizer (default `go run .` flow only) |
| `CUSTOM_OPERATOR_ADDRESS`              | custom-escrow | Custom operator contract; must be allowlisted on the facilitator |
| `PORT`                                 | no       | Listen port (default `4021`) |
