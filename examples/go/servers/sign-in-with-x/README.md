# Sign-In-With-X Server Example

This example mirrors the TypeScript SIWX server example:

- `GET /profile` uses auth-only SIWX.
- `GET /weather` requires payment once, then accepts SIWX for repeat access.
- `GET /joke` requires payment once, then accepts SIWX for repeat access.

Start the server:

```sh
EVM_ADDRESS=0x... FACILITATOR_URL=https://x402.org/facilitator go run .
```

You can also place these values in a local `.env` file.

Then run the matching client example:

```sh
cd ../../clients/sign-in-with-x
EVM_PRIVATE_KEY=0x... go run .
```

The `/profile` request receives a `PAYMENT-REQUIRED` response with the
`sign-in-with-x` extension. The client signs the SIWX challenge and retries with
`SIGN-IN-WITH-X`.

For `/weather` and `/joke`, the first successful x402 settlement records the
wallet for that resource. Later requests from the same wallet authenticate with
SIWX instead of paying again.
