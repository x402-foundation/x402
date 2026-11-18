# x402 Offer/Receipt Extension

Enables signed offers and receipts for the x402 payment protocol (v1.0).

## Overview

```
┌─────────┐                      ┌─────────────────┐                      ┌─────────────┐
│  Client │                      │ Resource Server │                      │ Facilitator │
└────┬────┘                      └────────┬────────┘                      └──────┬──────┘
     │                                    │                                      │
     │  GET /resource                     │                                      │
     │ ──────────────────────────────────►│                                      │
     │                                    │                                      │
     │  402 + PaymentRequirements         │                                      │
     │     + SignedOffer(s)               │                                      │
     │ ◄──────────────────────────────────│                                      │
     │                                    │                                      │
     │  GET /resource + Payment Header    │                                      │
     │ ──────────────────────────────────►│                                      │
     │                                    │                                      │
     │                                    │  Verify + Settle                     │
     │                                    │ ────────────────────────────────────►│
     │                                    │                                      │
     │                                    │  Settlement Response                 │
     │                                    │ ◄────────────────────────────────────│
     │                                    │                                      │
     │  200 + Resource + SignedReceipt    │                                      │
     │ ◄──────────────────────────────────│                                      │
     │                                    │                                      │
```

The **Offer** is signed by the resource server and included in the 402 response. Each `accepts[]` entry has a corresponding signed offer, proving those specific payment requirements are authentic.

The **Receipt** is signed by the resource server after successful payment and included in the success response. It proves service was delivered.

## Why Receipts?

Receipts are **portable proofs of paid service**. They enable:

- **Verified user reviews**: Like a "Verified Purchase" badge
- **Audit trails**: Cryptographic proof of service delivery
- **Dispute resolution**: Evidence that service was delivered after payment
- **Agent memory**: AI agents can prove past interactions with services

## Why Offers?

Signed offers:
- Give clients a fallback for proof of interaction if a signed receipt is not sent
- Prove the offer came from the resource server
- Prevent clients from creating their own offer and claiming it came from a server

## Installation

```bash
npm install @x402/extensions
```

## Server Usage

To enable offer/receipt signing on your resource server:

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { 
  createOfferReceiptExtension,
  createJWSOfferReceiptIssuer,
  declareOfferReceipt,
} from "@x402/extensions/offer-receipt";

// Create an issuer (JWS or EIP-712)
const issuer = createJWSOfferReceiptIssuer("did:web:api.example.com#key-1", jwsSigner);

// Register the extension
const server = new x402ResourceServer(facilitator)
  .registerExtension(createOfferReceiptExtension(issuer));

// Declare in route config
const routes = {
  "GET /api/data": {
    accepts: { payTo, scheme: "exact", price: "$0.01", network: "eip155:8453" },
    extensions: {
      ...declareOfferReceipt({ includeTxHash: false })
    }
  }
};
```

### Signature Formats

Two formats are supported:

- **JWS** - Best for server-side signing with managed keys (HSM, KMS, etc.)
- **EIP-712** - Best for wallet-based signing (MetaMask, WalletConnect, etc.)

## Client Usage

### Using wrapFetchWithPayment

The `wrapFetchWithPayment` wrapper can be used with offers and receipts by capturing offers in the `onPaymentRequired` hook and extracting the receipt from the response. Note that this approach does not control which `accepts[]` entry is selected - the client's selector/policies determine that independently.

```typescript
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { registerExactEvmScheme } from "@x402/evm/exact/client";
import { registerExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import {
  extractOffersFromPaymentRequired,
  decodeSignedOffers,
  extractReceiptFromResponse,
  type DecodedOffer,
} from "@x402/extensions/offer-receipt";

// Set up signers
const evmSigner = privateKeyToAccount(evmPrivateKey);
const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));

// Configure x402 client
const client = new x402Client();
registerExactEvmScheme(client, { signer: evmSigner });
registerExactSvmScheme(client, { signer: svmSigner });

const httpClient = new x402HTTPClient(client);

// Store offers for later matching with receipt
let capturedOffers: DecodedOffer[] = [];

// Capture offers in onPaymentRequired hook
httpClient.onPaymentRequired(async ({ paymentRequired }) => {
  const offers = extractOffersFromPaymentRequired(paymentRequired);
  capturedOffers = decodeSignedOffers(offers);
});

// Create payment-enabled fetch
const fetchWithPay = wrapFetchWithPayment(fetch, httpClient);

// Make request (payment handled automatically)
const response = await fetchWithPay(url);

// Extract receipt from response headers
const receipt = extractReceiptFromResponse(response);

// Match receipt to captured offer using receipt payload fields
// (receipt contains network, amount, etc. to identify which offer was accepted)
```

### Raw Flow

For full control over offer selection, use the raw flow. See the [Offer/Receipt Example](../../../../../examples/typescript/clients/offer-receipt/) for a complete working implementation.

The example demonstrates:
1. Making a request and receiving a 402 with signed offers
2. Extracting and decoding offers to inspect payment options
3. Selecting an offer and finding the matching `accepts[]` entry
4. Making payment and receiving a signed receipt
5. Verifying the receipt payload

### Future: wrapFetchWithPaymentExtended

We may add a `wrapFetchWithPaymentExtended` wrapper that selects payment options based on signed offers rather than the `accepts[]` array directly. This would guarantee that the selected payment option has a corresponding signed offer, which is the correct approach when attestation proofs are important.

## Using Receipts as Proofs

Signed receipts serve as cryptographic proofs of commercial transactions. These proofs can be submitted to downstream trust and reputation platforms:

- **[OMATrust](https://github.com/oma3dao/omatrust-docs)** - Decentralized reputation system for verified user reviews and service attestations
- **[PEAC Protocol](https://github.com/peacprotocol/peac)** - Payment Evidence and Attestation Chain for commercial transaction proofs

Integration libraries for these platforms will be added in future releases.

## Payload Structure

For detailed payload field definitions, see the [Extension Specification](../../../../../specs/extensions/extension-offer-and-receipt.md):
- §4.2 Offer Payload Fields
- §5.2 Receipt Payload Fields

## Security Considerations

The `extractPayload()` functions extract payloads without verifying the signature or checking signer authorization. This is by design — signer authorization requires resolving key bindings (did:web documents, attestations, etc.) which varies by deployment and is outside the scope of x402 client utilities.

For production use, downstream trust systems verify:
1. The signature is valid (EIP-712 or JWS)
2. The signing key is authorized for the resource domain

### Key-to-Domain Binding

To establish trust, bind the signing key's DID to the resource domain using:

1. **`did:web` DID Document** - Serve at `https://example.com/.well-known/did.json`
2. **DNS TXT Record** - Add a TXT record binding a DID to the domain
3. **Key Binding Attestation** - Create an attestation specifying the key's purpose and authorized domain

### Key Management

For production deployments:

- **JWS signing**: Use HSM or KMS-backed keys. The `kid` in the JWS header should be a DID URL that resolves to the public key.
- **EIP-712 signing**: The signing wallet should be the `payTo` address, or have an on-chain/off-chain authorization linking it to the service.
- **Key rotation**: Update DID documents or attestations when rotating keys. Old receipts remain valid if the key was authorized at issuance time.

## Files

| File | Description |
|------|-------------|
| [types.ts](./types.ts) | Type definitions for offers, receipts, and signers |
| [signing.ts](./signing.ts) | Signing utilities and offer/receipt creation |
| [server.ts](./server.ts) | Server extension and signer factories |
| [client.ts](./client.ts) | Client-side extraction utilities |

## Examples

- [Offer/Receipt Client Example](../../../../../examples/typescript/clients/offer-receipt/) - Complete example showing offer/receipt extraction

## Related

- [Extension Specification](../../../../../specs/extensions/extension-offer-and-receipt.md)
