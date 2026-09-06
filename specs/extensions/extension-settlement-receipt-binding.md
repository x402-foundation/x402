# Settlement-Receipt Binding Extension

**1. Overview**

This extension binds an x402 **settlement** to a server-side **signed execution receipt** so that an independent party can recompute the link from committed bytes alone — with no trust in the operator's logs.

It composes with the [Offer and Receipt Extension](./extension-offer-and-receipt.md): Offer and Receipt proves *the server asserted X*; this extension proves *X is what settled*, recomputably, through a content-addressed join. That is the half the auditability and dispute-evidence use cases are missing.

The receipt format is defined externally by the IETF Internet-Draft [**`draft-sirkkavaara-vaara-receipt`**](https://datatracker.ietf.org/doc/draft-sirkkavaara-vaara-receipt/), *"The Vaara Receipt: A Recomputable Receipt Format for Decisions About Agent Actions,"* profile identifier **`vaara.receipt/v1`** — the maintained home of the format originally circulated as MCP SEP-2828. This extension does **not** redefine the receipt. It specifies the **x402 settlement record** a receipt commits to, the **content-addressed join key** (`action_ref`), and the **`exact`-scheme settlement semantics**, so the two sides bind cleanly and verify offline.

The join is **rail-agnostic by construction**: the join key is computed only from the authorized-action tuple and never reaches into settlement internals, so the same receipt binds to a settlement on an EVM token or a non-EVM facilitator alike.

A reference conformance suite — committed `generic` and `sui` vectors plus an independent checker that imports neither x402 nor the receipt framework (standard library + RFC 8785 JCS + ES256) — is the normative gate. **The recompute is the test.**

**2. Status, Evolution, and Forward Compatibility**

Draft (`v0`). Composes with the Offer and Receipt Extension. Receipt format: `vaara.receipt/v1` (IETF `draft-sirkkavaara-vaara-receipt`). Implementations MUST treat unknown top-level settlement-record fields as opaque and preserve them under canonicalization. The conformance vectors are versioned alongside this document; a schema bump (`x402.settlement*/v1`) accompanies any change to the canonical field set.

**3. The Settlement Record**

The resource server (or its facilitator) emits a **settlement record**: a JSON object that names the authorized action and binds it to the on-chain settlement. A `vaara.receipt/v1` receipt commits to this record (§4).

Canonicalization is load-bearing and normative:

- The record is canonicalized with **RFC 8785 (JCS)** — identical to the receipt side, so one JCS implementation serves both.
- All digests are encoded as the string `sha256:<lowercase-hex>`.
- **No IEEE-754 floats** appear anywhere in the canonical body. Monetary amounts are **atomic-integer strings** with an explicit integer `decimals`; any other non-integer is a decimal string.
- `timestampMs` is an integer (milliseconds since the Unix epoch).
- Conformance REQUIRES a genuine RFC 8785 implementation. A `sort_keys`-style approximation (e.g. `json.dumps(obj, sort_keys=True, separators=(",", ":"))`) is byte-identical only for ASCII-string and integer field sets; it diverges on non-ASCII strings (Python's default `ensure_ascii` emits `\uXXXX` where JCS emits UTF-8) and on non-integer numbers (ECMAScript number canonicalization), and MUST NOT be relied on for the join.

**3.1 Common Fields (rail-agnostic)**

| Field        | Type    | Required | Description                                                                                                  |
| ------------ | ------- | -------- | ------------------------------------------------------------------------------------------------------------ |
| `agentId`    | string  | yes      | The actor that performed the authorized action.                                                              |
| `actionType` | string  | yes      | The action class (e.g. `purchase.fulfill`).                                                                  |
| `scope`      | string  | yes      | The authorized scope (e.g. `merchant:acme/order:INV-1/amount:42.00USDC`). Opaque to the join.               |
| `timestampMs`| integer | yes      | Action time, ms since epoch.                                                                                 |
| `seq`        | integer | yes      | Monotonic lifecycle sequence (§6).                                                                           |
| `terminal`   | boolean | yes      | Whether this record is the terminal state of the action (§6).                                               |
| `actionRef`  | string  | yes      | The **join key**: `sha256:` + SHA-256 over the JCS encoding of the action tuple (see §3.2).                  |
| `schema`     | string  | yes      | Settlement schema id: `x402.settlement/v0` (generic) or `x402.settlement.<rail>/v0` (rail-specific).         |

Exactly one rail-specific settlement binding is also present: `paymentHash` (generic, §3.3) **or** a `settlement` object (`exact` scheme, §3.4).

**3.2 The Join Key (`action_ref`)**

`actionRef` is the content-addressed join key:

```
actionRef = "sha256:" + hex( SHA-256( JCS({ agentId, actionType, scope, timestampMs, seq, terminal }) ) )
```

The action tuple is **exactly** those six fields. **Amount, asset, rail, and chain identifiers are deliberately excluded from the tuple.** This is what keeps the join rail-agnostic: a 9-decimal atomic settlement and a 6-decimal one for the same authorized action share an identical `actionRef`, and nothing chain-specific can diverge two producers' join keys.

**3.3 Generic Settlement Binding**

| Field         | Type   | Required | Description                                                              |
| ------------- | ------ | -------- | ------------------------------------------------------------------------ |
| `paymentHash` | string | yes      | A single content hash identifying the settlement, opaque to the join key.|

**3.4 `exact`-Scheme Settlement Binding (Normative)**

For the `exact` scheme on on-chain rails, the record carries a `settlement` object. Three properties — forced by the Sui `exact` rail and generalizing to any chain where "the transaction" and "what actually moved" are different objects (gas, change outputs, non-transparent settlement) — are normative:

1. **Bind the facilitator's verified net-balance result, not a re-derivation from the transaction.** `settlement.assertedFrom` MUST be `"net-balance-change-to-payTo"`: value and recipient are asserted from the net balance change credited to `payTo`, and that verified result is what the record binds — not a parse of transaction structure.
2. **Atomic-integer `amount` + explicit `decimals`, with amount out of the join key.** `settlement.amount` is an atomic-integer string; `settlement.decimals` is an explicit integer. Amount MUST NOT appear in the action tuple (§3.2).
3. **Settlement id is the executed id.** `settlement.txDigest` is the executed on-chain transaction id the facilitator returns in `PAYMENT-RESPONSE` — never a pre-execution intent or command id.

| Field          | Type    | Required | Description                                                                       |
| -------------- | ------- | -------- | --------------------------------------------------------------------------------- |
| `txDigest`     | string  | yes      | The executed on-chain settlement id (as returned in `PAYMENT-RESPONSE`).          |
| `payTo`        | string  | yes      | Recipient whose net balance change is asserted.                                   |
| `asset`        | string  | yes      | Asset identifier (e.g. a Move coin type or token address).                        |
| `amount`       | string  | yes      | Atomic-integer amount (string).                                                   |
| `decimals`     | integer | yes      | Decimals of `asset`.                                                              |
| `network`      | string  | yes      | Network identifier.                                                               |
| `scheme`       | string  | yes      | `exact`.                                                                          |
| `assertedFrom` | string  | yes      | `net-balance-change-to-payTo`.                                                    |
| `verifiedBy`   | string  | yes      | Identifier of the verifying facilitator.                                          |
| `rail`         | string  | yes      | Rail identifier (e.g. `sui`).                                                     |

**3.5 Example (live Sui testnet `exact` settlement, terminal step)**

```json
{
  "actionRef": "sha256:42f279db7f430127d682f1ccf6acdf90e679086b3c78b38fa30085cd6addc2f3",
  "actionType": "purchase.fulfill",
  "agentId": "agent:checkout-bot",
  "schema": "x402.settlement.sui/v0",
  "scope": "merchant:acme/order:INV-1/amount:42.00USDC",
  "seq": 1,
  "settlement": {
    "amount": "1000000",
    "assertedFrom": "net-balance-change-to-payTo",
    "asset": "0x2::sui::SUI",
    "decimals": 9,
    "network": "testnet",
    "payTo": "0xf0dab0dbd3011967b8a986abe16d0a7e580e408e972b6dc8473532815b898d86",
    "rail": "sui",
    "scheme": "exact",
    "txDigest": "7eGzqT3xijsWJKw5aJRA8c6EtmB8ZbfXuDfMe4LJsGEW",
    "verifiedBy": "facilitator://sui-exact"
  },
  "terminal": true,
  "timestampMs": 1779200000000
}
```

This is a real `exact`-scheme settlement from a live Sui facilitator; its on-chain `balanceChanges` independently show a net `+1000000` of `0x2::sui::SUI` to `payTo`, matching `settlement.amount` under `assertedFrom: net-balance-change-to-payTo`.

**3.5 Multi-Recipient Settlements (Per-Role Record Set)**

A single `exact` settlement may atomically credit more than one recipient — fee-splitting and gas-recovery facilitators land the merchant leg and the fee leg in one transaction. The settlement object deliberately binds a single `payTo` (§3.4), and the multi-recipient case does not weaken that discipline: the shape is **one record per recipient leg**, each binding that leg's payout under `assertedFrom: net-balance-change-to-payTo` with `payTo` set to that leg's recipient. Every leg of one authorized action carries the **identical action tuple** — the authorized action is the purchase, not the division — so their `actionRef`s are identical, and the records of one settlement MAY share a `txDigest`. The division is the set of records, not a field in any one of them; a party verifying its own leg needs only the record naming its address and is never required to recompute the division.

Worked example (informative; not part of the §5 pinned gate). These two records bind the two legs of a real fee-split `exact` settlement on Polygon mainnet: transaction `0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249` (block 90308815), in which one signed payer authorization moved 2.0 JPYC through a split forwarder — 1.0 to the merchant, 1.0 to a fee recipient. Both records derive the identical `actionRef` from exactly these JCS bytes (`timestampMs` is the settlement block's timestamp):

```
{"actionType":"purchase.fulfill","agentId":"agent:claude/openpay-x402-mcp","scope":"merchant:0x52d4901142e2B5680027da5EB47C86CB02a3cA81/resource:coo-icp-agent-consult/amount:2.00JPYC","seq":1,"terminal":true,"timestampMs":1784168218000}
```

Merchant leg:

```json
{
  "actionRef": "sha256:08d26a534dbbaa6653f088fe943ef7bfa129d01f612198939605c99af8a66169",
  "actionType": "purchase.fulfill",
  "agentId": "agent:claude/openpay-x402-mcp",
  "schema": "x402.settlement.evm/v0",
  "scope": "merchant:0x52d4901142e2B5680027da5EB47C86CB02a3cA81/resource:coo-icp-agent-consult/amount:2.00JPYC",
  "seq": 1,
  "settlement": {
    "amount": "1000000000000000000",
    "assertedFrom": "net-balance-change-to-payTo",
    "asset": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    "decimals": 18,
    "network": "eip155:137",
    "payTo": "0x52d4901142e2B5680027da5EB47C86CB02a3cA81",
    "rail": "evm",
    "scheme": "exact",
    "txDigest": "0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249",
    "verifiedBy": "facilitator://open-pay.jp"
  },
  "terminal": true,
  "timestampMs": 1784168218000
}
```

Fee leg (issued to the payer — the fee-transparency record):

```json
{
  "actionRef": "sha256:08d26a534dbbaa6653f088fe943ef7bfa129d01f612198939605c99af8a66169",
  "actionType": "purchase.fulfill",
  "agentId": "agent:claude/openpay-x402-mcp",
  "schema": "x402.settlement.evm/v0",
  "scope": "merchant:0x52d4901142e2B5680027da5EB47C86CB02a3cA81/resource:coo-icp-agent-consult/amount:2.00JPYC",
  "seq": 1,
  "settlement": {
    "amount": "1000000000000000000",
    "assertedFrom": "net-balance-change-to-payTo",
    "asset": "0xE7C3D8C9a439feDe00D2600032D5dB0Be71C3c29",
    "decimals": 18,
    "network": "eip155:137",
    "payTo": "0x428483FbA62eDCef1E3a100d3799F6d71759c560",
    "rail": "evm",
    "scheme": "exact",
    "txDigest": "0xa9e6c6a9ce10fd26ec2fab0d367de31d7fb0918c79d5e932b8566816ecda3249",
    "verifiedBy": "facilitator://open-pay.jp"
  },
  "terminal": true,
  "timestampMs": 1784168218000
}
```

These are real records produced by the operator of a production EVM facilitator in this PR's discussion. The transaction's on-chain transfer logs independently show a net `+1000000000000000000` of the JPYC token to each record's `payTo` — and `-2000000000000000000` from the payer, resolvable from the same shared `txDigest`, which is how a payer recovers its total debit from either record it holds. The fee-transparency property falls out of the shape: a facilitator that discloses one rate and settles another cannot issue a fee-leg record that recomputes green. The even division here is an artifact of the operator's fee floor at a small amount; the construction carries no assumption about the ratio.

**4. Binding a Receipt to the Settlement**

A `vaara.receipt/v1` receipt commits to the settlement record through a content-addressed evidence reference inside `decisionDerived.evidenceRef`, using the receipt format's content-addressed commitment shape:

| `evidenceRef` field | Value                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| `canonicalization`  | `"JCS"`                                                                                |
| `digest`            | `sha256:<hex>` over the **JCS-canonical settlement record** (the whole object of §3).  |
| `ref`               | `x402:action_ref/<actionRef>` — a stable, human-legible pointer to the join key.      |
| `schema`            | Echoes the settlement record's `schema`.                                               |

The **`digest` is the binding; `ref` is advisory.** Under the per-role record set of §3.5, one `actionRef` — and therefore one `ref` — names more than one settlement record, so a consumer MUST resolve the binding by `digest` and MUST NOT treat `ref` alone as naming a unique settlement record. `settlement_binding_resolves` (§5) is what enforces this: the merchant-leg and fee-leg records share an `actionRef` but differ under the digest because `payTo` differs, so a fee-leg record presented against a merchant-leg receipt fails the digest check.

The receipt is signed per `vaara.receipt/v1` (ES256/RS256/HS256, detached signature over the JCS body excluding `signature`). This extension defines only what the receipt's evidence reference points at and how its digest is computed; the receipt's decision/outcome structure and pairing are the receipt format's.

**5. Recompute (Conformance Gate)**

An independent party holding only the settlement record and the receipt MUST be able to confirm, offline and with no operator trust:

- **`action_ref_recomputes`** — `sha256(JCS(action tuple))` equals `settlement.actionRef`.
- **`settlement_binding_resolves`** — `sha256(JCS(settlement record))` equals `receipt.decisionDerived.evidenceRef.digest`, and `evidenceRef.canonicalization == "JCS"`.
- **`receipt_signature_ok`** — the receipt's signature verifies over its canonical signed blocks (`vaara.receipt/v1`).
- **`lifecycle_distinguishes_terminal`** — the in-progress (`terminal=false`) and terminal (`terminal=true`) steps have distinct `actionRef`s, and the in-progress receipt does not resolve against the terminal settlement (§6).

A normative reference suite implements these verdicts across two rails (`generic`, `sui`) and two lifecycle steps (in-progress, terminal), with a checker that imports neither x402 nor the receipt framework — standard library plus a JCS library and an ES256 verifier. A conformant implementation reproduces every verdict against the committed vectors byte-for-byte.

**Scope of the gate (non-goals).** Passing these verdicts proves the receipt *shape* recomputes and binds: the `action_ref` derives, the settlement digest resolves, the signature verifies, and the lifecycle steps are distinct. It does **not** prove that `backLink` resolves to a live attestation instance — the checker treats `backLink` and `issuerAsserted` as issuer-populated and does not dereference them. Binding a receipt to an actual upstream execution-attestation instance is a separate property, out of scope for this gate and not implied by a green result.

**Presentation rules (normative).** A green result from this gate establishes recomputability and binding, and nothing beyond it. Within the scope of the gate, a green result MUST NOT be presented as evidence of:

- **Outcome** — that any downstream world-effect occurred. Recomputability is not outcome (§9).
- **Issuer honesty** — that the signer was honest or authorized to issue the receipt. `receipt_signature_ok` establishes key custody and byte-integrity only (§9).
- **Independent conduct** — an independent finding about a party's conduct. Every signature in the bound pair is from a party to the transaction, so the pair is co-interested self-attestation, not an outside audit of either party.
- **Existence at a time** — that the record existed at its stated time. An issuer-asserted `timestampMs` is part of the claim, not a bound on it; only a timestamp an outside verifier resolves without trusting the issuer (e.g. the on-chain settlement time, or an RFC 3161-style timestamp token) establishes when-at-latest the record existed.

These are presentation constraints on the gate result, not schema requirements: they add no field and change no byte of the committed vectors.

The conformance vectors and checker are pinned **by content**. Git refs are mutable; the pin below names the objects themselves, so a re-tag, a history rewrite, or a repository move cannot silently change what "conformant" means:

- Repository: `vaaraio/vaara`, tag `v1.1.1` (commit `719827ce35544ee7d702c1402613d28d0e5a2552`)
- Path: `tests/vectors/x402_settlement_v0/` (rails `generic` + `sui`, steps `step0` + `step1`, plus `_check_independent.py` and `expected.json`)
- **Content pin (normative).** The vector directory tree `0907322631fec65dcce6fb8d3bec2de277e8dee2`, within which the checker is blob `06697860273c7e585b75550856ca31193b8a1e3d` and `expected.json` is blob `3bd08232559030171949d03ba59bc7c568b85992`. These object identifiers — not the tag and not the commit — define the gate.
- Permalink: <https://github.com/vaaraio/vaara/tree/719827ce35544ee7d702c1402613d28d0e5a2552/tests/vectors/x402_settlement_v0>

`_check_independent.py` imports only the standard library plus a JCS library (`rfc8785`) and an ES256 verifier (`cryptography`) — no x402 and no receipt-framework import — and exits `0` only when every verdict matches `expected.json`. *(A vector update is a change to the object identifiers above, and is accompanied by a schema version bump per §2. Where the vectors are hosted, and who controls that update path, is a venue decision for the maintainers; the content pin makes the gate checkable independent of that choice.)*

*Pin history.* An earlier revision of this section pinned commit `088a869d20fe577719175251588ae66b871d1cef`. The `v1.1.1` tag was subsequently re-created at `719827ce…` — same commit message, same committer timestamp, same root tree `c25f5fcac8d965d0a90021ce97fca54468961fe7` — which left `088a869…` off the repository's live history. Every object named in the content pin above is byte-identical across both commits, so no vector, verdict, or digest in this specification changed; only the ref did. The content pin is the response.

**Independent reproductions.** The gate has been reproduced green by independent receipt issuers — distinct codebases that import neither `vaaraio/vaara` nor each other — issuing their own signed receipts over the committed `generic` and `sui` settlement records and running the unmodified `_check_independent.py` against the pinned `v1.1.1` vectors. This is what makes the producer-agnostic property (§7) demonstrated rather than asserted:

- **agent-guard** — a standalone Rust execution-control runtime. Issued SEP-2828 receipts signed with its own ES256 key and reproduced every verdict to a full pass (exit `0`). It computes the `evidenceRef` digest with an independent Rust RFC 8785 implementation (`serde_jcs`) and reproduces the committed `sui/step1` digest byte-for-byte, confirming canonicalization is portable across languages and JCS implementations. Runnable artifact: <https://github.com/XuebinMa/agent-guard/tree/spike/sep2828-x402-recompute> (`spikes/sep2828-x402-recompute/`).
- **nobulex** — issued SEP-2828 receipts (`issuer://nobulex`, ES256, `rfc8785` end-to-end) over the same committed records and reproduced every verdict on both rails — `action_ref_recomputes`, `settlement_binding_resolves`, `receipt_signature_ok`, and `lifecycle_distinguishes_terminal` — against the unmodified checker with no `vaara` imports. Runnable artifact: <https://github.com/arian-gogani/nobulex/tree/64eb2c866ca5b331c43eadaf23d215cb1edbd509/tests/conformance/x402_settlement_v0> (ES256 keypair, all four receipts, settlement records unchanged from the `v1.1.1` pin, `expected.json`, and the checker — whose blob hash is byte-identical to the pinned `vaaraio/vaara` `_check_independent.py` — reproducible with `python3 _check_independent.py`).

**Reproduction against a live settlement.** Beyond the pinned fixtures, the gate has also been run against a *real* gasless Sui `exact` settlement produced end-to-end. An independent non-custodial facilitator (#2619) settled the `@x402/sui` gasless Address-Balance mechanism (#2616) on testnet (verify → settle), and the settled result was recomputed from on-chain `balanceChanges` alone: net `+10000` USDC to `payTo`, gasless (`gasData.price = 0`, empty `payment`, gas fully rebated), no gas noise in the asset delta. That settlement is packaged as a two-rail vector (`generic` + `sui`, in-progress → terminal) carrying the byte-identical `_check_independent.py` (blob `0669786…`); `python3 _check_independent.py` exits `0`. Runnable artifact: <https://github.com/DrVelvetFog/sui-x402-facilitator/tree/087df5232206ea8c5105ce58f6f42063315ca744/conformance/x402_settlement_v0_sui_gasless> (settlement digest `FVejSg9ddPYXwWtxjk58TjkZg6aawJFyynZEsTmsxRQ6`; fresh ES256 demo issuer key — per the non-goals a green result proves the receipt shape + binding over a real settlement record, not a live attestation instance).

Per the non-goals above, a green reproduction proves the receipt *shape* recomputes and binds; it does not bind `backLink` to a live attestation instance.

**6. Lifecycle (`seq` and `terminal`)**

The action tuple carries `seq` (monotonic) and `terminal` (boolean). Because both fields are inside the tuple, a non-terminal settlement and its terminal successor produce **distinct** `actionRef`s. A mid-task (non-terminal) receipt therefore cannot be presented where the final one is required: it does not resolve against the terminal settlement. A verifier tells "settled and action completed" from "settled and action still running" by which record the receipt binds to and whether its `terminal` flag is set. This distinction lives in the settlement records' `actionRef`s, not in the receipt issuer's record shape: the binding (§4) is evaluated per settlement step — each receipt resolves against exactly one settlement record — so a single decision-bearing record and a separately-signed decision+outcome pair are equally conformant.

**7. Rail-Agnostic Composition**

The join key is identical across rails — it is computed only from the action tuple (§3.2). Only the settlement-binding bytes differ (`paymentHash` for `generic`; the `settlement` object for `exact`). The committed vectors demonstrate this directly: the **same `actionRef`** appears on both the `generic` and `sui` rails at each lifecycle step; only the settlement bytes and the receipt's `evidenceRef.digest` change. For the receipt half, the producer-agnostic property is likewise a recompute — conformance is defined against the **`vaara.receipt/v1` conformance vectors** (pinned at `v1.1.1`; §5): an issuer is conformant when it reproduces the pinned `action_ref` bytes against those vectors, independent of implementation. Both properties are shown as tests, not asserted.

**8. Composition with Offer and Receipt**

The Offer and Receipt Extension proves the server cryptographically committed to the payment terms and returned a signed receipt — *the server asserted X*. This extension adds the recomputable settlement join — *X is what settled* — through `action_ref` + the settlement binding, with no operator trust. A deployment running both gains operator-independent, third-party-recomputable auditability over the full path from offer to settlement.

**9. Security Considerations**

- **Recomputability, not outcome.** The binding proves the settled-action record reproduces from committed bytes; it does **not** prove a downstream world-effect occurred. Implementations SHOULD keep "paid," "settled," "executed," and "observed" distinct and label any unobserved effect explicitly. Presenting a green result as outcome is disallowed normatively by the §5 presentation rules.
- **Signature authority is trusted, not recomputed.** `receipt_signature_ok` proves the receipt was signed by the key it names and that its signed bytes are intact — not that the signer was honest or authorized to issue it. Unlike `action_ref_recomputes` and `settlement_binding_resolves`, which a verifier reconstructs from committed public bytes, this verdict rests on trusting the issuer's key. For actions whose `action_ref` recomputes entirely from committed public data, that residual trust MAY be replaced by a proof the verifier recomputes (e.g. an on-chain-enforced commitment opening) — binding to such an enforcing anchor is a separate, out-of-scope extension, not implied here.
- **Not an independent finding.** Every signature in the bound pair is from a party to the transaction, so a green result is co-interested self-attestation that recomputes, not an outside audit. It MUST NOT be read as an independent finding about any party's conduct; an independent finding requires a signer that is not a party to the transaction (§5).
- **Assertion of time, not a bound on it.** `timestampMs` is issuer-asserted and lives inside the signed claim, so a green result does not establish when the record existed. Where "the record existed no later than T" is required, bind an outside-verifiable time the verifier resolves without trusting the issuer — the on-chain settlement time, or an RFC 3161-style timestamp token — rather than relying on `timestampMs` (§5).
- **Verification scope on privacy rails.** Net-balance assertion is only as sound as the facilitator's visibility. State who must be a stakeholder/observer for `verifiedBy` to be meaningful, and what a non-stakeholder verifier can independently check.
- **Canonicalization is the trust root.** Two producers MUST canonicalize identically (RFC 8785 over the normative field set) or the recompute fails closed. The reference vectors are the gate against drift.

**10. Privacy Considerations**

- The settlement record carries no personal data; amounts, addresses, and the settlement id are on-chain-public. The join key references the action, it does not embed payloads.
- Receipt result payloads SHOULD use the receipt format's commitment-only (hash-only-identity) projection so result data is committed to without being copied into the record.

**11. Version History**

- `v0` — initial draft. `generic` and `sui` (`exact`) rails, in-progress + terminal lifecycle steps, with a committed recompute suite as the conformance gate. Co-authored; receipt format per IETF `draft-sirkkavaara-vaara-receipt` (`vaara.receipt/v1`).
