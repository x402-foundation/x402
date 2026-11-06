# Buyer Delivery Claim Extension

**1. Summary**

After an x402 settlement completes, there is currently no standard way for the **paying** party to record, in a portable and independently verifiable form, whether what was promised actually arrived. The [Offer and Receipt Extension](https://github.com/x402-foundation/x402/blob/main/specs/extensions/extension-offer-and-receipt.md) covers the seller's side of this (a signed commitment to terms, and a signed receipt confirming payment was received). This proposal covers the complementary buyer's side: a signed, factual statement of delivery outcome that a *different* buyer, on a *different* installation, can pull before doing business with the same seller.

This is a reference implementation, not a hypothetical: `capacity-attest` (MIT, npm `capacity-attest`, MCP registry `io.github.holistis/capacity-attest`) has implemented this claim format since 2026-08, with an append-only local ledger, a completeness-detection mechanism, and a live cross-installation discovery path over EAS attestations, demonstrated on three independent chains (Base, Optimism, and Ethereum mainnet).

**2. Status, Scope, and Relationship to Other Work**

This extension is optional and composable. It does not modify payment execution, verification, or settlement semantics. It defines a signed artifact format and a set of verification rules; it does not mandate where or how that artifact is published.

It is deliberately narrow in scope: it covers exactly one thing, the paying party's own factual record of delivery outcome. It does not attempt to specify:

- proof that the underlying work was executed (see the settlement-anchor / execution-receipt work discussed in [issue #3379](https://github.com/x402-foundation/x402/issues/3379)),
- sealed proof of delivered content (see [PR #3377, durable-evidence](https://github.com/x402-foundation/x402/pull/3377)),
- who has authority to decide the next state of a dispute (see [PR #3291, resolution-lineage](https://github.com/x402-foundation/x402/pull/3291)).

Those are genuinely different questions, being worked on by other people in parallel. This proposal does not attempt to unify them into one scheme; it is scoped to what this package actually implements, following the same pattern as the existing Offer and Receipt Extension. It is written to compose with that extension and with the proposals above, not to replace or arbitrate between them.

**3. Design Principles**

- **The buyer signs, not the seller.** A seller attesting "I delivered" is close to worthless as a signal. The party that can actually observe the outcome is the one that paid.
- **A claim is a fact, never a score.** `delivered: yes | no | partial` plus an evidence hash. No aggregate rating, no ranking, no weighting of one claim over another. `get_delivery_history` returns the raw chronological list; summarizing it into a single number is a judgment this format deliberately does not make.
- **No trusted index required.** Every claim is self-verifying: `claimId` is a content hash of the claim, and `signature` recovers to `buyerAddress`. A claim can therefore be published anywhere, gathered from anywhere, and independently re-verified by anyone, without needing to trust the party that stored or forwarded it.
- **Citations, not verified facts.** Fields that reference something outside this format (a settlement, external evidence, an agent identity, a dispute protocol) are unverified pointers. This format states what the buyer asserts; it does not itself resolve, verify, or adjudicate those references.

**4. Claim Structure**

A claim's content fields, all of which are covered by `claimId` and `signature`:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `sellerAddress` | string | Yes | 0x-prefixed 20-byte address of the party that was paid |
| `buyerAddress` | string | Yes | 0x-prefixed 20-byte address of the paying party; MUST match the address recovered from `signature` |
| `assetType` | string | Yes | One of `gpu-hours`, `storage`, `api-credits`, `bandwidth` |
| `promisedSpec` | string or object | Yes | What the seller promised to deliver, free text or a structured object |
| `delivered` | string | Yes | One of `yes`, `no`, `partial` |
| `evidenceHash` | string | Yes | sha256 hex digest of supporting evidence (logs, response payload); the evidence itself is not part of the claim |
| `settlementRef` | string | Yes | The x402 payment reference or on-chain transaction hash for the settlement this claim is about |
| `timestamp` | string | Yes | ISO-8601 timestamp of when the claim was made |
| `measured` | object | Optional | Quantitative record: `unit`, `basis` (`supplied`\|`consumed`), `promisedAmount`, `deliveredAmount`, `period.start`/`period.end`, `method.attribution`, `method.instrument` |
| `externalRefs` | object | Optional | Unverified pointers into external identity/authority/dispute systems (e.g. an ERC-8004 agent id, an AP2 mandate, an LCP dispute context) |
| `priorClaimId` | string | Optional | The `claimId` of this same buyer's immediately previous claim about this same seller; forms a per-buyer, per-seller signed chain |

`timestamp` MUST be UTC, millisecond precision, with a trailing `Z` (`YYYY-MM-DDTHH:mm:ss.sssZ`), matching the worked example in §9. `get_delivery_history` returns claims in the order this field sorts; a looser format admits mixed precisions and offsets that sort inconsistently, silently reordering the history the whole signal in §3 rests on.

`measured` and `externalRefs` do not yet have a worked example anywhere in the reference implementation's public fixture output (golden vectors, completeness fixture, or the live on-chain examples in §9); both are spec-only today, honestly flagged rather than left for a reader to discover.

Full field-level rules (canonical decimal/timestamp formats, size bounds, and the exact canonicalization procedure) are in the reference implementation's `schema.ts` and are summarized in §9.

**5. Computing the Claim Identifier and Signature**

```text
claimId  = "0x" + sha256( canonicalize(content) )
signature = EIP-191 personal_sign(claimId) by the buyer's key
```

`canonicalize()` is deterministic JSON serialization with object keys sorted recursively (array order is preserved). `content` is every field in §4 except `claimId` and `signature` themselves. `sellerAddress` and `buyerAddress` MUST be lowercased before serialization. Without this rule, the same claim content with a checksummed (EIP-55 mixed-case) address versus a lowercased one produces two different `claimId` values from two implementations that both believe they are compliant, and a signature over one does not recover to the other.

`personal_sign` in §5's formula signs the ASCII string form of `claimId`, the `0x`-prefixed, 66-character lowercase hex string, not the 32 raw digest bytes. Both readings are reasonable from the formula alone and they produce different, mutually non-verifying signatures over the same underlying digest, so this is stated explicitly rather than left to an implementer's choice of signing library default.

This intentionally uses plain EIP-191 `personal_sign`, not EIP-712 typed data, to keep the signing surface small. A later EIP-712 upgrade (mirroring the pattern in the Offer and Receipt Extension, §3.2 of that document) is possible additively without invalidating existing claims, since the claim identifier is a content hash, not a signature-scheme-specific construct.

**6. Relationship to x402 Settlement**

`settlementRef` is a free-text pointer to an already-completed settlement; this format does not verify it against a facilitator, a chain, or the `SettlementResponse` that produced it. This is a known, explicitly documented limitation, not an oversight (see §8).

One concrete, incremental strengthening this proposal does make: x402's own `SettlementResponse` (as used by the Offer and Receipt Extension, §5.2) already carries a `payer` field. Where the underlying settlement is inspectable, a verifier MUST confirm that `claim.buyerAddress` matches the `payer` of the settlement named by `settlementRef`, in addition to the claim's own signature check. An optional check here is skippable by construction, and skipping it is exactly the gap an attacker would use. This binds the claim to the correct *paying party* for a real settlement. It does **not** bind the claim to a specific *unit of work* (that is the problem the settlement-anchor discussion in #3379 is solving from the seller/execution side), and it does **not** give a false `delivered: no` or `delivered: yes` any cost, which remains open (§8).

`settlementRef` resolves differently depending on which of its two forms (§4: an x402 payment reference, or an on-chain transaction hash) is used, and the two forms do not carry the same guarantee. The transaction-hash branch is well-defined for a direct payer-to-seller transfer, but for a settlement routed through a sponsor, paymaster, or router contract, the transaction's `from` is the relayer, not the buyer, so a naive lookup of `payer` from the transaction itself fails a legitimate claim. This MUST is therefore scoped to whichever branch and settlement shape actually exposes a `payer` distinct from the transaction sender; a settlement where that is not resolvable is not covered by this check and is treated per §8, not silently passed or silently failed.

**7. Publishing and Discovery**

This format does not mandate a publication substrate. A claim is valid wherever it is found, provided it verifies. The reference implementation supports:

- a local, append-only ledger (`get_delivery_history`, scoped to one installation),
- cross-installation discovery by aggregating claims from any number of untrusted sources, re-verifying every claim regardless of source, and de-duplicating by `claimId` (`discoverDeliveryHistory`),
- publication as [EAS](https://attest.org) attestations, demonstrated live on three independent chains, Base, Optimism, and Ethereum mainnet (see the live examples in §9). The substrate is not tied to any one chain: contract addresses are a parameter, not a constant, so the same claim format and the same discovery path work against any EAS deployment,
- optional mirroring into the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Reputation Registry's `giveFeedback()`, with the claim's own `delivered` value mapped mechanically to the registry's `value` field (`yes`=1.0, `partial`=0.5, `no`=0.0), a literal mirror of what the buyer already signed, never a new score computed by this format.

**8. Known Limitations**

Stated plainly, because a claimed limitation that is actually tested is worth more than a claim of completeness that is not.

- **No cost to a false claim.** A buyer can sign an untrue `delivered: no` or `delivered: yes` claim at zero cost. Nine independently designed mitigations (active settlement verification, economic bonds, time-locked maturation, third-party staked capital, and others) were each tested against the reference implementation and killed, for one of two structural reasons: the check was optional and therefore skippable, or it required ranking one claim above another, which this format deliberately refuses to do (§3). Full writeup, including all nine designs and why each failed: [tokenizen.nl/en/notes/nine-ways-to-fake-a-delivery-claim](https://tokenizen.nl/en/notes/nine-ways-to-fake-a-delivery-claim). This remains open.
- **Completeness, not just findability.** A source that omits some of a seller's claims cannot be forced to reveal them. `priorClaimId` chaining (§4) detects a hidden *middle* claim in an otherwise-visible chain; it does not detect a hidden most-recent claim or an entirely hidden buyer. See §10 for how a broken or forked chain is reported.
- **`settlementRef` is not cryptographically bound to the claim's other fields.** See §6.
- **The §6 payer-match MUST does not cover every settlement shape.** It depends on a resolution path that exists for a direct payer-to-seller transaction but not for one routed through a sponsor, paymaster, or router contract. See §6.

**9. Example**

```json
{
  "sellerAddress": "0x19e7e376e7c213b7e7e7e46cc70a5dd086daff2a",
  "buyerAddress": "0x1563915e194d8cfba1943570603f7606a3115508",
  "assetType": "gpu-hours",
  "promisedSpec": "8x H100, 2 hours, us-east",
  "delivered": "partial",
  "evidenceHash": "3a7bd3e2360a3d29eea436fcfb7e44370a48d1a5f4c34a3e60c0b4b2c0f5c7f1",
  "settlementRef": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "timestamp": "2026-09-28T10:15:00.000Z",
  "claimId": "0x4f6c...",
  "signature": "0x1234567890abcdef..."
}
```

`sellerAddress` and `buyerAddress` above are valid 20-byte addresses (40 hex characters), already lowercased per §5, derived from the trivial test private keys `0x11..11` and `0x22..22` respectively so anyone can regenerate and check them; they are not real wallets and hold nothing.

Live, on-chain examples (EAS attestations, decodable by anyone without this project's code), on three independent chains:

| Chain | Chain ID | Example | EAS contract |
|---|---|---|---|
| Base | 8453 | [delivered=yes](https://base.easscan.org/attestation/view/0x81a55d54452b2cf8bdda7918f63a27bf9ff79e5025b485f7316aae6259288ccc) · [delivered=no](https://base.easscan.org/attestation/view/0xe736b005cbcb54f8f196ac64ef09d75d939c8a18c0d5d9670b5c5025c07398c4) | `0x4200000000000000000000000000000000000021` |
| Optimism | 10 | [delivered=yes](https://optimism.easscan.org/attestation/view/0x46148283cb005aa43387fb62b2e1ccd0b001ff82dc9310ea885237fd8dea8832) | `0x4200000000000000000000000000000000000021` |
| Ethereum | 1 | [delivered=yes](https://easscan.org/attestation/view/0x40da382231eeb6186b7daf231a430488627769feb64039ae3ac671a14f7a8137) | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` |

Base and Optimism share the same EAS address because both are OP-Stack chains where EAS is a predeploy. Ethereum mainnet is not, so its address differs. The schema UID is identical on all three (`0x1dd19408345dee43b432b89ccb68760265ecff506098b6efe8ba82ad0d52b195`), since it is derived deterministically from the schema string, not assigned per chain.

**9.1 Decoding the on-chain examples, without this project's code**

Each attestation's `data` field is ABI-encoded per the EAS schema `bytes32 claimId,string claim`, where `claim` is the full claim object above as a JSON string. To decode with only a generic EVM library:

1. Read the attestation's raw `data` bytes. On easscan.org, open any attestation link above and use "Decoded Data", or call EAS's `getAttestation(uid)` directly against that chain's EAS contract (addresses in the table above, they differ between Ethereum mainnet and the OP-Stack chains) and read the returned struct's `data` field.
2. ABI-decode that `data` value as `(bytes32, string)`. Any standard ABI decoder works, for example in ethers.js: `AbiCoder.defaultAbiCoder().decode(["bytes32", "string"], data)`.
3. The first value is the claim's `claimId` (should equal the `claimId` field inside the second value). The second value is the claim, `JSON.parse()` it to get the object in §4.
4. Verify it per §10, using only the JSON and the recovered signer, no dependency on this repository.

**10. Verification**

1. Recompute `claimId` from the content fields per §5 and confirm it matches.
2. Recover the signer from `signature` over `claimId` and confirm it equals `buyerAddress`.
3. Where the underlying settlement is inspectable, confirm `buyerAddress` matches the settlement's `payer` (§6).
4. Where `priorClaimId` is present: the referenced claim MUST exist in the gathered set and independently verify per steps 1-2. It being signed means the buyer commits to it as part of `claimId` (§4), but that commitment is not itself proof it was ever recorded; treat a missing or unverifiable `priorClaimId` as an *incomplete* chain (§8), not as grounds to reject the claim it appears in. Two distinct claims from the same buyer sharing one `priorClaimId` is a fork, not a validity failure; report both.
5. Treat every other field as an unverified assertion by the buyer, not a proven fact.

**11. Security Considerations**

- A claim's signature proves who signed it, not that the events described happened as claimed (§8).
- Implementations MUST re-verify every claim's signature and `claimId` regardless of which source produced it; no source should be trusted by default (§7).
- `evidenceHash` commits to evidence without storing or transmitting it; a verifier that wants stronger assurance must obtain the underlying evidence out of band and check the hash itself.
- Size and depth bounds on `promisedSpec` (documented in the reference schema) exist specifically to prevent a claim from being used to grow a shared ledger or a verifier's memory footprint unboundedly.

**12. Privacy Considerations**

- `buyerAddress` and `sellerAddress` are pseudonymous on-chain identifiers, not verified real-world identities.
- `evidenceHash` deliberately does not carry the evidence itself, only a commitment to it, to avoid forcing disclosure of potentially sensitive delivery content into a public claim.
- Publishing claims to a public substrate (EAS or similar) makes the pseudonymous transaction history linkable; implementations that need to avoid this SHOULD keep claims in a private or access-controlled ledger and only disclose on request, at the cost of losing the no-trusted-index discovery property in §7.

**13. Version History**

| Version | Date | Changes | Author |
| --- | --- | --- | --- |
| 0.1 (draft) | 2026-09-28 | Initial draft | holistis |
