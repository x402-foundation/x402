# Sign-In-With-X Server Example

This example runs an auth-only SIWX route at `GET /profile`.

Start the server:

```sh
go run .
```

Then run the matching client example:

```sh
cd ../../clients/sign-in-with-x
EVM_PRIVATE_KEY=0x... go run .
```

The first request receives a `PAYMENT-REQUIRED` response with the `sign-in-with-x`
extension. The client signs the SIWX challenge and retries with `SIGN-IN-WITH-X`.

Paid repeat-access routes use the same server extension. After a successful
x402 settlement, the extension's settle hook records `payer` for the resource,
and later requests from that wallet can authenticate with SIWX instead of paying
again.
