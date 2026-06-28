# Settlement-Receipt Binding Extension

**1. Overview**

This extension binds an x402 **settlement** to a server-side **signed execution receipt** so that an independent party can recompute the link from committed bytes alone — with no trust in the operator's logs.

It composes with the [Offer and Receipt Extension](./extension-offer-and-receipt.md): Offer and Receipt proves *the server asserted X*; this extension proves *X is what settled*, recomputably, through a content-addressed join. That is the half the auditability and dispute-evidence use cases are missing.

The receipt format is defined externally — the Model Context Protocol's **SEP-2828, "Server-Side Signed Execution Record for MCP Tool Calls."** This extension does **not** redefine the receipt. It specifies the **x402 settlement record** a receipt commits to, the **content-addressed join key** (`action_ref`), and the **`exact`-scheme settlement semantics**, so the two sides bind cleanly and verify offline.

The join is **rail-agnostic by construction**: the join key is computed only from the authorized-action tuple and never reaches into settlement internals, so the same receipt binds to a settlement on an EVM token or a non-EVM facilitator alike.

A reference conformance suite — committed `generic` and `sui` vectors plus an independent checker that imports neither x402 nor the receipt framework (standard library + RFC 8785 JCS + ES256) — is the normative gate. **The recompute is the test.**

**2. Status, Evolution, and Forward Compatibility**

Draft (`v0`). Composes with the Offer and Receipt Extension. Receipt format: SEP-2828 (MCP). Implementations MUST treat unknown top-level settlement-record fields as opaque and preserve them under canonicalization. The conformance vectors are versioned alongside this document; a schema bump (`x402.settlement*/v1`) accompanies any change to the canonical field set.

**3. The Settlement Record**

The resource server (or its facilitator) emits a **settlement record**: a JSON object that names the authorized action and binds it to the on-chain settlement. A SEP-2828 receipt commits to this record (§4).

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

**4. Binding a Receipt to the Settlement**

A SEP-2828 receipt commits to the settlement record through a content-addressed evidence reference inside `decisionDerived.evidenceRef`, using the SEP-2787/SEP-2828 content-addressed commitment shape:

| `evidenceRef` field | Value                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| `canonicalization`  | `"JCS"`                                                                                |
| `digest`            | `sha256:<hex>` over the **JCS-canonical settlement record** (the whole object of §3).  |
| `ref`               | `x402:action_ref/<actionRef>` — a stable, human-legible pointer to the join key.      |
| `schema`            | Echoes the settlement record's `schema`.                                               |

The receipt is signed per SEP-2828 (ES256/RS256/HS256, detached signature over the JCS body excluding `signature`). This extension defines only what the receipt's evidence reference points at and how its digest is computed; the receipt's decision/outcome structure and pairing are SEP-2828's.

**5. Recompute (Conformance Gate)**

An independent party holding only the settlement record and the receipt MUST be able to confirm, offline and with no operator trust:

- **`action_ref_recomputes`** — `sha256(JCS(action tuple))` equals `settlement.actionRef`.
- **`settlement_binding_resolves`** — `sha256(JCS(settlement record))` equals `receipt.decisionDerived.evidenceRef.digest`, and `evidenceRef.canonicalization == "JCS"`.
- **`receipt_signature_ok`** — the receipt's signature verifies over its canonical signed blocks (SEP-2828).
- **`lifecycle_distinguishes_terminal`** — the in-progress (`terminal=false`) and terminal (`terminal=true`) steps have distinct `actionRef`s, and the in-progress receipt does not resolve against the terminal settlement (§6).

A normative reference suite implements these verdicts across two rails (`generic`, `sui`) and two lifecycle steps (in-progress, terminal), with a checker that imports neither x402 nor the receipt framework — standard library plus a JCS library and an ES256 verifier. A conformant implementation reproduces every verdict against the committed vectors byte-for-byte.

**Scope of the gate (non-goals).** Passing these verdicts proves the receipt *shape* recomputes and binds: the `action_ref` derives, the settlement digest resolves, the signature verifies, and the lifecycle steps are distinct. It does **not** prove that `backLink` resolves to a live attestation instance — the checker treats `backLink` and `issuerAsserted` as issuer-populated and does not dereference them. Binding a receipt to an actual upstream execution-attestation instance is a separate property, out of scope for this gate and not implied by a green result.

The conformance vectors and checker are pinned to an immutable commit:

- Repository: `vaaraio/vaara`, tag `v1.1.1`, commit `088a869d20fe577719175251588ae66b871d1cef`
- Path: `tests/vectors/x402_settlement_v0/` (rails `generic` + `sui`, steps `step0` + `step1`, plus `_check_independent.py` and `expected.json`)
- Permalink: <https://github.com/vaaraio/vaara/tree/088a869d20fe577719175251588ae66b871d1cef/tests/vectors/x402_settlement_v0>

`_check_independent.py` imports only the standard library plus a JCS library (`rfc8785`) and an ES256 verifier (`cryptography`) — no x402 and no receipt-framework import — and exits `0` only when every verdict matches `expected.json`. *(The pin is reconfirmed with the receipt-side author before merge; a vector update is accompanied by a schema version bump per §2.)*

**Independent reproductions.** The gate has been reproduced green by independent receipt issuers — distinct codebases that import neither `vaaraio/vaara` nor each other — issuing their own signed receipts over the committed `generic` and `sui` settlement records and running the unmodified `_check_independent.py` against the pinned `v1.1.1` vectors. This is what makes the producer-agnostic property (§7) demonstrated rather than asserted:

- **agent-guard** — a standalone Rust execution-control runtime. Issued SEP-2828 receipts signed with its own ES256 key and reproduced every verdict to a full pass (exit `0`). It computes the `evidenceRef` digest with an independent Rust RFC 8785 implementation (`serde_jcs`) and reproduces the committed `sui/step1` digest byte-for-byte, confirming canonicalization is portable across languages and JCS implementations. Runnable artifact: <https://github.com/XuebinMa/agent-guard/tree/spike/sep2828-x402-recompute> (`spikes/sep2828-x402-recompute/`).
- **nobulex** — issued SEP-2828 receipts (`issuer://nobulex`, ES256, `rfc8785` end-to-end) over the same committed records and reproduced every verdict on both rails — `action_ref_recomputes`, `settlement_binding_resolves`, `receipt_signature_ok`, and `lifecycle_distinguishes_terminal` — against the unmodified checker with no `vaara` imports. Runnable artifact: <https://github.com/arian-gogani/nobulex/tree/64eb2c866ca5b331c43eadaf23d215cb1edbd509/tests/conformance/x402_settlement_v0> (ES256 keypair, all four receipts, settlement records unchanged from the `v1.1.1` pin, `expected.json`, and the checker — whose blob hash is byte-identical to the pinned `vaaraio/vaara` `_check_independent.py` — reproducible with `python3 _check_independent.py`).

Per the non-goals above, a green reproduction proves the receipt *shape* recomputes and binds; it does not bind `backLink` to a live attestation instance.

**6. Lifecycle (`seq` and `terminal`)**

The action tuple carries `seq` (monotonic) and `terminal` (boolean). Because both fields are inside the tuple, a non-terminal settlement and its terminal successor produce **distinct** `actionRef`s. A mid-task (non-terminal) receipt therefore cannot be presented where the final one is required: it does not resolve against the terminal settlement. A verifier tells "settled and action completed" from "settled and action still running" by which record the receipt binds to and whether its `terminal` flag is set. This distinction lives in the settlement records' `actionRef`s, not in the receipt issuer's record shape: the binding (§4) is evaluated per settlement step — each receipt resolves against exactly one settlement record — so a single decision-bearing record and a separately-signed decision+outcome pair are equally conformant.

**7. Rail-Agnostic Composition**

The join key is identical across rails — it is computed only from the action tuple (§3.2). Only the settlement-binding bytes differ (`paymentHash` for `generic`; the `settlement` object for `exact`). The committed vectors demonstrate this directly: the **same `actionRef`** appears on both the `generic` and `sui` rails at each lifecycle step; only the settlement bytes and the receipt's `evidenceRef.digest` change. The property is shown as a test, not asserted.

**8. Composition with Offer and Receipt**

The Offer and Receipt Extension proves the server cryptographically committed to the payment terms and returned a signed receipt — *the server asserted X*. This extension adds the recomputable settlement join — *X is what settled* — through `action_ref` + the settlement binding, with no operator trust. A deployment running both gains operator-independent, third-party-recomputable auditability over the full path from offer to settlement.

**9. Security Considerations**

- **Recomputability, not outcome.** The binding proves the settled-action record reproduces from committed bytes; it does **not** prove a downstream world-effect occurred. Implementations SHOULD keep "paid," "settled," "executed," and "observed" distinct and label any unobserved effect explicitly.
- **Verification scope on privacy rails.** Net-balance assertion is only as sound as the facilitator's visibility. State who must be a stakeholder/observer for `verifiedBy` to be meaningful, and what a non-stakeholder verifier can independently check.
- **Canonicalization is the trust root.** Two producers MUST canonicalize identically (RFC 8785 over the normative field set) or the recompute fails closed. The reference vectors are the gate against drift.

**10. Privacy Considerations**

- The settlement record carries no personal data; amounts, addresses, and the settlement id are on-chain-public. The join key references the action, it does not embed payloads.
- Receipt result payloads SHOULD use SEP-2828's commitment-only (hash-only-identity) projection so result data is committed to without being copied into the record.

**11. Version History**

- `v0` — initial draft. `generic` and `sui` (`exact`) rails, in-progress + terminal lifecycle steps, with a committed recompute suite as the conformance gate. Co-authored; receipt format per SEP-2828.
