# Extension: `durable-evidence`

## Summary

x402 settles payment durably on-chain and delivers the purchased resource once,
in the body of a `200 OK`, retaining nothing. Settlement is permanent; delivery
is not. Afterwards neither party can prove **what** was delivered, and a buyer
who did not persist the body cannot obtain it again.

`durable-evidence` lets a resource server seal a copy of the delivered body to
the parties' own public keys, anchor the ciphertext durably, and have a
facilitator notarise the anchor. The buyer can retrieve and decrypt it later
with the wallet it paid with; no third party — the facilitator and the storage
included — can read it. The buyer opts in per purchase through the existing
`accepts` array.

Key material comes from the payment itself: a payment authorization is a
signature, and a signature yields the signer's public key. No registration and
no extra round trip are required.

## PaymentRequired

The server declares the extension once, at the top level of the challenge,
and names the offers that include evidence by their index in `accepts`. The
same placement applies to x402 v1 and v2.

```jsonc
{
  "x402Version": 1,
  "accepts": [
    { "scheme": "exact", "network": "eip155:8453", "maxAmountRequired": "10000", "payTo": "0xSELLER", "asset": "0xUSDC", "...": "..." },
    { "scheme": "exact", "network": "eip155:8453", "maxAmountRequired": "12000", "payTo": "0xSELLER", "asset": "0xUSDC", "...": "..." }
  ],
  "extensions": {
    "durable-evidence": {
      "info": {
        "acceptIndexes": [1],
        "mode": "direct",
        "backend": "ipfs",
        "retention": "1y",
        "maxBodyBytes": 33554432,
        "paidBy": "seller"
      },
      "schema": { "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object", "...": "..." }
    }
  }
}
```

`info` fields:

| Field | Type | Meaning |
|---|---|---|
| `acceptIndexes` | `integer[]` | Offers that include evidence. REQUIRED. Empty applies to no offer. |
| `mode` | `"direct"` | Content key wrapped to the parties' keys only. The only mode defined in this version. |
| `backend` | `"s3" \| "ipfs" \| "arweave"` | Where ciphertext is stored. Informational; the anchor records the backend actually used. |
| `retention` | `"90d" \| "1y" \| "permanent"` | How long the ciphertext is guaranteed retrievable. Default `"90d"`. `"permanent"` is irrevocable. |
| `maxBodyBytes` | `integer` | Bodies above this are delivered without evidence. Default 33554432. |
| `paidBy` | `"seller" \| "buyer"` | Who bears the storage cost. Informational. |

Servers MUST price the offers with and without evidence separately and MUST
list the offer without evidence such that a client unaware of this extension
degrades to it. Servers MUST NOT list two offers on the same network that
differ only in this declaration at the same `payTo` and amount.

A declaration that is present but does not validate against `schema` applies
to **no** offer: the server MUST deliver without evidence and MUST report
`not_selected` (see *SettlementResponse*). For a consent extension the safe
failure is anchoring nobody.

## PaymentPayload

A v2 client that pays an offer named in `acceptIndexes` MUST echo the `info`
it received under `extensions["durable-evidence"]` of the payload, per the core
specification's echo rule. A v1 client has no `extensions` field and echoes
nothing; the server identifies the choice by which offer the payment satisfies.

Servers MUST determine the paid offer from what the payment commits to (the
signed recipient and amount), never from the order offers were listed in. When
the payment satisfies more than one offer exactly, the offer that includes
evidence is the one the buyer can have chosen on purpose and MUST be taken.

## SettlementResponse

After settlement, the resource server places the evidence object under
`extensions["durable-evidence"]` of the settlement response it forwards to the
buyer (the `X-Payment-Response` header in v1):

```jsonc
{
  "v": 1,
  "paymentId": "0x…",              // keccak256(caip2 ‖ txHash without 0x)
  "pointer": "ipfs+https://…",     // where the ciphertext is
  "backend": "ipfs",
  "contentHash": "0x…",            // keccak256 of the PLAINTEXT body
  "cipher": "AES-256-GCM",
  "keyAlg": "ECIES-secp256k1",     // or "ECIES-X25519"
  "mode": "direct",
  "retention": "1y",
  "receipt": "0x…",                // facilitator's EIP-712 signature (below)
  "verified": true,                // the chain confirmed payer and payee
  "signed": true                   // the payee signed the anchor
}
```

or, when no evidence was produced, a skip notice:

```jsonc
{ "v": 1, "skipped": "not_selected" }
```

`skipped` ∈ `too_large | busy | anchor_failed | no_payer_key | disabled |
not_selected`. Clients MUST treat the set as open and MUST NOT discard the
notice over an unknown value. **A failure to produce evidence MUST NOT fail
the payment or alter the delivered body.**

`contentHash` is over the plaintext: it lets the buyer prove the anchored
ciphertext decrypts to exactly the bytes served.

## Encryption

```
CEK          := random 32 bytes
ciphertext   := AES-256-GCM(key=CEK, nonce=random 12B, plaintext=body, aad=paymentId)
for each recipient:
  shared     := ECDH(ephemeral.private, recipientPubKey)
  wrapKey    := HKDF-SHA256(ikm=shared, salt=paymentId, info="DX402-v1-wrap")
  wrappedCEK := AES-256-GCM(key=wrapKey, nonce=random 12B, plaintext=CEK, aad=paymentId)
```

The buyer's public key is recovered from the payment: ECDSA recovery on
secp256k1 chains; on ed25519 chains the address is the key, mapped to X25519
for ECDH. The body is stored once; every recipient unwraps the same CEK, so a
seller (or auditor) copy costs ~98 bytes, not a second payload. The stored
layout is:

```
v1: "DX402" | 0x01 | alg | eph_len | eph | cek_nonce | wrapped_len | wrapped | body_nonce | ciphertext
v2: "DX402" | 0x02 | count | count × (role | alg | eph_len | eph | cek_nonce | wrapped_len | wrapped) | body_nonce | ciphertext
```

Implementations MUST reject small-order ed25519 points before ECDH (RFC 7748
§6.1). `paymentId` MUST be the AEAD associated data on both seals.

## Anchoring and verification

The resource server registers the anchor with a facilitator. The registration
carries metadata only — pointer, `contentHash`, the parties, the payment proof
— never plaintext. The facilitator judges every anchor and signs a receipt.

**Anchor authorization** — what the payee signs, binding payment, content and
location together:

```
domain = { name: "DX402 Anchor", version: "1", chainId: <settlement chain> }
Dx402AnchorAuthorization { bytes32 paymentId; bytes32 contentHash; string pointer; address payee; }
```

ed25519 payees sign the same digest with a raw ed25519 signature, `payee` set
to the zero address; the binding is established by which key verifies.

**Evidence receipt** — what the facilitator signs, verifiable offline:

```
domain = { name: "DX402 Evidence", version: "1", chainId: <settlement chain> }
Dx402EvidenceReceipt { bytes32 paymentId; bytes32 contentHash; string pointer; address payer;
                       address payee; bytes32 txHash; uint8 mode; uint64 anchoredAt; uint64 retentionUntil; }
```

**Authority.** A record is *provisional* (anyone could have written it),
*signed* (the signature matches the payee the caller declared — a diagnostic),
or *verified* (the chain confirms the payee, the payer is the address the
envelope was sealed to, the payee signed, the proof is for this transaction
and younger than 900 seconds). A weaker claim never locks out a stronger one; a
stronger one supersedes. Only *verified* is final. Without this rule the
anti-replay is a weapon: whoever anchors first owns a stranger's payment
forever. The record's `payee` and `txHash` MUST equal the proof's.

**Escrow-released payments.** When funds are released from an escrow the
ERC-20 `from` is the escrow's token store, never the buyer. Such anchors carry
the escrow authorization (`escrowRelease`); the facilitator MUST determine the
rail from the transaction receipt — never from the caller's declared payer —
recompute the authorization's hash on the escrow contract, and require it to
equal one this transaction captured. A transaction that captured more than one
payment MUST be refused: `paymentId` is per transaction and cannot say which.

## Security Considerations

1. **Anchoring is publishing.** `permanent` retention is irrevocable; the
   default MUST be bounded.
2. **The anchor is claimable by anyone who observes a settlement.** The
   authority ladder is the defence; an implementation without it hands the real
   seller's slot to whoever anchors first.
3. **Finality MUST come from the chain, not from the request.** Certifying
   "the declared payee signed" lets an observer supersede the real seller.
4. **A defence inside a conditional branch is bypassed by avoiding the
   branch.** Rail classification, ambiguity refusal and receipt binding MUST be
   properties of the receipt and payload, not of the code path taken.
5. **What `verified` means.** An escrow accepts any token collector for the
   operator named in the authorization, and a proof matches any `Transfer` in
   the transaction. `verified` asserts that a chain event consistent with the
   claim exists between the parties on the known escrow — not that the named
   payer was defrauded of funds. A token allowlist tightens this.
6. **Harvest-now-decrypt-later.** ECDH is not post-quantum; do not anchor
   permanently what must not survive.
7. **Memory.** Sealing holds plaintext and ciphertext; bound concurrency and
   deny rather than queue.
8. Buyers SHOULD verify `contentHash` against the bytes they were served.

## Privacy Considerations

The facilitator learns pointers, hashes and the parties' addresses — the same
addresses already visible on-chain — and never a body. Storage learns
ciphertext only. A cached or intercepted paid response is unreadable to the
intermediary. Retention is a privacy promise: an implementation MUST honour
`retentionUntil` where the backend allows deletion and MUST disclose where it
does not (`revocable: false`).

## Relationship to other extensions and proposals

| | Proves |
|---|---|
| `offer-receipt` | Terms were agreed and something was delivered |
| `payment-identifier` | A stable handle for the payment |
| **`durable-evidence`** | **What** was delivered, retrievable later, readable only by the parties |

Several open proposals bind a **hash** of the delivered body to the receipt
(`offer-receipt` v2 `responseHash` / `contentHash`, `response-provenance`,
settlement-receipt and operation-binding). A hash proves the body was what it
was; it does not let anyone read it again. `durable-evidence` is the retrieval
layer they imply: its `contentHash` is over the plaintext so it can consume
whichever hash commitment lands, rather than compete with it. Where such a
commitment exists in the same exchange, implementations SHOULD bind to it.

A settlement-status vocabulary in which every state names an on-chain object a
third party can check (#3208) composes the same way: the notarised anchor —
`paymentId`, `contentHash`, pointer and the facilitator's receipt — is such an
object, and a settled state MAY reference it. Third-party evidence exports
(signed attestations re-derivable from public bytes) SHOULD verify against
`contentHash` rather than against a copy of the body.

## Reference implementation (non-normative)

Facilitator, seller hook and buyer client in Rust (`x402-rs`, `x402-axum`,
`x402-reqwest`), with Python and TypeScript SDKs. The facilitator exposes
`POST /dx402/anchor`, `GET /dx402/evidence/{paymentId}`,
`GET /dx402/receipt/{paymentId}`, `GET /dx402/blob/{paymentId}`,
`GET /dx402/stats`; these endpoints are this implementation's and are not part
of the extension. Not in this version: certification on non-EVM chains
(anchors are recorded and signed but not chain-verified), a facilitator-held
recovery mode, and a derived-key mode for browser wallets.

## Version History

- **0.3** — Registry shape: top-level `extensions` with `{info, schema}` and
  `acceptIndexes`; evidence under `SettlementResponse.extensions`; receipt
  fields bound to the proof; rail classified from the receipt.
- **0.2** — Buyer opt-in through `accepts`; escrow-released payments;
  multi-recipient envelope; authority ladder.
- **0.1** — Initial: sealed evidence, facilitator receipt.
