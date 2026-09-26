# Facilitator Attestation Extension

**Status:** Draft
**Version:** 1.0 (draft revision 2 — see [Changelog](#changelog))
**Extension Key:** `facilitator-attestation`
**Placement:** `SettlementResponse.extensions["facilitator-attestation"]`

---

**1. Overview**

The Facilitator Attestation Extension adds a **facilitator-signed settlement attestation** to x402 payment responses. After a successful settlement, the facilitator that settled the payment signs a `SettlementAttestation` object and attaches it to the `SettlementResponse.extensions` field.

This extension is **complementary to the offer-and-receipt extension** (extension key `offer-receipt`) and deliberately kept separate from it: the two have a different signer, a different claim, and a different privacy surface.

| Property | offer-and-receipt (receipt) | facilitator-attestation |
|---|---|---|
| **Signer** | Resource server | Facilitator that settled the payment |
| **Signed at** | Service delivery | After settlement is observed |
| **Includes `transaction`** | Optional (privacy default: omitted) | Always |
| **Includes amount** | No | Yes |
| **Includes facilitator fee** | No | Yes |
| **Primary use case** | Proof of delivery | Audit / compliance / fee transparency |
| **Network binding** | `network` (CAIP-2) in payload; EIP-712 domain `chainId: 1` | Same |

When both extensions are active, clients can compose a **BusinessReceipt** (§7).

**2. Motivation**

The offer-and-receipt extension deliberately omits amount and asset to preserve privacy and is signed by the resource server to prove delivery. This leaves a gap for actors who need:

1. **A signed record of what was paid** — amount, asset, payer, payee — issued by the party that settled it, in a form the recipient cannot alter.
2. **Facilitator fee transparency** — a signed record of what fee the facilitator took.
3. **Audit and compliance** — structured evidence for accounting systems, tax reporting, or regulatory filings.

The facilitator is the natural signer because it is the party that submitted the settlement and observed its result, and its signature is independent of the resource server.

**2.1 What the Attestation Claims: Attribution, Not Assertion**

A `SettlementAttestation` **attributes** a settlement to a payer, payee, asset and amount. It does **not** establish that the settlement occurred. Whether value moved is a fact of the settlement network, not of this signature.

Consumers that act on an attestation MUST either run the settlement check in §6.3 or already hold independent evidence that the value arrived (for example, a contract that can observe its own balance). Under this rule a facilitator that signs a false attestation can misattribute a settlement that exists, but cannot make a consumer credit one that does not.

This is the same boundary offer-and-receipt draws for delivery — a receipt is proof of emission, not proof of validity — applied to settlement.

**2.2 Scope**

This object is a **facilitator self-report**: the `facilitator` field always means "the party that settled this payment". The following are different artifacts, with different signers or different claims, and are out of scope here:

- **Independent re-derivation** — a third party that is neither facilitator nor seller re-derives the transfer from the chain before signing. Different signer role; composable with this object, not a mode of it.
- **Authorization checks** — attesting that a payer's authorization is genuine and its terms match the offer. Different claim ("the payer authorized these terms", not "this settlement happened"), made before settlement.
- **Contract-verifiable artifacts** — objects designed to be verified on-chain with no external resolution. A contract cannot run §6; such an artifact needs a minimal signed core and on-chain semantics of its own, and MAY reference a `SettlementAttestation`.

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
| `payload` | object | Yes | The canonical `SettlementAttestation` payload fields (§4) |
| `signature` | string | Yes | Hex-encoded ECDSA signature (`0x`-prefixed, 65 bytes: r+s+v) |

This extension uses EIP-712. The facilitator's attestation key is a secp256k1 key regardless of the network the payment settled on; see §11 for non-secp256k1 facilitators.

**3.2 EIP-712 Domain**

```javascript
{
  name: "x402 receipt",
  version: "1",
  chainId: 1
}
```

The domain is identical to the one offer-and-receipt uses for receipts. `chainId` is fixed to `1` because EIP-712 is used here purely as an off-chain signing format, and a settlement network may have no EIP-155 chain ID at all (Hedera, Cardano, Lightning). The settlement network is identified by the signed `network` field in the payload.

The primary type is `SettlementAttestation`, distinct from offer-and-receipt's `Receipt`, so the two artifacts have different type hashes under the shared domain and a signature over one can never verify as the other.

**4. SettlementAttestation Payload**

**4.1 Fields**

| Field | EIP-712 Type | JSON Type | Required | Description |
|---|---|---|---|---|
| `version` | `uint256` | integer | Yes | Payload schema version (currently `1`) |
| `network` | `string` | string | Yes | Settlement network, CAIP-2 (e.g. `"eip155:8453"`), as in `SettlementResponse.network` |
| `transaction` | `string` | string | Yes | Settlement identifier, as in `SettlementResponse.transaction` (§4.2) |
| `payer` | `string` | string | Yes | The account whose funds moved, as defined by the binding (§4.3) |
| `payee` | `string` | string | Yes | `PaymentRequirements.payTo` |
| `asset` | `string` | string | Yes | `PaymentRequirements.asset`, verbatim |
| `amount` | `uint256` | string | Yes | Settled amount in the asset's smallest unit (decimal string) |
| `facilitator` | `string` | string | Yes | Identifier of the facilitator that settled the payment (§6.2) |
| `facilitatorFee` | `uint256` | string | Yes | Fee taken by the facilitator (decimal string; `"0"` if none) |
| `observedAt` | `uint256` | string | Yes | Unix timestamp (seconds) at which the facilitator observed the settlement |

All fields are REQUIRED. There are no optional fields — attestations must be complete to be useful for audit purposes.

`observedAt` is the facilitator's statement about when it observed the settlement, not a claim about the settlement's own timestamp; consumers that need the latter read it from the network.

**4.2 Settlement Identifier**

`transaction` is the settlement identifier the core specification returns in `SettlementResponse.transaction`, in the binding's native format (e.g. a `0x`-prefixed hash on EVM networks). The attestation refers to the settlement identifier itself, under this name, regardless of the field name an individual binding uses for it.

The pair **`(network, transaction)`** identifies the settlement. It is the uniqueness key of this extension (§4.4) and the join key for BusinessReceipt composition (§7).

**4.3 Payer**

`payer` MUST be the account whose funds moved in the settlement, as defined by the binding and its asset transfer method. It MUST NOT be copied from `SettlementResponse.payer` unless the binding defines that field with the same meaning for the method used.

This matters because `SettlementResponse.payer` does not mean the same thing everywhere — not even within one binding. On Hedera `exact` with the default `cryptoTransfer` method, it is defined as "the Hedera account ID of the fee payer that sponsored the transaction", which is typically the facilitator's own account; with `transferExecutor`, it is "the account debited `amount`". An attestation that copied the field would name the facilitator as the payer on every default-method Hedera payment, and every such attestation would be well formed.

| Binding / method | `payer` is |
|---|---|
| EVM `exact` | The address whose token balance was debited |
| Hedera `exact`, `cryptoTransfer` | The account whose asset balance was debited — **not** `SettlementResponse.payer` / `extra.feePayer` |
| Hedera `exact`, `transferExecutor` | The account debited `amount` (here equal to `SettlementResponse.payer`) |
| Other bindings | As defined by that binding. A facilitator MUST NOT emit an attestation for a binding or method that has no definition of the funding account. |

**4.4 Uniqueness**

A facilitator MUST NOT emit more than one `SettlementAttestation` per `(network, transaction)`.

Two validly signed attestations from the same facilitator for the same `(network, transaction)` with different payloads are **equivocation**. Consumers MUST reject both and SHOULD retain them: together they are signed evidence of facilitator misbehavior.

An attestation is a statement, not a bearer instrument. Consumers that release value against an attestation (refunds, credits) MUST record each `(network, transaction)` they have acted on and refuse to act on it again; that single-use enforcement is the consumer's state, not a property of the signature.

**4.5 Serialization Rules**

- **`uint256` values** (`amount`, `facilitatorFee`, `observedAt`): decimal string with no leading zeros and no `0x` prefix. Example: `"1000000"`. `version` is a JSON integer.
- **`network`**: CAIP-2 string exactly as in `SettlementResponse.network`.
- **`transaction`**, **`payer`**, **`payee`**, **`asset`**: the binding's canonical string form, byte-for-byte as the binding defines it (e.g. EIP-55 checksum addresses and lowercase `0x`-prefixed hashes on EVM networks; `0.0.N` account IDs on Hedera).
- **`facilitator`**: an EIP-55 address, or a URL/DID identifying the facilitator service.

**4.6 EIP-712 Types (Normative Schema)**

```javascript
{
  "primaryType": "SettlementAttestation",
  "types": {
    "EIP712Domain": [
      { "name": "name",    "type": "string"  },
      { "name": "version", "type": "string"  },
      { "name": "chainId", "type": "uint256" }
    ],
    "SettlementAttestation": [
      { "name": "version",        "type": "uint256" },
      { "name": "network",        "type": "string"  },
      { "name": "transaction",    "type": "string"  },
      { "name": "payer",          "type": "string"  },
      { "name": "payee",          "type": "string"  },
      { "name": "asset",          "type": "string"  },
      { "name": "amount",         "type": "uint256" },
      { "name": "facilitator",    "type": "string"  },
      { "name": "facilitatorFee", "type": "uint256" },
      { "name": "observedAt",     "type": "uint256" }
    ]
  }
}
```

As in offer-and-receipt, these definitions are used for signing and verification and MUST NOT be transmitted on the wire. Any change to them is a breaking change and MUST be accompanied by a domain `version` bump.

**5. Wire Shape**

The attestation is placed at:

```
SettlementResponse.extensions["facilitator-attestation"].info.attestation
```

Full example (EVM):

```json
{
  "success": true,
  "transaction": "0xabcdef...1234",
  "network": "eip155:8453",
  "payer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  "extensions": {
    "facilitator-attestation": {
      "info": {
        "attestation": {
          "format": "eip712",
          "payload": {
            "version": 1,
            "network": "eip155:8453",
            "transaction": "0xabcdef...1234",
            "payer": "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
            "payee": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
            "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            "amount": "1000000",
            "facilitator": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            "facilitatorFee": "3000",
            "observedAt": "1700000000"
          },
          "signature": "0x..."
        }
      },
      "schema": { ... }
    }
  }
}
```

On Hedera with the default `cryptoTransfer` method, the same payload carries `"network": "hedera:mainnet"`, the settlement identifier in `transaction` (the binding returns it as `transactionId`), and in `payer` the account whose funds moved — which differs from the top-level `SettlementResponse.payer` (the fee payer).

**6. Verification**

**6.1 Field Validation**

Before cryptographic verification, implementations MUST check:

1. `format` is `"eip712"`.
2. `version` is `1`.
3. `network` is a syntactically valid CAIP-2 identifier.
4. `transaction`, `payer`, `payee` and `asset` are non-empty and well formed for the binding identified by `network`.
5. `amount` and `facilitatorFee` are parseable non-negative decimal integer strings.
6. `observedAt` is a parseable positive integer (Unix seconds).
7. `signature` is `0x`-prefixed 65-byte hex.

**6.2 Signature Verification**

1. Construct the EIP-712 typed data from `payload`, the domain in §3.2 and the types in §4.6.
2. Recover the signer address via `ecrecover` over the EIP-712 hash.
3. If `facilitator` is an EVM address, verify the recovered signer equals it (case-insensitive).
4. If `facilitator` is a URL or DID, the verifier MUST resolve the facilitator's authorized signing key out of band and confirm the recovered signer is that key.

As in offer-and-receipt §4.5.1, a valid signature proves that a key signed the attestation; it does not prove the key is authorized to speak for the facilitator named. Verifiers MUST establish that authorization separately.

**6.3 Settlement Check**

A consumer that did not already observe the value arriving (§2.1) MUST look up `(network, transaction)` on the settlement network and compare the settlement against the attested `payer`, `payee`, `asset` and `amount`. The check has **three** outcomes, and they MUST be kept distinct:

| Outcome | Meaning | Consumer action |
|---|---|---|
| `NOT_FOUND` | No settlement identified by `(network, transaction)` at the depth the consumer requires | MUST NOT treat as verified. MAY retry: the settlement can be pending or reorganized. Not, by itself, evidence of misbehavior. |
| `MATCH` | Found, and every compared field matches | Verified, within the limits of §2.1. |
| `MISMATCH` | Found, but at least one compared field differs | MUST reject. A validly signed attestation that contradicts the settlement it names is evidence of facilitator error or misbehavior; consumers SHOULD retain it. |

`payer` MUST be compared against the binding's funding account (§4.3), never against "any party to the transaction". On Hedera the facilitator is genuinely a party to every transaction it sponsors, so a membership check would classify a facilitator-as-payer attestation as `MATCH` when it is a `MISMATCH`.

`facilitatorFee` is not part of this check (§9.3).

**7. BusinessReceipt Composition**

When both `offer-receipt` and `facilitator-attestation` are active, clients MAY compose a **BusinessReceipt**:

```typescript
interface BusinessReceipt {
  status: "COMPLETE" | "UNLINKED" | "PAYMENT_ONLY" | "DELIVERY_ONLY" | "MISMATCH";
  attestation?: SignedSettlementAttestation;   // facilitator-signed
  deliveryReceipt?: SignedReceipt;             // resource-server-signed (offer-and-receipt)
  network?: string;
  transaction?: string;
  mismatchDetails?: string[];
}
```

The join key is `(network, transaction)`. The offer-and-receipt receipt omits `transaction` by default for privacy, so composition distinguishes a receipt that can be joined from one that cannot:

- Only the attestation is present: `PAYMENT_ONLY`.
- Only the receipt is present: `DELIVERY_ONLY`.
- Both present, the receipt carries `transaction`, and `(network, transaction)` is equal in both: `COMPLETE`.
- Both present, the receipt carries `transaction`, and `(network, transaction)` differs: `MISMATCH`.
- Both present, but the receipt omits `transaction`: `UNLINKED`. The two artifacts arrived together but nothing signed ties them to the same settlement.

`payer` is not part of the join: a resource server may populate the receipt's `payer` from `SettlementResponse.payer`, which on some bindings is the fee payer (§4.3).

The `payment-identifier` extension MAY be used to correlate artifacts at the application level. It is chosen by the client, so it MUST NOT be used as the join key for `COMPLETE` or as a substitute for §4.4 uniqueness.

**8. Facilitator Implementation**

The attestation is produced on the facilitator side, through the `enrichSettleResponse` hook of `FacilitatorExtension`. The hook runs after a successful settlement; its return value is placed at `SettleResponse.extensions[key]`, and an error thrown by it is logged and never fails the settlement.

Illustrative sketch (non-normative):

```typescript
const facilitatorAttestation: FacilitatorExtension = {
  key: "facilitator-attestation",
  async enrichSettleResponse(ctx) {
    const payload = buildAttestationPayload(ctx); // §4; payer per §4.3, never copied blindly
    const signature = await signTypedData({ domain, types, primaryType: "SettlementAttestation", message: payload });
    return { info: { attestation: { format: "eip712", payload, signature } } };
  },
};

facilitator.registerExtension(facilitatorAttestation);
```

A facilitator that cannot determine the funding account for a binding (§4.3) MUST return `undefined` from the hook, which omits the key, rather than emit an attestation with a guessed `payer`.

**9. Security Considerations**

**9.1 Key Management**

Implementers SHOULD use HSM- or KMS-backed keys rather than hot wallets, rotate keys periodically and publish rotation events, and bind the attestation key to the facilitator service through an on-chain or off-chain registry.

**9.2 Replay and Equivocation**

The settlement network is part of the signed payload, so an attestation for one network cannot be re-presented as one for another without invalidating the signature. Within a network, uniqueness is `(network, transaction)` (§4.4); re-presenting the same attestation is harmless to a consumer that enforces single use, and conflicting attestations for the same pair are equivocation.

**9.3 Fee Calculation**

`facilitatorFee` is derived by the facilitator and is not independently verifiable from the settlement alone (fees may be taken off-chain or through a separate mechanism). Verifiers SHOULD treat it as a facilitator-attributed claim, not a settlement fact.

**9.4 Data Minimisation**

This attestation travels in HTTP response headers. `payer`, `payee`, `amount` and `transaction` are revealed to any party that can observe the response. This is intentional for audit use cases but should be considered in privacy-sensitive deployments.

**10. Compatibility**

This extension:
- Adds the `enrichSettleResponse` hook to `FacilitatorExtension` and does not change existing core fields.
- Shares the EIP-712 domain of offer-and-receipt receipts, with a distinct primary type.
- Is network-agnostic at the payload level; bindings participate once they define the funding account (§4.3).
- Does NOT require Solidity contracts (batch anchoring is a separate, future extension).

**11. Open Questions**

1. **Non-secp256k1 facilitators.** A facilitator whose operational keys are Ed25519 (common on Hedera and Cardano) must hold a separate secp256k1 key to use this extension. offer-and-receipt also supports JWS; whether this extension should is open.
2. **Facilitator key authorization.** §6.2 requires it but, like offer-and-receipt, does not mandate a mechanism.
3. **Funding-account definitions** for bindings other than EVM and Hedera `exact`.

---

**Changelog**

**Draft revision 2** — folds in corrections from review on [#1802](https://github.com/x402-foundation/x402/issues/1802):

- `paymentId` and `chainId` replaced by `(network, transaction)`, with uniqueness restated around the pair (§4.2, §4.4). There is no EIP-3009 nonce on non-EVM bindings, and the attestation now refers to the core settlement identifier rather than a binding-specific field name. — raised by @levalleux-ludo
- `payer` defined per binding as the account whose funds moved, never copied from `SettlementResponse.payer` (§4.3). — raised by @levalleux-ludo
- Attribution-not-assertion stated as a principle (§2.1). — raised by @levalleux-ludo
- Settlement check with three outcomes, `NOT_FOUND` / `MATCH` / `MISMATCH` (§6.3). — raised by @cv-scvd
- Scope stated explicitly: facilitator self-report only; re-derivation, authorization and contract-verifiable artifacts are separate (§2.2). — from discussion with @johnInarti, @cv-scvd, @Ensi81 and @levalleux-ludo
- Distinct primary type under a shared domain (§3.2). — suggested by @jithinraj

Consequential changes:

- EIP-712 domain aligned with offer-and-receipt: `name: "x402 receipt"`, `chainId: 1`. The previous name, `"x402-receipt"`, did not actually match the offer-and-receipt domain, and a payment-chain `chainId` cannot be set for networks without an EIP-155 chain ID (§3.2).
- Address-typed fields changed to strings; `token` renamed `asset` to match `PaymentRequirements` (§4.1).
- `settledAt` renamed `observedAt`, consistent with §2.1 (§4.1).
- BusinessReceipt gains `UNLINKED`, because offer-and-receipt receipts omit `transaction` by default (§7).
- §8 rewritten around `FacilitatorExtension.enrichSettleResponse`; the previous version showed resource-server registration and a package not included in this PR.
- "Legal-weight" wording removed from §9.1; the claim that the facilitator "can attest to its finality" removed from §2.
