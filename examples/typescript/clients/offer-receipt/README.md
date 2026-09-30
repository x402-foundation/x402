# Offer/Receipt Client Example

Demonstrates how clients extract and verify signed offers and receipts from x402 payment flows.

For background on why receipts matter, payload structure, and security considerations, see the [Offer/Receipt Extension README](../../../../typescript/packages/extensions/src/offer-receipt/README.md).

## Use Cases for Signed Receipts/Offers

- Verified user reviews ("Verified Purchase" badges)
- Audit trails and compliance records
- Dispute resolution evidence
- Agent memory (AI agents proving past interactions)

## Quick Start

1. Install dependencies from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/offer-receipt
```

2. Copy `.env-local` to `.env` and configure:

```bash
cp .env-local .env
```

Required environment variables:
- `EVM_PRIVATE_KEY` - Private key for EVM payments
- `SVM_PRIVATE_KEY` - Private key for Solana payments (base58)
- `RESOURCE_SERVER_URL` - Server URL (default: `http://localhost:4021`)
- `ENDPOINT_PATH` - Endpoint path (default: `/weather`)

3. Run the example:

```bash
pnpm start
```

## What This Example Shows

The example uses the raw flow (not the wrapper) for visibility into each step:

1. Make initial request → receive 402 with signed offers
2. Extract and decode offers to inspect payment options
3. Verify offer signatures and select a verified offer
4. Find matching `accepts[]` entry for selected offer
5. Create payment and retry the request
6. Extract signed receipt from success response
7. Verify receipt signature
8. Verify receipt payload matches the offer

See [index.ts](./index.ts) for the full implementation with detailed comments.

## Signature Verification

The extraction functions (`extractReceiptPayload`, `extractOfferPayload`) decode payloads without verifying signatures. To verify that offers and receipts are authentic, use the verification functions from `@x402/extensions/offer-receipt`:

- `verifyOfferSignatureJWS` / `verifyReceiptSignatureJWS` - For JWS signatures
- `verifyOfferSignatureEIP712` / `verifyReceiptSignatureEIP712` - For EIP-712 signatures

See [index.ts](./index.ts) for usage examples.

### Supported Key Types (JWS)

- **Ed25519** - EdDSA signatures
- **secp256k1** - ES256K signatures (Ethereum-compatible)
- **secp256r1** - ES256 signatures (NIST P-256)

### Supported DID Methods (JWS)

The `kid` header identifies the signing key. These DID methods support automatic key extraction:

| Method     | Description                              | Example                          |
|------------|------------------------------------------|----------------------------------|
| `did:key`  | Self-contained key in the DID            | `did:key:z6Mk...`                |
| `did:jwk`  | Base64url-encoded JWK                    | `did:jwk:eyJrdH...`              |
| `did:web`  | Fetches key from `.well-known/did.json`  | `did:web:api.example.com#key-1`  |

For other DID methods, provide the public key explicitly to the verification function.

### EIP-712 Verification

EIP-712 signatures don't use DIDs - the signer address is recovered directly from the signature.

## Key-to-Domain Binding

Signature verification proves the offer/receipt was signed by a specific key. To fully trust it, verify the key is authorized to sign for the resource's domain via:

- `did:web` document at `https://<domain>/.well-known/did.json`
- DNS TXT record binding the DID to the domain
- On-chain attestation (e.g., OMATrust key binding attestation)

See: [Extension Specification §4.5.1](../../../../specs/extensions/extension-offer-and-receipt.md)

## Security Considerations

1. **Private Key Management**: Loading private keys from environment variables is for demonstration only. In production, use secure key management (HSM, KMS, hardware wallets).

2. **Key Separation**: The payment signing key SHOULD be different from keys controlling wallets with significant funds.

3. **Key-to-Domain Binding** (for servers): See [Extension Specification §4.5.1](../../../../specs/extensions/extension-offer-and-receipt.md)

## Related

- [Offer/Receipt Extension](../../../../typescript/packages/extensions/src/offer-receipt/) - Types, signing utilities, client functions
- [Extension Specification](../../../../specs/extensions/extension-offer-and-receipt.md) - Full protocol spec
