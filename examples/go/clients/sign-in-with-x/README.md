# Sign-In-With-X Client Example

This client signs SIWX challenges from an x402 server before falling back to
payment.

Start the matching server example first:

```sh
cd ../../servers/sign-in-with-x
go run .
```

Then run the client:

```sh
EVM_PRIVATE_KEY=0x... go run .
```

Override the target URL with:

```sh
SERVER_URL=http://localhost:4021/profile EVM_PRIVATE_KEY=0x... go run .
```
