# Facilitator Attestation Extension

**Status:** Draft
**Version:** 1.0
**Extension Key:** `facilitator-attestation`
**Placement:** `SettlementResponse.extensions["facilitator-attestation"]`

---

**1. Overview**

The Facilitator Attestation Extension adds a **facilitator-signed settlement proof** to x402 payment responses. After a successful settlement, the facilitating party signs a `SettlementAttestation` object and attaches it to the `SettlementResponse.extensions` field.

This extension is **complementary to the offer-receipt extension** (extension key `offer-receipt`). The two serve different trust roles:

| Property | offer-receipt (receipt) | facilitator-attestation |
|---|---|---|
| **Signer** | Resource server | Facilitator |
| **Signed at** | Service delivery | Settlement confirmation |
| **Includes txHash** | Optional (privacy default: false) | Always (audit requirement) |
| **Includes amount** | No | Yes |
| **Includes facilitator fee** | No | Yes |
| **Primary use case** | Proof of delivery | Audit / compliance / fee transparency |
| **Chain binding** | EIP-712 domain chainId=1 (static) | EIP-712 domain chainId = payment chain |

When both extensions are active, clients can compose a **BusinessReceipt** (§7) that provides both settlement proof and delivery proof.

**2. Motivation**

The offer-receipt extension deliberately omits amount and asset to preserve privacy and is signed by the resource server to prove delivery. This leaves a gap for actors who need:

1. **Cryptographic proof of what was paid** — amount, token, payer, payee, in a form that cannot be forged or altered by the recipient.
2. **Facilitator fee transparency** — verifiable record of what fee the facilitating party took.
3. **Audit and compliance** — structured evidence for accounting systems, tax reporting, or regulatory filings.
4. **Interoperability** — a machine-readable format compatible with emerging settlement proof standards (e.g., ERC-8183 Business Receipts).

The facilitator is the natural signer for settlement proofs because:
- The facilitator observes the on-chain transaction and can attest to its finality.
- The facilitator's signature is independent of the resource server, providing an additional trust anchor.
- Facilitators already hold signing keys for x402 operations.

**3. Signed Artifact Structure**

**3.1 Object Shape**

The `SettlementAttestation` MUST have the following structure:

```json
{
  "format": "eip712",
  "payload": { ... },
  "signature": "0x..."
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `format` | string | Yes | Always `"eip712"` for this extension |
| `payload` | object | Yes | The canonical `SettlementAttestationPayload` fields (§4) |
| `signature` | string | Yes | Hex-encoded ECDSA signature (`0x`-prefixed, 65 bytes: r+s+v) |

This extension uses EIP-712 exclusively. JWS is not supported: EVM facilitator keys are secp256k1 keys, and EIP-712 is the natural signing format for on-chain-aware parties.

**3.2 EIP-712 Domain**

```javascript
{
  name: "x402-receipt",
  version: "1",
  chainId: <payment chain ID>
}
```

**Unlike the offer-receipt extension**, the `chainId` in the EIP-712 domain is the **actual EIP-155 chain ID of the payment network** (e.g., `8453` for Base). This provides per-chain replay protection: an attestation for a Base payment cannot be presented as an Ethereum mainnet payment by tampering the `chainId` field.

**4. SettlementAttestation Payload (§4)**

**4.1 Fields**

| Field | EIP-712 Type | JSON Type | Required | Description |
|---|---|---|---|---|
| `version` | `uint256` | integer | Yes | Schema version (currently `1`) |
| `paymentId` | `bytes32` | `string` | Yes | Payment identifier (see §4.3) |
| `chainId` | `uint256` | `string` | Yes | EIP-155 chain ID of the payment network |
| `payer` | `address` | `string` | Yes | Payer wallet address (EIP-55 checksum) |
| `payee` | `address` | `string` | Yes | Payee wallet address — `PaymentRequirements.payTo` (EIP-55) |
| `token` | `string` | `string` | Yes | Token contract address (EIP-55), or `"native"` |
| `amount` | `uint256` | `string` | Yes | Settled amount in token's smallest unit (decimal string) |
| `facilitator` | `string` | `string` | Yes | Facilitator address or identifier |
| `facilitatorFee` | `uint256` | `string` | Yes | Fee taken by facilitator (decimal string; `"0"` if none) |
| `txHash` | `bytes32` | `string` | Yes | On-chain transaction hash (`0x`-prefixed 32-byte hex) |
| `settledAt` | `uint256` | `string` | Yes | Unix timestamp (seconds) of settlement confirmation |

All fields are REQUIRED. There are no optional fields — attestations must be complete to be useful for audit purposes.

**4.2 EIP-712 Typed Data**

```typescript
const ATTESTATION_TYPES = {
  SettlementAttestation: [
    { name: "version",        type: "uint256"  },
    { name: "paymentId",      type: "bytes32"  },
    { name: "chainId",        type: "uint256"  },
    { name: "payer",          type: "address"  },
    { name: "payee",          type: "address"  },
    { name: "token",          type: "string"   },
    { name: "amount",         type: "uint256"  },
    { name: "facilitator",    type: "string"   },
    { name: "facilitatorFee", type: "uint256"  },
    { name: "txHash",         type: "bytes32"  },
    { name: "settledAt",      type: "uint256"  },
  ],
};
```

**4.3 paymentId Derivation**

The `paymentId` is a `bytes32` identifier that links this attestation to the specific payment. Implementations SHOULD derive `paymentId` from the transaction hash of the on-chain settlement (normalised to 32-byte lowercase hex). A `paymentId` of all zeros (`0x000...000`) is invalid and MUST be rejected.

Future versions of this spec may define a canonical derivation method using a hash of the full payment payload for cross-chain and off-chain payment schemes.

**4.4 Serialization Rules**

Implementations MUST follow these serialization rules to ensure interoperability:

- **`uint256` values** (amount, facilitatorFee, chainId, settledAt): encoded as **decimal string** with no leading zeros and no `0x` prefix. Example: `"1000000"`.
- **`bytes32` values** (paymentId, txHash): encoded as `0x`-prefixed **lowercase hex**, 64 hex characters. Example: `"0xabcd...1234"`.
- **`address` values** (payer, payee): encoded as **EIP-55 checksum** format. Example: `"0x70997970C51812dc3A010C7d01b50e0d17dc79C8"`.
- **`string` values** (token, facilitator): `token` is either `"native"` or an EIP-55 address; `facilitator` is either an EIP-55 address or a URL/DID identifying the facilitator service.

**5. Wire Shape**

The attestation is placed at:

```
SettlementResponse.extensions["facilitator-attestation"].info.attestation
```

Full example:

```json
{
  "success": true,
  "transaction": "0xabcdef...",
  "network": "eip155:8453",
  "payer": "0x70997970...",
  "extensions": {
    "facilitator-attestation": {
      "info": {
        "attestation": {
          "format": "eip712",
          "payload": {
            "version": 1,
            "paymentId": "0xabcdef...1234",
            "chainId": "8453",
            "payer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "payee": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
            "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "amount": "1000000",
            "facilitator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            "facilitatorFee": "3000",
            "txHash": "0xabcdef...1234",
            "settledAt": "1700000000"
          },
          "signature": "0x..."
        }
      },
      "schema": { ... }
    }
  }
}
```

**6. Verification (§6)**

**6.1 Field Validation**

Before cryptographic verification, implementations MUST check:

1. `format` is `"eip712"`.
2. `version` is `1`.
3. `paymentId` matches `^0x[0-9a-fA-F]{64}$` and is not all zeros.
4. `chainId` is a parseable positive integer string.
5. `payer` and `payee` are valid EVM addresses.
6. `token` is `"native"` or a valid EVM address.
7. `amount` and `facilitatorFee` are parseable non-negative decimal integer strings.
8. `txHash` matches `^0x[0-9a-fA-F]{64}$`.
9. `settledAt` is a parseable positive integer (Unix seconds).
10. `signature` is `0x`-prefixed 65-byte hex.

**6.2 Signature Verification**

1. Construct the EIP-712 typed data using the `payload` fields and domain `{ name: "x402-receipt", version: "1", chainId: <payload.chainId> }`.
2. Recover the signer address via `ecrecover` over the EIP-712 hash.
3. If `facilitator` is a valid EVM address, verify the recovered signer equals the `facilitator` field (case-insensitive).
4. If `facilitator` is a non-address identifier (URL, DID), the verifier MUST resolve the facilitator's authorised signing key through an out-of-band mechanism and verify accordingly.

**7. BusinessReceipt Composition (§7)**

When both `offer-receipt` and `facilitator-attestation` extensions are active, clients MAY compose a **BusinessReceipt** to get a single structured record:

```typescript
interface BusinessReceipt {
  status: "COMPLETE" | "PAYMENT_ONLY" | "DELIVERY_ONLY" | "MISMATCH";
  attestation?: SignedSettlementAttestation;   // facilitator-signed
  deliveryReceipt?: SignedReceipt;             // resource-server-signed (from offer-receipt)
  paymentId?: string;
  mismatchDetails?: string[];
}
```

Composition rules:
- If only the attestation is present: `status = "PAYMENT_ONLY"`.
- If only the delivery receipt is present: `status = "DELIVERY_ONLY"`.
- If both are present and `paymentId` is consistent: `status = "COMPLETE"`.
- If both are present but `paymentId` values differ: `status = "MISMATCH"`.

**8. Server Implementation**

Facilitators register this extension with `createFacilitatorAttestationExtension()` from `@x402/extensions/facilitator-attestation`:

```typescript
import {
  createFacilitatorAttestationExtension,
  declareFacilitatorAttestationExtension,
} from "@x402/extensions/facilitator-attestation";

// Create extension (once, at startup)
const attestationExtension = createFacilitatorAttestationExtension({
  signFn: mySignTypedDataFn,         // viem account.signTypedData or ethers signer
  facilitatorAddress: "0x...",        // facilitator's signing key address
  feeFraction: 0.003,                 // 0.3% facilitator fee
});

// Register with x402ResourceServer
server.registerExtension(attestationExtension);

// Declare in route config
const routes = {
  "GET /api/data": {
    accepts: { ... },
    extensions: {
      ...declareFacilitatorAttestationExtension(),
    },
  },
};
```

**9. Security Considerations**

**9.1 Key Management**

The facilitator's signing key produces legal-weight attestations. Implementers SHOULD:
- Use HSM or KMS-backed keys, not hot wallets.
- Rotate keys periodically and publish key rotation events.
- Bind the signing key's address to the facilitator service via an on-chain or off-chain registry.

**9.2 Replay Protection**

The EIP-712 domain includes `chainId`, binding each attestation to a specific chain. An attestation for chain A cannot be replayed on chain B by modifying the `chainId` field — doing so would change the EIP-712 hash and invalidate the signature.

**9.3 Data Minimisation**

Unlike on-chain events, this attestation travels in HTTP response headers. Implementers should be aware that `payer`, `payee`, `amount`, and `txHash` are all revealed to any party that can observe the HTTP response. This is intentional for audit use cases but should be considered in privacy-sensitive deployments.

**9.4 Fee Calculation**

The `facilitatorFee` field is derived by the facilitator and is not independently verifiable from the on-chain transaction alone (fees may be taken off-chain or through a separate mechanism). Verifiers SHOULD treat `facilitatorFee` as a facilitator-attested claim, not an on-chain fact.

**10. Compatibility**

This extension:
- Does NOT modify any fields in `@x402/core`.
- Is compatible with x402 v1 and v2.
- Works alongside `offer-receipt` (the two are designed to compose into a BusinessReceipt).
- Does NOT require Solidity contracts (batch anchoring is a separate, future extension).
