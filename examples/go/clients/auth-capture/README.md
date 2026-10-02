# Auth-Capture Client (Go)

Demo client using the auth-capture scheme: signs a single authorize (collect)
payload for the request. The facilitator escrows the funds up front; after
the resource server handles the request, the facilitator captures (or voids)
the hold based on the server's signature.

## Run

```bash
cp .env-example .env
# fill in EVM_PRIVATE_KEY

go run .
```

Pair with `examples/go/servers/auth-capture` and `examples/go/facilitator/auth-capture`.

## Environment

| Variable               | Required | Description |
|-------------------------|----------|-------------|
| `EVM_PRIVATE_KEY`       | yes      | Payer wallet |
| `RESOURCE_SERVER_URL`   | no       | Default `http://localhost:4021` |
| `ENDPOINT_PATH`         | no       | Default `/weather` |
