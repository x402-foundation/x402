# Auth-Capture Server (Go)

Demo resource server using the auth-capture scheme's escrow payment flow: the
facilitator authorizes funds into escrow *before* the handler runs, the
handler serves the request, and then this server signs a Capture (success)
or Void (failure/cancel) message that lets the facilitator release the
escrowed funds.

## Run

```bash
cp .env-example .env
# fill in EVM_PAYEE_ADDRESS, FACILITATOR_URL, EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY

go run .
```

The server listens on `http://localhost:4021` and exposes `GET /weather`. Pair
with `examples/go/clients/auth-capture` and `examples/go/facilitator/auth-capture`.

## Environment

| Variable                              | Required | Description |
|----------------------------------------|----------|-------------|
| `EVM_PAYEE_ADDRESS`                    | yes      | `payTo` address (escrow receiver) |
| `FACILITATOR_URL`                      | yes      | Auth-capture facilitator endpoint (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`  | yes      | Signs the Capture/Void EIP-712 messages that release escrowed funds |
