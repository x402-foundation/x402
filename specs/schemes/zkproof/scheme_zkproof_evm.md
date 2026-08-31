# Scheme: `zkproof` on `EVM`

## Summary

The `zkproof` scheme on EVM chains uses zkTLS proofs to authorize access based on verifiable claims. Clients submit a serialized ZKP in the payload, which the facilitator verifies using the provider's SDK (offchain) or onchain verifier contracts. No token transfer occurs; access is granted if the proof validates the required claim. This is ideal for identity-based gating on EVM networks like Base.

**Note:** This specification uses **Reclaim Protocol as a reference implementation** for the EVM network. The scheme is designed to be compatible with multiple zkTLS providers (Primus, zkPass, Opacity, bringID, TLSN, etc.). See the [general zkproof scheme specification](./scheme_zkproof.md) for provider compatibility details.

## `X-Payment` header payload

The `payload` field of the `X-PAYMENT` header must contain the following fields (serialized as JSON from Reclaim's Proof object):

- `proof`: The zkTLS proof object, including:
  - `claimInfo`: Object with `provider` (e.g., "http"), `parameters` (JSON string of claim params), `context` (optional metadata).
  - `signedClaim`: Object with `claim` (hashed claim data including identifier, owner address, timestamp, epoch) and `signatures` (array of base64 signatures from attestors).
- `publicInputs`: Array of public signals for ZK verification (e.g., claim hash, redacted data).
- `nonce`: A unique 32-byte hex string to prevent replay attacks.
- `expiry`: Unix timestamp for proof validity.

Example payload:

```json
{
  "proof": {
    "claimInfo": {
      "provider": "http",
      "parameters": "{\"url\":\"https://example.com/api/subscription\",\"method\":\"GET\",\"responseSelections\":[{\"responseMatch\":\"active\"}]}",
      "context": "User subscription proof for x402 access"
    },
    "signedClaim": {
      "claim": {
        "identifier": "0xhashofclaim",
        "owner": "0xclientaddress",
        "timestampS": "1729440000",
        "epoch": "1"
      },
      "signatures": ["base64sig1", "base64sig2"]
    }
  },
  "publicInputs": ["claimhash", "publicsignal2"],
  "nonce": "0xrandomnonce",
  "expiry": "1732032000"
}
```

Full `X-PAYMENT` header:

```json
{
  "x402Version": 1,
  "scheme": "zkproof",
  "network": "base-mainnet",
  "payload": {
    "proof": {
      "claimInfo": {
        "provider": "http",
        "parameters": "{\"url\":\"https://example.com/api/subscription\",\"method\":\"GET\",\"responseSelections\":[{\"responseMatch\":\"active\"}]}",
        "context": "User subscription proof for x402 access"
      },
      "signedClaim": {
        "claim": {
          "identifier": "0xhashofclaim",
          "owner": "0xclientaddress",
          "timestampS": "1729440000",
          "epoch": "1"
        },
        "signatures": ["base64sig1", "base64sig2"]
      }
    },
    "publicInputs": ["claimhash", "publicsignal2"],
    "nonce": "0xrandomnonce",
    "expiry": "1732032000"
  }
}
```

Construct the payload using Reclaim's JS SDK on the client-side:

```javascript
const reclaim = new ReclaimProofRequest(APP_ID, APP_SECRET, PROVIDER_ID);
const proof = await reclaim.requestProofs(); // Generates proof after user interaction
// Serialize proof for X-PAYMENT
```

## Verification

Steps to verify a proof for the `zkproof` scheme (performed by facilitator):

1. Parse the `payload` and extract `proof`, `publicInputs`, `nonce`, `expiry`.
2. Check `expiry` is in the future and `nonce` is unused (store used nonces in DB or onchain).
3. Verify offchain using Reclaim JS SDK: `const isValid = await verifyProof(proofObject);`.
4. Match the claim against `paymentRequirements.requiredClaim` (e.g., parse `claimInfo.parameters` for response match).
5. Optionally, simulate onchain verification using the verifier contract at `paymentRequirements.verifierContract` to ensure trustlessness.
6. If all checks pass, return `isValid: true` from `/verify`.

Onchain verification example (using Reclaim's Solidity SDK):

```solidity
import { Reclaim } from "@reclaimprotocol/reclaim-solidity-sdk/contracts/Reclaim.sol";
import { Addresses } from "@reclaimprotocol/reclaim-solidity-sdk/contracts/Addresses.sol";

contract X402Verifier {
  function verifyReclaimProof(Reclaim.Proof memory proof) public view returns (bool) {
    Reclaim reclaim = Reclaim(Addresses.getAddress(block.chainid));
    reclaim.verifyProof(proof);
    return true; // Reverts if invalid
  }
}
```

Verifier addresses (from Reclaim docs/GitHub):

- Ethereum Mainnet: `0xA2bFF333d2E5468cF4dc6194EB4B5DdeFA2625C0`
- Base Mainnet: Use Reclaim's `Addresses.sol` for chain-specific address

## Settlement

Settlement is optional for `zkproof` as no funds are moved. If required (e.g., for audit or replay prevention):

1. Call the onchain verifier contract to record the proof (e.g., emit event with proof hash).
2. Return `success: true`, `txHash`, `networkId` from `/settle`.
3. Facilitator broadcasts the tx using the client's proof data.

If no settlement needed, return `success` without blockchain interaction to keep it gasless.

## Appendix

### Roadmap Context

This specification is a community proposal addressing the x402 [Identity Solution roadmap item](https://github.com/coinbase/x402/blob/main/ROADMAP.md#identity-solution-solutionsguides-first), which aims to enable KYC/eligibility signals using existing identity services without creating a new identity protocol.

### Technical Details (Reclaim Protocol Reference)

Reclaim proofs use zkSNARKs for TLS session integrity. The proof object is ~1-2KB, suitable for HTTP headers (base64 encoded). For large proofs, use compression. This reference implementation uses Reclaim's attestors for proof generation, but the scheme architecture supports other zkTLS protocols (Primus, zkPass, Opacity, bringID, TLSN, etc.) through similar verification patterns.

### Pros

- Privacy-preserving access
- No payment friction for verified users
- Flexible claim verification for various use cases
- Provider-agnostic architecture supports multiple zkTLS backends

### Cons

- Verification compute (ZK proof check) may add latency; mitigate with caching
- Requires integration with zkTLS provider infrastructure
- Different providers may have different proof formats requiring adapter patterns

### Next Steps for Integration

- **Facilitator Extension**: Update the facilitator server (e.g., Coinbase's or self-hosted) to support `zkproof` in `/supported`, and implement verification using `@reclaimprotocol/js-sdk` (or equivalent SDK for other zkTLS providers).
- **Middleware Update**: Extend `paymentMiddleware` to handle `scheme: "zkproof"` and new fields like `requiredClaim: "active-subscription"`, `verifierContract: "0xA2bFF333d2E5468cF4dc6194EB4B5DdeFA2625C0"`.
- **Client-Side**: Clients use the chosen zkTLS provider's SDK to generate proofs based on `requiredClaim`, then submit in `X-PAYMENT`. For Reclaim example: use Reclaim's JS SDK from https://dev.reclaimprotocol.org.
- **Testing**: Test on Base Sepolia with a dev app from your chosen zkTLS provider.
- **Multi-Provider Support**: Facilitators can implement adapter patterns to support multiple zkTLS providers, allowing resource servers to specify preferred providers in `paymentRequirements.extra.acceptedProviders`.

