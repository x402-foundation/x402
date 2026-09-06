# Offer-Receipt Extension Server Example

Express.js server demonstrating the offer-receipt extension for x402. This extension adds signed offers and receipts to payment flows, enabling:

- **Signed offers** — cryptographic proof of payment terms from the server
- **Signed receipts** — proof of service delivery after payment

## Signing Formats

The server supports two signing formats:

| Format            | Key Type                   | Verification                        |
| ----------------- | -------------------------- | ----------------------------------- |
| **JWS** (default) | P-256, secp256k1, Ed25519  | Resolve `did:web` to get public key |
| **EIP-712**       | secp256k1 only             | Recover address from signature      |

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

2. Generate a signing key:

**For JWS (ES256/P-256):**
```bash
openssl ecparam -genkey -name prime256v1 -noout | openssl pkcs8 -topk8 -nocrypt | base64 | tr -d '\n'
```

**For EIP-712 (secp256k1 hex):**
```bash
openssl ecparam -genkey -name secp256k1 -noout | openssl ec -text -noout 2>/dev/null | grep -A3 'priv:' | tail -3 | tr -d ' :\n'
```

3. Configure `.env`:
   - `SIGNING_FORMAT` — `jws` or `eip712`
   - `SIGNING_PRIVATE_KEY` — Key in the appropriate format
   - `SERVER_DOMAIN` — Required for JWS (e.g., `localhost%3A4021`)
   - `FACILITATOR_URL`, `EVM_ADDRESS`, `SVM_ADDRESS`

4. Install and run:

```bash
cd ../../
pnpm install && pnpm build
cd servers/offer-receipt
pnpm dev
```

## DID Document (JWS only)

For JWS signing, the server exposes `/.well-known/did.json` for signature verification:

```bash
curl http://localhost:4021/.well-known/did.json
```

The library's `resolveDidWeb` automatically uses HTTP for `localhost` and `127.0.0.1`.

## Configuration Options

`declareOfferReceiptExtension()` accepts:

- `includeTxHash` — Include transaction hash in receipt (default: `false` for privacy)
- `offerValiditySeconds` — How long offers remain valid (default: 300)

## Related

- [Extension Specification](../../../../typescript/packages/extensions/src/offer-receipt/README.md)
- [Offer/Receipt Client Example](../../clients/offer-receipt/)
