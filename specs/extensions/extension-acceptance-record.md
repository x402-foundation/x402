# Extension: `acceptance-record`

| | |
|---|---|
| Status | Draft, version 0. Not ratified; no x402 body has accepted it. |
| Extension key | None in this version: the record is produced and verified out of band, and its transport in x402 messages is deferred (§10). |
| x402 versions | v1 and v2: the record names the delivery through the seller's signed records, not through an x402 message. |
| Related | [`offer-receipt`](./extension-offer-and-receipt.md), whose signed offer is the terms evidence (§7); x402 PR #3682 (`x402ev/1`, the subject profile, §6); PR #3783 (a future subject profile); PR #3604 (prior buyer-side work) |
| Test vectors | [`extension-acceptance-record.vectors.json`](./extension-acceptance-record.vectors.json): 127 vectors over the 25 requirement cases, both signing forms; sha256 `8c20c905ae9af000f9664ee78bf73a6ac2c47f501c221789b835121a0af16ec5` (§12) |
| Source | [https://github.com/CNSLabs/x402-acceptance-record](https://github.com/CNSLabs/x402-acceptance-record) at tag `draft-2026-10-27`: specification, case list, vectors, generator and three checkers, each with disclosed provenance |

Shodai (CNS Labs). Draft, not ratified.

## 1. Status

Draft for review: not an x402 specification, and no x402 body has accepted it. Its identifiers (the EIP-712
domain name and version, the JWS `typ`, the body version, the record-identity prefix, and the subject and authority
profile names) are draft identifiers and may change before ratification. No example here has been run.

Requirements are numbered `AR-n`. The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119 and RFC 8174.
[CASES.md](https://github.com/CNSLabs/x402-acceptance-record/blob/draft-2026-10-27/CASES.md) maps each requirement to the cases that test it.

## 2. What the record says

An acceptance record is the counterparty's signed decision about one specific delivery: `accepted`, `rejected` or
`disputed`. It has two signing forms, EIP-712 and JWS, with one body and one meaning.

Roles. The delivery issuer signed the record of the delivery, called the subject record (for x402, the seller's
server). The confirming party is the counterparty whose decision this is, usually the buyer. The signer is the key or
account that signs: the confirming party itself, or someone the relying party accepts as deciding for it about this
delivery (§7). A relying party runs the verifier against its own trust inputs (§5).

**AR-1.** `disposition` MUST be `accepted`, `rejected` or `disputed`. Any other value, including `not_responded`, is
`acceptance_member_invalid`.

**AR-2.** A verified record authenticates the confirming party's decision about the identified delivery and terms.
The terms are a seller's offer matched to the delivery on payment terms; this version does not establish that the
offer's resource is the delivered resource (AR-29).
Consumers MUST NOT treat it as assent to obligations beyond that decision, as payment authorization, or as proof of
quality. (Not data-testable: governs consumers.)

**AR-3.** Each record is verified on its own. A verifier MUST NOT let one record change the result of another; a
later record does not replace or cancel an earlier one.

`not_responded` is a reserved term. It means "a response was due under the terms and none arrived". This version never produces it.

Response windows are planned for the next revision. This version creates no response obligation and infers nothing from silence.

## 3. Body

The body is a JSON object with exactly these eleven members. "hex32" means `0x` followed by 64 lowercase hex digits.

| Member | JSON form | Meaning |
|---|---|---|
| `version` | integer `0` | Body version. |
| `contextId` | hex32 | The subject's identity as `bytes32`: the 64 hex digits of `subject.reference` (AR-24). It adds no information to `subject.reference`; it gives the EIP-712 message and on-chain consumers a fixed-width key. |
| `deliveryIssuer` | non-empty string | Issuer of the subject record (`x402ev/1`: the seller), as `trust.issuers` names it. |
| `confirmingParty` | string | Whose decision this is. Empty means absent. |
| `signer` | non-empty string | EIP-712: an `eip155` account (AR-11). JWS: the key's identifier (AR-18). |
| `authority` | object `{mode, profile, reference}`, strings | How authority is established (§7). |
| `termsDigest` | hex32 | The terms of the decision (AR-29). |
| `outcomeDigest` | hex32 | The delivered result (AR-25). |
| `subject` | object `{profile, reference}`, strings | The subject record, under a subject profile (§6). |
| `disposition` | string | AR-1. |
| `issuedAt` | integer | Unix seconds, the signer's claim. Not a trusted timestamp. |

**AR-4.** The body MUST contain exactly the eleven members above, `authority` exactly `mode`, `profile` and
`reference`, and `subject` exactly `profile` and `reference`. A missing or additional member is
`acceptance_member_invalid`. New signed meaning requires a new body version; there is no extension container.

**AR-5.** Each member MUST have the form in the table: `version` is the integer `0`; hex32 members match
`^0x[0-9a-f]{64}$`; string members are JSON strings; `issuedAt` is an integer from 0 to 2^53 − 1. A member of the
wrong form is `acceptance_member_invalid`. An empty `confirmingParty` is `confirming_party_absent`, not
`acceptance_member_invalid`.

**AR-6.** The JSON text, and the JWS protected header, MUST be I-JSON (RFC 7493): valid UTF-8, no lone surrogate
escapes, no duplicate member names. Integers MUST be written as plain decimal digits with no sign, fraction, exponent
or leading zero. Anything else is `acceptance_member_invalid`. The only numbers in the body are `version` and `issuedAt` (AR-5); any
other number, or either of them written in another form, is `acceptance_member_invalid`. Strings are compared byte-exact: no case folding, trimming or Unicode normalization. Every JCS serialization this specification hashes or signs (the
body, AR-16 and AR-21; the offer payload, AR-29) MUST be produced by an RFC 8785-conformant implementation.

## 4. Signing forms

**AR-7.** A record is one envelope. EIP-712: `{"format": "eip712", "payload": <body>, "signature": <hex>}`. JWS:
`{"format": "jws", "signature": <compact JWS>}`. The envelope MUST have exactly these members for its format.
Any other shape or `format` is `acceptance_member_invalid`.

### 4.1 EIP-712

**AR-8.** The domain MUST be exactly `{name: "x402 acceptance", version: "0"}`, typed as
`EIP712Domain(string name,string version)`. It has no `chainId`, `verifyingContract` or `salt`. A signing request
MUST declare `EIP712Domain` explicitly in its `types`, and its domain object MUST NOT contain a `chainId` key. A
signature under any other domain fails AR-13 or AR-14.
(The request rule is signer-side.)

**AR-9.** The primary type MUST be `Acceptance`, with these types, in this order:

```text
Acceptance(uint256 version,bytes32 contextId,string deliveryIssuer,string confirmingParty,uint256 signerChainId,address signerAccount,Authority authority,bytes32 termsDigest,bytes32 outcomeDigest,Subject subject,string disposition,uint64 issuedAt)
Authority(string mode,string profile,string reference)
Subject(string profile,string reference)
```

`types` and `primaryType` are not transmitted. The digest is
`keccak256(0x19 ‖ 0x01 ‖ domainSeparator ‖ hashStruct(Acceptance, message))` as EIP-712 defines it.

**AR-10.** The typed message MUST be derived from the body: `version` and `issuedAt` as integers; `contextId`,
`termsDigest` and `outcomeDigest` as `bytes32`; `signerChainId` and `signerAccount` from `signer` (AR-11);
every other member unchanged. If a member it uses fails AR-5, AR-6 or AR-11, the message cannot be built:
`acceptance_member_invalid`.

**AR-11.** In this form `signer` MUST be `eip155:` + a decimal chain ID from 1 to 2^256 − 1 with no leading zero +
`:` + `0x` + 40 lowercase hex digits. `signerChainId` and `signerAccount` are those two parts. Any other spelling,
or the zero address, is `acceptance_member_invalid`.

**AR-12.** The verifier MUST check the signature on the chain `signerChainId` names, and on no other chain: not the
payment network and not the network a wallet was on. An account with code on that chain is a contract account;
otherwise it is an ordinary account. An account whose code is an EIP-7702 delegation designator has code and is a
contract account: the delegate's code decides, through AR-14, and recovery never runs. If the verifier cannot
establish which it is, the result is `key_unresolved` with reason `chain_state_unavailable`. This classification needs chain facts for `signerChainId` even
for an ordinary account: a verifier holding none returns `key_unresolved` for every EIP-712 record. The `chain` input
(§5) may supply them; a JWS record needs none.

**AR-13.** For an ordinary account, `signature` MUST be `0x` + 130 lowercase hex digits encoding `r ‖ s ‖ v`:
`v` is 27 or 28, `0 < r < n`, `0 < s ≤ n/2` (EIP-2), where `n` is the secp256k1 group order. The verifier MUST NOT
normalize `v` or `s`. The recovered address MUST equal `signerAccount`. Any failure is `signature_invalid`.

**AR-14.** For a contract account, `signature` MUST be `0x` + an even number of lowercase hex digits, else it is
`signature_invalid` with no call. The verifier MUST call ERC-1271 `isValidSignature(digest, signature)` on that
account on `signerChainId`. The call is valid if and only if it returns at least 32 bytes of return data whose first
32 bytes are `0x1626ba7e` followed by 28 zero bytes: the rule OpenZeppelin's `SignatureChecker` applies, so off-chain
and on-chain verdicts agree. Shorter return data, any other first word, or a revert is `signature_invalid`.
Unavailable chain state gives `key_unresolved`
with reason `chain_state_unavailable`; a verifier that does not validate contract accounts gives `key_unresolved` with
reason `contract_accounts_unsupported`. The verifier MUST NOT fall back to signature
recovery. A valid result speaks for that account only. A verifier SHOULD record the chain and block it used (not
data-testable).

**Why the domain has no chain.** x402's offer and receipt extension fixes the domain `chainId` at 1 so that one
off-chain signing format works on every payment network, which its payload names; its signer is the service's own
key. An acceptance is signed by the account owner's wallet. Wallets commonly refuse to sign when the domain `chainId`
differs from their active network (the wallet we tested does), so any chain in the domain would force a network
switch. As the owner's statement, not a contract
permission, it names no `verifyingContract`. `signerChainId` names the account's chain inside the signed message.

### 4.2 JWS

**AR-15.** The record MUST be a JWS compact serialization (RFC 7515): three canonical base64url segments, without
padding and with zero unused trailing bits. The protected header MUST decode to a JSON object with exactly
`alg: "EdDSA"`, a non-empty string `kid`, and `typ: "x402-acceptance+jws"`. Any other header, encoding or `alg` is
`acceptance_member_invalid`, found before the key step.

**AR-16.** The payload MUST be exactly the RFC 8785 (JCS) serialization of the body. A payload that differs from JCS of
its decoded body is `acceptance_member_invalid`, found after the key step.

**AR-17.** The signature MUST be Ed25519 (RFC 8032) over the ASCII bytes of `protected || "." || payload`.

**AR-18.** The verifier MUST use the `trust.keys` entry whose `kid` equals the header `kid` and whose `signer` equals
the body's `signer`. If no entry has that `kid`, the result is `key_unresolved` with reason `key_missing`; if an entry
has that `kid` but its `signer` differs from the body's, the result is `key_unresolved` with reason `signer_mismatch`.
An input whose `trust.keys` lists one `kid` twice is refused before `verify` runs and has no result.

**AR-19.** The public key MUST be a canonical 32-byte encoding (y < p, p = 2^255 − 19) of a point of order exactly
L, the order of the base point. A non-canonical, small-order (order dividing 8) or mixed-order (a point of order L
plus a small-order component) key is not a key of the signer: `key_unresolved` with reason `key_refused`.

**AR-20.** The signature MUST be 64 bytes `R ‖ S` with `R` a canonical encoding of a point of order exactly L and
`S < L`. Otherwise, or if the RFC 8032 §5.1.7 check fails, the result is `signature_invalid`.

### 4.3 Record identity

**AR-21.** `statementId(body)`, the record's identity, MUST be `x402accept/0:sha256:` + lowercase hex SHA-256 of
JCS(body). The same body has the same identity in either form. For JWS, the signed payload is its preimage. (Not
result-changing; values are fixed with the vectors.)

### 4.4 Example envelopes (illustrative)

These show the shape only. Values are elided and nothing here has been run; the vectors carry verifiable bytes.

EIP-712, for an ordinary account on chain 84532 accepting an `x402ev/1` receipt:

```json
{
  "format": "eip712",
  "payload": {
    "version": 0,
    "contextId": "0x7a41…",
    "deliveryIssuer": "did:web:seller.example",
    "confirmingParty": "eip155:84532:0xab12…",
    "signer": "eip155:84532:0xab12…",
    "authority": { "mode": "direct", "profile": "payer/0", "reference": "" },
    "termsDigest": "0x9c3e…",
    "outcomeDigest": "0x1c27…",
    "subject": { "profile": "x402ev/1", "reference": "x402ev/1:sha256:7a41…" },
    "disposition": "accepted",
    "issuedAt": 1791500600
  },
  "signature": "0x…"
}
```

`contextId` repeats the 64 hex digits of the `evidenceRef` (AR-24). The signed typed message adds `signerChainId`
84532 and `signerAccount` from `signer` (AR-10, AR-11).

JWS, with the protected header `{"alg":"EdDSA","kid":"cp-1","typ":"x402-acceptance+jws"}` encoded as shown and the
payload and signature as placeholders:

```json
{ "format": "jws", "signature": "eyJhbGciOiJFZERTQSIsImtpZCI6ImNwLTEiLCJ0eXAiOiJ4NDAyLWFjY2VwdGFuY2UrandzIn0.<base64url(JCS(body))>.<base64url(signature)>" }
```

## 5. The verifier's inputs

| Input | Content |
|---|---|
| `record` | The envelope's JSON text, or absent. |
| `subject` | The subject record as its profile transmits it, or absent. |
| `terms` | Zero or more issuer-signed terms artifacts (AR-29). |
| `outcome` | Optional: the delivered bytes. Not required for any result (AR-25). |
| `trust.issuers` | Entries `{issuer, keys}`: Ed25519 keys (optional key ids) and Ethereum addresses accepted for that issuer. |
| `trust.keys` | Entries `{kid, signer, key}` for JWS signers. |
| `trust.authority` | Declared-evidence entries `{confirmingParty, signer, subjectProfile, subjectReference}` (AR-32). |
| `trust.complete` | Optional declaration that `trust.keys` is complete. |
| `chain` | Per `(chainId, account)` at a stated block: whether it has code and, for a contract account, the return data or `revert` of each listed `isValidSignature(digest, signature)` call. Anything not listed is unavailable. |
| `contractAccounts` | Whether the verifier validates contract accounts. Default true. |

**AR-22.** A verifier MUST treat `trust.complete` as a declaration only when it is the JSON value `true`.

## 6. Subject

**AR-23.** A verifier MUST NOT guess a subject by hashing arbitrary JSON. An unknown `subject.profile` gives
`unknown` with reason `profile_unavailable`. The verifier MUST authenticate the supplied subject record under its
profile, with a key that `trust.issuers` lists for `deliveryIssuer`. A subject that is absent, or does not
authenticate, is unavailable. Every Ed25519 check of subject or terms evidence MUST apply AR-19 and AR-20; a key or
signature they refuse makes that evidence unavailable. Ed25519 keys are compared as 32-byte values. In the profiles
below, a field without its stated form makes the subject unavailable.

**AR-24.** `subject.reference` MUST equal the identity computed from the authenticated subject record, byte-exact,
and `contextId` MUST equal `0x` + the 64 hex digits of that identity. Otherwise the record is
`acceptance_record_digest_mismatch`. `contextId` is that identity in `bytes32` form and nothing more; a record never
carries a `contextId` chosen before the delivery.

**AR-25.** `outcomeDigest` MUST equal the subject's bound outcome digest. Otherwise
`acceptance_outcome_digest_mismatch`. The delivered bytes are not required for `verified`. When `outcome` is
supplied, its SHA-256 MUST also equal `outcomeDigest`; otherwise the record is `acceptance_outcome_digest_mismatch`.

**AR-26.** `issuedAt` MUST NOT be earlier than the subject's outcome time; otherwise the record is
`acceptance_precedes_outcome`. Equal values are allowed; no tolerance applies.

**AR-27. `x402ev/1`** (x402 execution evidence, PR #3682 at head `23b5c21`, unmerged). A verifier supporting this
profile MUST apply:
- Record: the `execution-evidence` `info` object. Authentication: that specification's verification rule 1, comparing
  Ethereum addresses (`0x` + 40 hex digits) case-insensitively. `signer.keyType` must be `Ed25519`; `signer.publicKey`, unpadded
  base64url, must be a key that `trust.issuers` lists for `deliveryIssuer` (AR-23), which is the external trust input rule 1 requires; otherwise the subject is unavailable. Its content-integrity and settlement checks are not part of acceptance
  verification.
- Identity: `evidenceRef`, byte-exact. The 64 hex digits after `x402ev/1:sha256:` give `contextId`.
- Payer: `eip155:<chain>:<address>`, from `payment.network` of the form `eip155:<decimal>` and `payment.payer` with
  its hex lowercased. Otherwise the record has no payer.
- Outcome digest: `0x` + the hex of `delivery.contentDigest`, which must be `sha256:` + 64 lowercase hex.
- Outcome time: `delivery.timestamp`, integer seconds.
- Terms: the seller's signed x402 offer (AR-29).

**AR-28.** Reserved.

**Composition (informative).** A record accepts whatever subject a subject profile defines, and names it by the
identity that profile gives; the subject record and the acceptance keep their own signers and their own claims. This
release focuses on x402 delivery records and defines one profile, `x402ev/1`. A receipt that carries `txHash` names its
settlement, and a payment fingerprint correlates it with other records of the same payment; the acceptance reaches
either through `subject.reference`. This version's verifier does not check settlement, and the acceptance itself
carries no payment member (§10). Composition with other records, including third-party findings such as the
work-acceptance record proposed on x402-foundation/tsc#4, is follow-up work while that record's updated
profile settles. An unknown profile gives `unknown` with reason `profile_unavailable` (AR-23).

## 7. Terms and authority

**AR-29.** `termsDigest` MUST equal the terms digest committed in authenticated evidence from the subject record's
issuer, as the subject profile defines it. A digest written only by the confirming party is not evidence of that
commitment. If the evidence gives a different digest, the record is `acceptance_terms_digest_mismatch`. If there is
no such evidence, the result is `unknown` with reason `evidence_unavailable`. For `x402ev/1`, the evidence is the
seller's x402 signed offer (offer and receipt extension, at `faa1c694`) in EIP-712 form or JWS form with
`alg: "EdDSA"`, that:
- verifies under that extension's offer verification, with a key or address `trust.issuers` lists for
  `deliveryIssuer`, which serves as that extension's signer authorization;
- has `network` and `amount` byte-equal to the subject's `payment.network` and `payment.amount`, and `asset` and
  `payTo` equal to its `payment.asset` and `payment.payee`, comparing Ethereum addresses (`0x` + 40 hex digits)
  case-insensitively and every other value byte-exact; and
- if it carries a non-zero `validUntil`, has `validUntil` no earlier than the subject's outcome time. In EIP-712 form a
  `validUntil` of `0` means absence, as that extension's §4.3 requires. The verifier's own clock is never an input: an
  offer that has since expired still evidences the terms of a delivery made while it was valid.

Its digest is `0x` + hex SHA-256 of JCS of the offer payload. Offers that do not meet all three conditions are disregarded.
If several offers qualify, `termsDigest` holds when it equals the digest of any of them.

These conditions do not include the resource. The offer's `resourceUrl` is not compared with the subject, because
`x402ev/1` does not define how its `request.urlHash` is derived. Two offers from one seller for different resources at
the same amount, asset, payee and network both qualify.

**AR-30.** A verifier MUST NOT report `verified` unless the signer's authority to decide for `confirmingParty` about
this delivery resolves. A valid signature, key ownership and spending permission do not establish it. An `authority`
triple this verifier does not support, or that does not resolve, gives `unknown` with
`acceptance_authority_unresolved`.

**AR-31. `payer/0`**: `{mode: "direct", profile: "payer/0", reference: ""}`. A verifier MUST treat it as resolved if
and only if `signer`, `confirmingParty` and the subject's payer are the same string. A subject without a payer does
not resolve.

**AR-32. `declared-evidence/0`**: `{mode: "declared", profile: "declared-evidence/0", reference: ""}`. A verifier
MUST treat it as resolved if and only if `trust.authority` holds an entry whose four members equal the body's
`confirmingParty`, `signer`, `subject.profile` and `subject.reference`. The relying party creates entries from evidence
it accepts that this signer may decide for this party about this delivery, such as a purchase or trust record. The
record never carries one, and a seller naming a delegate does not create one. (Weighing that evidence is not
data-testable.)

**AR-33.** A verifier MUST report `acceptance_signer_is_issuer` if `confirmingParty` or `signer` equals
`deliveryIssuer`, or the key or account that verified the record is listed in `trust.issuers` for `deliveryIssuer`
or signed the subject record.

**AR-34.** A verifier MUST report `confirming_party_absent` if `confirmingParty` is the empty string.

## 8. Verification

**AR-35.** `verify` MUST run these steps in order:

1. **No record.** Without `record`, the result is `no_record`.
2. **Preflight.** Parse the envelope (AR-7). EIP-712: parse the body and build the typed message (AR-6, AR-10,
   AR-11). JWS: decode and check the header (AR-15), and parse the payload (AR-6) as a JSON object whose `signer` is
   a non-empty string. A failure is `malformed` with `acceptance_member_invalid`.
3. **Key step** (draft-krausz-verification-state-03 §5.4.2, with EIP-712 account and chain-state failures mapped
   to its `key_unresolved`). Key checks run before signature checks. EIP-712: first establish the
   account type and any chain state (AR-12, and AR-14's availability rule), then check the signature (AR-13, or
   AR-14's call). JWS: first the key (AR-18, AR-19), then the signature (AR-17, AR-20). An unresolved key or
   account stops with `key_unresolved` before any signature check. An invalid signature stops with `malformed` and
   the single condition `signature_invalid`.
4. **Malformed pass.** Evaluate every remaining condition and report all of them: AR-1, AR-4 to AR-6 and AR-16;
   AR-33; AR-34; and, when the subject profile is known and the subject is available, AR-24 to AR-26 and, when terms
   evidence is available, AR-29. A member that fails its form raises `acceptance_member_invalid` only; any comparison
   that depends on it is skipped. Missing evidence never produces a mismatch.
5. Any condition: `malformed`.
6. Unknown subject profile: `unknown`, reason `profile_unavailable`.
7. Subject or terms evidence unavailable: `unknown`, reason `evidence_unavailable`.
8. **Authority** (AR-30 to AR-32). Unresolved: `unknown` with `acceptance_authority_unresolved`.
9. Otherwise `verified`.

**AR-36.** The output is an object with these normative members; implementations MAY add others, and cases assert only
these:
- `result`: one of the tokens below.
- `conditions`: a set of condition names, compared without order; empty when none.
- `disposition`: present only with `verified` and `unknown`, copied from the signed body.
- `reason`: present with `unknown` when `conditions` is empty (`profile_unavailable` or `evidence_unavailable`), and
  with every `key_unresolved`: `key_missing` or `signer_mismatch` (AR-18), `key_refused` (AR-19),
  `chain_state_unavailable` (AR-12, AR-14) or `contract_accounts_unsupported` (AR-14). Absent otherwise.
- `policy_refusal`: present only with `key_unresolved`; `true` if and only if a JWS key was not resolved from
  `trust.keys` (AR-18, AR-19) and `trust.complete` is a declaration (AR-22), so the key is refused rather than
  merely missing; otherwise `false`.

Results: `verified`; `malformed` (one or more conditions below); `key_unresolved` (the key, account or chain state is
unavailable or refused, and no other check ran); `unknown` (well formed and validly signed, but authority or required
evidence is unresolved: a limit of the verifier); and `no_record`.

**What `verified` establishes (informative).** The record is well formed and validly signed, by a signer who is not the
delivery issuer; it names an authenticated
delivery record; its terms digest matches a qualifying signed offer from that record's issuer, matched on network,
asset, payee and amount; its outcome and timing agree with the delivery record; and the signer's authority to decide
for the confirming party about that delivery resolved. It does not establish settlement (§6, Composition); that the
delivered bytes match the delivery record's content digest, unless `outcome` was supplied (AR-25); or that the offer's
resource is the delivered resource (AR-29).

Conditions: `confirming_party_absent`, `acceptance_signer_is_issuer`, `acceptance_terms_digest_mismatch`,
`acceptance_outcome_digest_mismatch`, `acceptance_record_digest_mismatch`, `acceptance_precedes_outcome`,
`acceptance_member_invalid`, `acceptance_authority_unresolved` (only with `unknown`), and `signature_invalid` (only
alone, from the key step).

**AR-37.** `no_record` MUST carry no disposition and no conditions. A verifier MUST NOT report `not_responded`, or infer
acceptance, rejection or lateness, from a missing record.

## 9. Relation to the conditions posted on TSC #4 and to `acceptance-record-v0`

The result tokens and conditions follow those Shodai posted on TSC #4 on October 4–5, 2026, as the community's
`acceptance-record-v0` profile built them. The [README](https://github.com/CNSLabs/x402-acceptance-record/blob/draft-2026-10-27/README.md) lists the differences from both, including where the
evaluation order differs. This version makes no promise to verify records produced under other profiles.

## 10. Not in this version

Response windows, response obligations and producing `not_responded`; delegation systems and grant formats beyond
declared evidence; a subject profile for x402 delivery receipts (PR #3783); composition with third-party records such as work-acceptance records (follow-up);
binding the offer's resource to the delivery record (`x402ev/1` does not define how its `request.urlHash` is derived); counterfactual contract accounts
(ERC-6492); exercising a deployed contract wallet (ERC-4337 accounts, EIP-7702 delegates): contract accounts are
tested with declared chain state only; revocation; partial, streamed or milestone deliveries; a payment fingerprint member (an `x402ev/1`
receipt's fingerprint is reachable through `subject.reference`); advertising, returning, storing or transporting
records; and consequences such as release, refund or reputation. Vectors and three checkers with their recorded provenance are published beside this text (§12).

## 11. Security and privacy notes

- A wallet prompt may show its active network beside a different `signerChainId`. Signer software SHOULD display
  `signerChainId`. Accounts that hash the digest again under their own chain-bound domain validate only on the chain
  where they signed, which must be the chain the message names.
- `issuedAt` is the signer's claim. It proves neither receipt nor timeliness.
- The body carries identifiers and digests, not content; digests are not encryption.

## 12. Conformance vectors

[`extension-acceptance-record.vectors.json`](./extension-acceptance-record.vectors.json) (sha256 `8c20c905ae9af000f9664ee78bf73a6ac2c47f501c221789b835121a0af16ec5`) carries one vector per variant per signing form of
every case in [CASES.md](https://github.com/CNSLabs/x402-acceptance-record/blob/draft-2026-10-27/CASES.md): 127 vectors, each with the verifier's inputs of §5 and the
asserted output members of AR-36. The vectors and the seeds of every test key are dedicated to the public domain
under CC0 1.0; no key was ever funded on any chain.

Layout. The file is an object with `profile`, `specification` (the repository, tag, commit and the SHA-256 of
SPEC.md and CASES.md the vectors were built from), `generator`, `fixture` (the public keys, addresses and digests the
case list names, informative) and `vectors`. Each vector has `id` (`<case>-<variant>-<form>`), `case`, `variant`,
`form` (`eip712`, `jws` or `none`), `title`, `note`, `inputs`, `expect` and, where the body is well formed, the
informative `statementId` of AR-21.

`inputs` mirrors §5. Every byte-exact input is carried as unpadded base64url of its exact bytes, never as parsed
JSON, because several cases depend on lexical form: `record` (the envelope's JSON text, or `null` for absent),
`subject` (the `x402ev/1` `info` object's JSON text, or `null`), `terms` (an array; each decodes to a signed offer
object of the offer and receipt extension, `{"format":"jws","signature":…}` or `{"format":"eip712","payload":…,
"signature":…}`), optional `outcome` (the delivered bytes), `trust` (`issuers` as `{issuer, keys}` with each key
either `{"ed25519": <base64url>, "kid"?}` or `{"address": "0x…"}`; `keys` as `{kid, signer, key}`; `authority`
entries of AR-32; optional `complete`), `chain` (a list of declarations `{chainId, block, account, code}`, with
`calls` of `{digest, signature, returns}` or `{digest, signature, revert: true}` for accounts with code; anything
not listed is unavailable, AR-12 and AR-14) and `contractAccounts` (absent means `true`).

`expect` holds `result`, `conditions` (compared as a set), and `disposition`, `reason` and `policy_refusal` only
where AR-36 says they are present. A checker passes a vector when its output has the same result and condition set,
and each of those three members has the expected value when listed and no value when not; other output members are
not compared.

The source repository under `conformance/` contains the generator, the authors' TypeScript checker, an independent
Python implementation whose author saw expected outputs, and a Python implementation frozen before vector access.
The last one's original first-run result remains preserved alongside a separately recorded post-review revision r1.
All three implementations and r1 pass the 127-vector corpus. Passing this corpus does not settle inputs it does not
cover; the package records remaining interpretation differences. Independent reruns are invited.

## References

- EIP-712; EIP-2; ERC-1271; RFC 7493; RFC 7515; RFC 8032; RFC 8785.
- draft-krausz-verification-state-03, §5.4.2.
- x402 offer and receipt extension, `specs/extensions/extension-offer-and-receipt.md` at x402
  `faa1c694c66a3732aaabbce93bdae140e521a67d`.
- x402 execution evidence `x402ev/1`, x402 PR #3682 at head `23b5c21125982961a2d4c13faf3cb5a6d6d7c03b` (open,
  unmerged on October 20, 2026).
- Work-acceptance record proposal, `maximusrufus/work-acceptance-record`, referenced as related work.
- `acceptance-record-v0`, `babyblueviper1/preaction-governance-conformance` `examples/acceptance-record-cold`
  README, read at repository head `3243d33077d75a13c07eea1e05901101acdb316b` (README last changed at `ee668c8`).
- Shodai's posts on x402-foundation/tsc#4 of October 4, 5 and 6, 2026.
