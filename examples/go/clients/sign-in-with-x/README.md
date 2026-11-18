# Sign-In-With-X Client Example

This client mirrors the TypeScript SIWX client example:

- `GET /profile` authenticates with SIWX only.
- `GET /weather` pays once, then retries with SIWX.
- `GET /joke` pays once, then retries with SIWX.
- The SIWX client hook is registered through `x402Client.RegisterExtension`.

Start the matching server example first:

```sh
cd ../../servers/sign-in-with-x
EVM_ADDRESS=0x... FACILITATOR_URL=https://x402.org/facilitator go run .
```

Then run the client:

```sh
EVM_PRIVATE_KEY=0x... go run .
```

You can also place these values in a local `.env` file.

Override the server URL with:

```sh
RESOURCE_SERVER_URL=http://localhost:4021 EVM_PRIVATE_KEY=0x... go run .
```
