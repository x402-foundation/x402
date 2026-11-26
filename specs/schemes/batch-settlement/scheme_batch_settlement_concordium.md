# Scheme: `batch-settlement` on `Concordium`

## Summary

The `batch-settlement` scheme on Concordium is a **credit-backed** network binding in which **the seller underwrites** each tab (see [Trust Model](#trust-model)). The client's commitment is backed by an identity, not by locked capital, and no intermediary guarantees repayment.

Concordium ties every account to an identity checked by an identity provider, and lets a smart contract read the sender's identity policy. This binding uses that property. The owner of a buyer agent opens one credit line for the agent in the `tab_bureau` contract. The agent then opens a **tab** with each seller. It pays every request with an off-chain `VoucherV1`, signed by a session key that the line pins in Concordium's CIS-8 key registry. The seller answers each voucher with a signed `ReceiptV1`, so no request needs a chain transaction. Once per cycle the buyer sends one sponsored `tab_bureau.settleTab`. That transaction forwards exactly the CCD due to the seller's wallet and records the settlement in the same step.

A buyer that does not pay its tab can be proven in default on-chain from its own signed vouchers. From then on, every seller that reads the same `tab_bureau` refuses it.

The scheme supports **dynamic pricing**: the voucher authorizes `max_price`, and the receipt states the actual charge, at most `max_price`.

| | |
|---|---|
| **Scheme** | `batch-settlement` |
| **Networks** | `ccd:9dd9ca4d19e9393877d2c44b70f89acb` (mainnet), `ccd:4221332d34e1694168c2a0c0b3fd0f27` (testnet), as in [`scheme_exact_concordium.md`](../exact/scheme_exact_concordium.md#network-identifiers) |
| **Binding** | `extra.binding = "ccd-tab/v1"` |
| **Asset** | native CCD (`"CCD"`); amounts are microCCD (1 CCD = 1 000 000) as `u64` decimal strings |
| **Commitment** | `VoucherV1` per request; `CloseVoucherV1` per settlement |
| **Commitment identifier** | `commitmentId = SHA-256(VoucherV1 bytes)`, lowercase hex |
| **Trust model** | credit-backed, seller-underwritten |
| **Redemption** | by the buyer, once per cycle: one sponsored `tab_bureau.settleTab` that forwards the CCD atomically |
| **Voucher management** | by the resource server (seller); the facilitator holds no voucher state |

---

## Tab Lifecycle

### On-chain components

The binding uses three contracts:

- **CIS-8004 Agent Registry.** Buyer and seller are registered agents. Each has an owner account and an `agentWallet` account.
- **CIS-8 key registry.** An agent's owner binds an ed25519 **session key** to the owner account under namespace `ccdtab:session-v1`, key type `ed25519`. Session keys sign vouchers, receipts and closes; wallet keys never sign per request.
- **`tab_bureau`**, named by `extra.bureau` in every requirement. It records sellers, credit lines and tabs, verifies settlements and defaults, and answers the `check_spend` view. It holds no value between transactions: `settleTab` forwards the attached CCD in the same transaction, and every other entrypoint rejects a non-zero amount.

The parts of the `tab_bureau` interface that this binding relies on are listed in the [Appendix](#tab_bureau-interface).

### Credit line (once per buyer agent)

The buyer agent's owner sends `openLine`. The line pins the agent's buyer session key by its full CIS-8 key id, and sets the total limit, the limit per seller, the longest cycle and the expiry. Before it records the line, the contract checks that the sender owns the agent in the Agent Registry, that the sender owns the session key in CIS-8, the sender's identity policy, and that the owner is not flagged for an earlier default.

How a deployment decides that an owner may open a line (for example a zero-knowledge eligibility proof bound to the line's terms) is a policy of the `tab_bureau` deployment. It does not change anything a resource server or facilitator checks.

### Opening a tab (once per seller)

The buyer agent and the seller agent agree on a `TabAgreementV1` (see the [Appendix](#opening-a-tab)), and both session keys sign it. The agreement fixes the tab's `limit`, `cycle_ms`, `grace_ms`, `max_lanes` (1 to 16), the seller's wallet, the price schedule hash and the terms hash. The buyer's wallet then sends one `tab_bureau.openTab`; a deployment MAY sponsor its fee, outside this binding (see [Security Considerations](#security-considerations), item 9). The contract checks both signatures, both agents and both session keys, the seller's on-chain policy, and that the tab fits the line. It records the tab with `opened_at`, and snapshots the seller's wallet and session key.

The 402 response tells the buyer which bureau, which seller agent and which terms document the offer refers to (`extra`, below).

### Requests and vouchers

A tab has `max_lanes` independent **lanes**. Each lane carries at most one request without a receipt, so a tab runs up to `max_lanes` requests at once. For each request the buyer takes a free lane and signs the `VoucherV1` that continues that lane's last verified receipt:

- `seq` is the last receipt's `seq` + 1 (1 on an unused lane);
- `acked_cumulative` is the last receipt's `charged_cumulative` (0 on an unused lane);
- `prev_receipt_hash` is the SHA-256 of the last receipt (32 zero bytes on an unused lane);
- `max_price` is the requirement's `amount`;
- `request_hash` binds the request (see [Request binding](#request-binding));
- `issued_at` is the current time.

The seller serves the request and signs a `ReceiptV1` with `charged ≤ max_price` and `charged_cumulative = acked_cumulative + charged`. The buyer verifies the receipt against the response bytes before the lane moves on.

### Settlement (once per cycle)

Requests fall into cycles by their voucher's `issued_at`: cycle `c` is `[opened_at + c·cycle_ms, opened_at + (c+1)·cycle_ms)`. To settle, the buyer sends the seller a `CloseVoucherV1` that states every lane that is ahead of its on-chain record. The seller answers with a `CloseAckV1` when the close matches its receipts. The buyer's wallet then sends one sponsored `settleTab` that attaches exactly `total − settled_total` (see [Redemption](#redemption)).

### Default

A seller whose receipted charges stay unsettled past a cycle's grace period refuses new requests (`past_due`). Once the report window opens, the seller sends `reportDefault` with the buyer's own highest voucher per lane. The tab becomes Defaulted, and the line owner is flagged at every seller that reads the bureau. A later `settleTab` that covers the proven total cures the tab.

---

## 402 Response (PaymentRequirements)

The seller offers the tab in `accepts`. It MAY also offer `exact` ([`scheme_exact_concordium.md`](../exact/scheme_exact_concordium.md)) for clients without a tab.

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "https://api.example.com/v1/quote", "description": "Quote", "mimeType": "application/json" },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
      "asset": "CCD",
      "amount": "1000",
      "payTo": "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
      "maxTimeoutSeconds": 60,
      "extra": {
        "binding": "ccd-tab/v1",
        "bureau": { "index": "13064", "subindex": "0" },
        "sellerToken": "1311",
        "termsUrl": "https://api.example.com/.well-known/ccd-tab/terms",
        "maxPricePerCall": "1000"
      }
    }
  ]
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `asset` | string | yes | `"CCD"`. This binding settles native CCD only. |
| `amount` | string | yes | The most one request may charge, in microCCD. It becomes the voucher's `max_price`. |
| `payTo` | string | yes | The seller agent's `agentWallet` (base58check). Informative: a settlement always pays the tab's **snapshot** seller wallet, which `openTab` checked on-chain. |
| `maxTimeoutSeconds` | number | yes | 60. |
| `extra.binding` | string | yes | `"ccd-tab/v1"`. |
| `extra.bureau` | object | yes | The `tab_bureau` instance, `{ index, subindex }` as `u64` decimal strings. Every signed message names it. |
| `extra.sellerToken` | string | yes | The seller agent's CIS-8004 token id, `u64` decimal. |
| `extra.termsUrl` | string | yes | The seller's terms document. Its SHA-256 is the `terms_hash` of every agreement with this seller. |
| `extra.maxPricePerCall` | string | yes | Equal to `amount`. |
| `extra.corrective` | object | corrective 402 only | See [Corrective 402](#corrective-402). |

`resource.url` and `termsUrl` use the seller's public origin, not a private proxy address, so that a client can match them to the origin it dialled.

A client without an open tab with this seller opens one (see [Opening a tab](#opening-a-tab)) or pays with `exact`.

---

## Client: Payment Construction

### Commitment: `VoucherV1`

The commitment for one request is the 172-byte `VoucherV1`. Integers are little-endian; see [Byte conventions](#byte-conventions).

```
VoucherV1 ::= "CCD-TAB/v1/voucher"        18 bytes, domain tag
              genesis: Hash               32   chain genesis hash
              bureau: ContractAddress     16   index u64 ‖ subindex u64
              tab_id: u64                  8
              lane: u16                    2   0 <= lane < max_lanes
              seq: u64                     8   1, 2, 3, ... per lane
              acked_cumulative: Amount     8   the lane's total from receipts 1..seq-1
              max_price: Amount            8   the most this request may charge
              request_hash: Hash          32   see Request binding
              prev_receipt_hash: Hash     32   SHA-256 of ReceiptV1 for seq-1; zero when seq = 1
              issued_at: Timestamp         8   ms since the Unix epoch
```

The buyer's session key signs these bytes with ed25519 (RFC 8032), with no prefix and no pre-hash.

Before it signs, the buyer's signer MUST check that `seq` continues the lane, and that the tab total stays within `settled_total + limit`. It MUST persist the lane's position durably before it releases the signature, so that it never signs two different vouchers for the same `(tab_id, lane, seq)`, except to replace a voucher the seller refused before admission (see [Refusals](#refusals)).

### Request binding

`request_hash = SHA-256(method ‖ " " ‖ path-and-query ‖ "\n" ‖ body)`, where `method` is the HTTP method as sent (for example `GET`), `path-and-query` is the request target as sent (for example `/v1/quote?i=1`), and `body` is the exact request body bytes (empty for `GET`).

A voucher can therefore be spent only with the seller of its tab (`tab_id` names an on-chain agreement with one seller), only for the request it names (`request_hash`), and only on one chain and bureau (`genesis`, `bureau`). The domain tag keeps it from being replayed as any other message of this binding.

A server behind a proxy MUST compute `request_hash` over the method, path and query that the client sent.

### Payment payload

`PAYMENT-SIGNATURE` carries the standard v2 `PaymentPayload`. `accepted` is the accept the client chose, copied from the 402 without `extra.corrective`.

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/v1/quote", "description": "Quote", "mimeType": "application/json" },
  "accepted": {
    "scheme": "batch-settlement",
    "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
    "asset": "CCD",
    "amount": "1000",
    "payTo": "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
    "maxTimeoutSeconds": 60,
    "extra": {
      "binding": "ccd-tab/v1",
      "bureau": { "index": "13064", "subindex": "0" },
      "sellerToken": "1311",
      "termsUrl": "https://api.example.com/.well-known/ccd-tab/terms",
      "maxPricePerCall": "1000"
    }
  },
  "payload": {
    "tabId": "2",
    "lane": 0,
    "voucher": "<hex(VoucherV1), 344 characters>",
    "sig": "<hex(ed25519 signature), 128 characters>"
  }
}
```

| Field | Type | Description |
|---|---|---|
| `payload.tabId` | string | `u64` decimal; MUST equal the voucher's `tab_id`. |
| `payload.lane` | number | MUST equal the voucher's `lane`. |
| `payload.voucher` | string | Lowercase hex of the `VoucherV1` bytes. |
| `payload.sig` | string | Lowercase hex of the 64-byte signature. |

Requests SHOULD carry `accept-encoding: identity`, because the receipt hashes the response body exactly as sent.

---

## Server: Verification, Storage and Receipts

The seller owns all per-tab state. Its store is authoritative, and the facilitator holds no voucher state. Only the seller can admit a voucher, because lane continuity and idempotency depend on its own receipts.

### Verification rules

The seller MUST check each voucher in this order and refuse at the first failure, with the code in parentheses.

1. **Shape.** The payload parses strictly, and `tabId` and `lane` match the voucher (`malformed_payment`). The scheme is `batch-settlement` (`unsupported_scheme`) and the network is the seller's (`wrong_network`).
2. **Domain.** `genesis` and `bureau` are the seller's (`wrong_domain`).
3. **Request binding.** `request_hash` matches the request as received, over the raw body bytes (`request_hash_mismatch`).
4. **Idempotency.** If `commitmentId` is already stored with a receipt, the seller returns the stored receipt (and the stored response, when it kept one) and charges nothing again. The same voucher with a different signature is `voucher_conflict`. A voucher still being served is `voucher_in_flight`, unless it has been in flight for more than 120 s; the seller then serves it again.
5. **Freshness.** `|now − issued_at| ≤ 120 s` (`voucher_stale`).
6. **The tab.** `tabOf(tab_id)` exists (`unknown_tab`) and is with this seller's token (`wrong_seller`). `lane < max_lanes` (`lane_out_of_range`), and `issued_at ≥ opened_at` (`voucher_stale`).
7. **The pinned session key.** The signature verifies over the voucher bytes under `lineOf(tab.line_id).session_key`, which MUST be namespace `ccdtab:session-v1`, key type `ed25519`, 32 bytes (`key_not_bound`, `bad_signature`).
8. **Price.** `max_price ≥ amount` (`max_price_too_low`).
9. **Standing.** `check_spend(tab_id, 0)` is Go (the NoGo reason, in snake_case). A seller MAY cache the answer for at most 30 s, and MUST drop the cache when it sees a finalized `tab_bureau` event for the tab or its line.
10. **Lane continuity**, under a lock per tab. Another request in flight on the lane is `lane_busy`. Otherwise `seq` MUST be the last receipted `seq` + 1, `acked_cumulative` the last receipt's `charged_cumulative`, and `prev_receipt_hash` the SHA-256 of the last receipt (`lane_out_of_sync`, a [corrective 402](#corrective-402)).
11. **Past due.** The latest cycle whose grace has passed (`now > end(c) + grace_ms`) MUST have no receipted charges that `settled_total` leaves uncovered (`past_due`).
12. **Limit.** `amount_after` = the receipted totals of all lanes + the prices of requests in flight on other lanes + `amount`. `check_spend(tab_id, amount_after)` MUST be Go, which means `amount_after − settled_total ≤ limit` (`over_limit`).

The seller then stores the voucher as in flight and serves the request.

### Storage and the commitment identifier

- **`commitmentId = SHA-256(VoucherV1 bytes)`**, over the whole encoded voucher, domain tag included. It is the receipt's `voucher_hash` and the `commitmentId` of the payment response.
- **Idempotency by `commitmentId` is normative.** A seller MUST store every admitted voucher under its `commitmentId`, uniquely, and also uniquely by `(tab_id, lane, seq)`. A repeated voucher MUST get the original receipt back and MUST NOT be charged twice. A voucher in flight MUST NOT be served twice at once.
- The store keeps, per request: the voucher and its signature (the default evidence), the receipt and its signature, the time it was claimed, the price reserved, and the response when it is small enough to replay.
- **Every admitted request gets a receipt**, also when the handler fails (charged 0), so the buyer's lane moves on. A request in flight for more than 120 s is stale: a replay of the same voucher serves it again, and a different voucher on that lane first closes the stale request with a zero-charge receipt. A stale request no longer counts against the limit.

### Receipts: `ReceiptV1`

The seller's session key signs the 172-byte `ReceiptV1`:

```
ReceiptV1 ::= "CCD-TAB/v1/receipt"        18 bytes, domain tag
              genesis: Hash               32
              bureau: ContractAddress     16
              tab_id: u64                  8
              lane: u16                    2
              seq: u64                     8
              voucher_hash: Hash          32   commitmentId of the voucher this answers
              response_hash: Hash         32   SHA-256 of the response body as sent
              charged: Amount              8   <= the voucher's max_price
              charged_cumulative: Amount   8   the voucher's acked_cumulative + charged
              issued_at: Timestamp         8
```

`charged` is the actual price of the request. It MAY be lower than `amount` (dynamic pricing).

### Payment response

The response to a paid request carries `PAYMENT-RESPONSE` with a `SettleResponse`. No value moves per request, so `transaction` and `amount` are empty, as in the EVM binding's voucher-only response. `extra` carries the commitment identifier and the signed receipt:

```json
{
  "success": true,
  "transaction": "",
  "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  "amount": "",
  "extra": {
    "commitmentId": "<hex(SHA-256(VoucherV1)), 64 characters>",
    "charged": "750",
    "receipt": "<hex(ReceiptV1), 344 characters>",
    "sig": "<hex(ed25519 signature), 128 characters>"
  }
}
```

When a replayed voucher's stored response cannot be sent back byte for byte, the seller adds `"retained": false` to `extra` and sends a `response_not_retained` notice as the body. The receipt then binds a body the client did not receive.

### Client verification rules

Before a lane moves on, the client MUST check that:

1. the receipt decodes, and has the voucher's `genesis`, `bureau`, `tab_id`, `lane` and `seq`;
2. `voucher_hash = commitmentId` of the voucher it sent;
3. `charged ≤ max_price` and `charged_cumulative = acked_cumulative + charged`;
4. `response_hash` is the SHA-256 of the response body as received, unless `extra.retained` is `false`;
5. the signature verifies under the tab's snapshot seller key (`tabOf(tab_id).seller_key`);
6. `commitmentId` and `charged` in `extra` agree with the receipt.

A receipt that fails any check leaves the lane blocked until the client resyncs it from a seller-signed receipt.

### Refusals

A refused voucher is answered with `402`, a `PAYMENT-REQUIRED` header whose `error` is the code, and the body `{ "error": "<code>" }`. A payload whose `accepted` matches no offer is refused with the core error for an unmatched requirement.

Every refusal except `voucher_in_flight` happens **before admission**: the voucher is not on the seller's books, so the client rewinds its lane to the last verified receipt and MAY sign that `seq` again. `voucher_in_flight` means the seller holds the voucher. A response with neither a receipt nor a refusal (for example a handler failure after admission, or a lost response) leaves the client unsure whether the seller booked the voucher. The client then blocks the lane until it resyncs it, or sends the same voucher again for the same request, which the seller answers idempotently.

### Corrective 402

`lane_out_of_sync` carries the seller-signed receipt of the voucher's lane, so a client that lost state can resync. The seller adds it to the `batch-settlement` accept as `extra.corrective`, as the EVM binding does with `extra.channelState`:

```json
{
  "binding": "ccd-tab/v1",
  "bureau": { "index": "13064", "subindex": "0" },
  "sellerToken": "1311",
  "termsUrl": "https://api.example.com/.well-known/ccd-tab/terms",
  "maxPricePerCall": "1000",
  "corrective": {
    "tabId": "2",
    "lanes": [{ "lane": 0, "seq": "8", "receipt": "<hex(ReceiptV1)>", "sig": "<hex(seller signature)>" }]
  }
}
```

A seller MAY add `voucher` and `voucherSig` to a lane entry: the `VoucherV1` the receipt answers and the buyer's signature over it. Clients MUST ignore lane fields they do not use.

The client checks the lane receipt: it decodes, has the tab's domain, tab and lane, `seq ≥ 1`, and is signed by the tab's seller key. It then moves its lane, and its signer's lane, to that receipt. The signer MUST accept only a receipt for a voucher it signed, so a seller cannot inflate a lane. The client retries once with the next voucher.

---

## Facilitator Interface

The facilitator implements the standard `/supported`, `/verify` and `/settle`. It never receives voucher state, and no value moves per request. Its role in this binding is to verify vouchers statelessly on request and to submit redemptions. It is never called per request in the flow above.

### GET /supported

```json
{
  "x402Version": 2,
  "scheme": "batch-settlement",
  "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  "extra": { "binding": "ccd-tab/v1", "bureau": { "index": "13064", "subindex": "0" } }
}
```

`signers["ccd:*"]` lists the sponsor accounts that pay the fee of redemptions. A resource server MUST check that the kind names its binding and bureau instance.

### POST /verify

- **Voucher payload.** The facilitator runs the checks that need no seller receipts: verification rules 1, 2, 5, 6, 7 and 8, and `check_spend(tab_id, acked_cumulative + amount)` as a lower bound of rule 12. A valid answer has `payer`, the line's buyer wallet (or its owner), and `extra = { commitmentId, tabId, lane, seq }`. **A valid answer is not admission.** Request binding, idempotency, lane continuity and past due need the seller's store, so a resource server MUST run them itself, and SHOULD verify vouchers locally.
- **Redemption payload.** The same checks as `/settle` below, without submitting.

### POST /settle

`/settle` never settles a voucher (`invalid_payload_type`). It settles a **redemption**:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement",
    "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
    "asset": "CCD",
    "amount": "400000",
    "payTo": "4FmiTW2L4RvCsSVTjFAavYvrgnPLGNj43eiwPYmbhNqtAcMbWW",
    "maxTimeoutSeconds": 300,
    "extra": { "binding": "ccd-tab/v1", "bureau": { "index": "13064", "subindex": "0" } }
  },
  "payload": { "type": "redeem", "tabId": "2", "transaction": "<hex(serialized AccountTransactionV1)>" }
}
```

`transaction` is the lowercase hex of a serialized version 1 (sponsored) account transaction: an `UpdateContract` of `tab_bureau.settleTab` whose parameter is `SettleTabParams`. The buyer wallet signs it as sender, and it names the facilitator's sponsor with no sponsor signature yet. Before it co-signs, the facilitator MUST check that:

1. the transaction deserializes as a version 1 `UpdateContract` (`invalid_transaction`);
2. the entrypoint is `tab_bureau.settleTab` (`entrypoint_not_allowed`) on the bureau in `extra` (`wrong_instance`), and the transaction names one of this facilitator's sponsor accounts (`not_sponsored`);
3. the close's `tab_id` is the payload's `tabId` (`tab_id_mismatch`), and its `genesis` and `bureau` match (`wrong_domain`);
4. the attached amount is non-zero (`nothing_due`) and equals `amount` (`amount_mismatch`);
5. `payTo` is `tabOf(tab_id).seller_wallet` (`payto_not_seller_wallet`);
6. the amount equals the sum, over all lanes, of the larger of the recorded and stated `charged_cumulative`, minus `settled_total` (`total_mismatch`, `amount_mismatch`).

It then adds its sponsor signature, submits the transaction and waits for finalization:

```json
{
  "success": true,
  "transaction": "<hex(transaction hash), 64 characters>",
  "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  "payer": "<buyer wallet, base58check>",
  "amount": "400000",
  "extra": { "tabId": "2", "blockHash": "<hex(block hash), 64 characters>" }
}
```

A redemption that was submitted but is not yet finalized is answered with `success: false`, `errorReason: "settlement_pending"` and the transaction hash in `transaction` (the non-terminal pending state). Sending the same request again MUST be idempotent: the facilitator keys submissions by transaction hash and resumes waiting.

---

## Redemption

- **Who and when.** The **buyer** triggers redemption, once per cycle or when it chooses, within the windows of [Commitment expiry](#commitment-expiry). Its wallet (the line's `buyer_wallet`, or the owner) sends one `tab_bureau.settleTab`, sponsored by the facilitator.
- **What.**
  1. The buyer signs a `CloseVoucherV1` that states every lane ahead of its on-chain record and `total`, the sum over all lanes ever used of the larger of the recorded and stated `charged_cumulative`.
  2. It posts `{ "close": "<hex(CloseVoucherV1)>", "sig": "<hex>" }` to the seller's `POST <origin>/tab/<tab_id>/close`. The seller answers `{ "ack": "<hex(CloseAckV1)>", "sig": "<hex>" }` when the close states exactly its receipts for vouchers issued before the end of the named cycle. Otherwise it answers `409 close_mismatch` with its signed lane receipts.
  3. The buyer attaches exactly `total − settled_total` to `settleTab(close, buyer_sig, ack_sig)`. A missing ack never blocks the payment: the settlement is recorded as not acknowledged.
- **Rail.** Native CCD, in the same transaction. `settleTab` checks the close, records the lanes, the total and the cycle, and sends exactly the attached amount to the tab's **snapshot** seller wallet. The contract holds nothing afterwards, and the payment and its record cannot diverge. It emits `TabSettled { tab_id, cycle, on_time, acked }`.
- **Cycle rules.** The close names the current cycle or the one before it, and no cycle earlier than the last settlement named. A settlement is on time in cycle 0, within `grace_ms` after the start of the current cycle, or when the tab already had an on-time settlement in this cycle. After it signs the close of cycle `c`, the buyer's signer SHOULD sign no more vouchers dated in cycle `c`.

```
LaneState ::= lane: u16                   2
              seq: u64                    8   highest receipted seq on this lane
              charged_cumulative: Amount  8   that receipt's charged_cumulative
              last_receipt_hash: Hash    32

CloseVoucherV1 ::= "CCD-TAB/v1/close"     16 bytes, domain tag
                   genesis: Hash          32
                   bureau: ContractAddress 16
                   tab_id: u64             8
                   cycle: u32              4
                   lane_count: u16         2
                   lanes: LaneState^lane_count   strictly increasing lane numbers, 50 bytes each
                   total: Amount           8
                   issued_at: Timestamp    8

CloseAckV1 ::= "CCD-TAB/v1/close-ack"     20 bytes, domain tag
               genesis: Hash              32
               bureau: ContractAddress    16
               tab_id: u64                 8
               cycle: u32                  4   the close's cycle
               close_hash: Hash           32   SHA-256 of the CloseVoucherV1 bytes
               issued_at: Timestamp        8   the close's issued_at

SettleTabParams ::= close: CloseVoucherV1 without its domain tag
                    buyer_sig: Signature              64   by the buyer session key, over CloseVoucherV1
                    ack_sig: Option<Signature>             by the seller session key, over CloseAckV1
```

The buyer signs `CloseVoucherV1` with its session key; the seller signs `CloseAckV1` with its session key. `settleTab` rebuilds the ack from the close, so a seller that signs any other `cycle` or `issued_at` produces an ack the contract cannot verify. The tag `"CCD-TAB/v1/close"` is a prefix of `"CCD-TAB/v1/close-ack"`; the two stay apart because the next byte is the first byte of the genesis hash (never `-`), because the lengths differ, and because different keys sign them.

---

## Double-spend Prevention

- **Per request, off-chain.** `commitmentId` is unique in the seller's store, and so is `(tab_id, lane, seq)`. A repeated voucher gets the stored receipt and is never charged twice. A lane carries at most one request without a receipt. The seller accepts a voucher only when it continues the lane exactly (`seq`, `acked_cumulative`, `prev_receipt_hash`), so lane totals only grow and every receipt chains to the previous one.
- **Client side.** The signer persists each lane's position durably before it releases a signature. It never signs a `seq` twice, except to rewind to its last verified receipt after a refusal before admission. It never signs past `settled_total + limit`.
- **On-chain.** `settleTab` requires each stated lane's `seq` and `charged_cumulative` to be at least the recorded values. `total` must be the recomputed sum, and the attached amount exactly `total − settled_total > 0`. `settled_total` only grows, so a receipted charge can be paid only once. `reportDefault` proves at most `settled_total + limit`, and only more than both `settled_total` and the last reported total, so the same evidence cannot be reported twice. Agreement hashes are single-use.

---

## Commitment Expiry

- **Acceptance.** A seller accepts a voucher only within 120 s of `issued_at` (either way) and not before the tab opened. A voucher that is not accepted is void: the client rewinds the lane and the next voucher reuses the `seq`.
- **Redeemable.** The receipted charges of cycle `c` are redeemable by a `settleTab` naming `c` during cycle `c` or `c+1`. They are on time until `end(c) + grace_ms`. After that, the seller refuses new requests on the tab (`past_due`) until `settled_total` covers them; the buyer can still pay.
- **Default evidence.** From `end(c) + grace_ms + settle_window_ms`, the seller may report cycle `c` with the buyer's highest voucher per lane issued in `[opened_at, end(c)]`, at most 16. The vouchers prove the sum over lanes of the larger of the recorded `charged_cumulative` and the voucher's `acked_cumulative`, capped at `settled_total + limit`. The seller may keep reporting later cycles while the tab stays Defaulted. A `settleTab` that brings `settled_total` to the reported total cures the tab.
- **End of the tab.** A tab ends with its line's `valid_until`. New credit stops at the first `check_spend` after the buyer's session key is revoked or displaced in CIS-8. A close requested by the buyer completes only after the seller had a full window to report the last cycle that can hold debt.

---

## Trust Model

The generic scheme defines two commitment models. This binding is credit-backed in the generic sense: no capital is locked, and the commitment is backed by a verified identity. But **no intermediary underwrites the access obligation, and nobody guarantees repayment.** The seller underwrites each tab itself. This binding therefore answers item 7 of the network requirements with a **seller-underwritten** credit profile. Instead of a guarantee, the seller has:

- **Bounded exposure that the seller sets.** The seller signs the tab's `limit` and cycle in the agreement, within its own on-chain policy: the largest tab, the minimum buyer tier, the cycle bounds and a daily budget of new tabs. Its receipted but unsettled charges never exceed `limit`, because `check_spend` counts requests in flight and a past-due tab gets no service. The line caps the buyer's total exposure across sellers.
- **Proof, and a freeze at every seller.** The buyer's own signed vouchers prove a default on-chain, with no seller testimony. The default flags the line owner, and `check_spend` then answers `owner_defaulted` for the owner's other tabs. The bureau refuses new lines and tabs for the owner until the default is cured, the flag is cleared after review, or the flag expires (a deployment parameter). This holds at every seller that reads the same bureau.
- **An accountable identity.** Every line is opened by the owner of a registered agent, from an account that a Concordium identity provider has verified, under the bureau's identity policy. Accountable is not endorsed: an identity does not show that its owner will pay, and one person can hold several accounts.
- **Atomic settlement.** Payment and record are one transaction. The CCD reaches the snapshot seller wallet in the same `settleTab`, with no witness and nothing held by the contract.

Like every `batch-settlement` binding, the seller delivers before value moves. Here that risk is explicit and priced by the seller: there is no escrow to withdraw from under it, and the remedy is the default proof and the freeze above, bounded by the limit.

---

## Error Codes

Codes are bare snake_case.

| Code | Where | Meaning |
|---|---|---|
| `malformed_payment` | server, facilitator | the payload is not this binding's |
| `unsupported_scheme`, `wrong_network` | server, facilitator | another scheme or network |
| `wrong_domain` | server, facilitator | another genesis or bureau |
| `request_hash_mismatch` | server | the voucher binds another request |
| `voucher_stale` | server, facilitator | `issued_at` outside 120 s, or before the tab opened |
| `unknown_tab`, `wrong_seller`, `lane_out_of_range` | server, facilitator | the tab is unknown, with another seller, or has no such lane |
| `key_not_bound`, `bad_signature` | server, facilitator | not signed by the line's pinned session key |
| `max_price_too_low` | server, facilitator | `max_price < amount` |
| `tab_not_active`, `line_not_active`, `line_expired`, `owner_defaulted`, `registry_changed`, `agent_revoked`, `owner_changed`, `key_revoked_or_displaced`, `seller_not_active`, `over_limit` | server, facilitator | `check_spend` NoGo reasons |
| `lane_out_of_sync` | server | corrective: the voucher does not continue its lane |
| `lane_busy`, `voucher_in_flight`, `voucher_conflict` | server | concurrency on a lane or a commitment |
| `past_due` | server | a finished cycle is unsettled past its grace |
| `response_not_retained`, `receipt_unavailable`, `chain_unavailable` | server | availability |
| `close_mismatch` | server | the close does not match the seller's receipts |
| `accepted_mismatch` | facilitator | the payload's `accepted` names another scheme or network than the requirement |
| `invalid_payload_type` | facilitator | `/settle` of a voucher |
| `invalid_redeem_payload`, `invalid_transaction`, `entrypoint_not_allowed`, `wrong_instance`, `not_sponsored`, `tab_id_mismatch` | facilitator | the redemption is not a sponsored `settleTab` of this tab |
| `nothing_due`, `amount_mismatch`, `total_mismatch`, `payto_not_seller_wallet`, `tab_not_found` | facilitator | the amount or payee is not what the contract would accept |
| `settlement_pending` | facilitator | submitted, not yet finalized; **non-terminal**, carries `transaction` |

---

## Security Considerations

1. **Replay prevention.** A voucher is single-use by construction. Its `commitmentId` is unique in the seller's store, so a replay gets the original receipt and no new charge. Its lane position `(tab_id, lane, seq)` is taken once, and `issued_at` must be within 120 s. Domain tags keep one message kind from being replayed as another; `genesis` and `bureau` keep a message to one chain and one contract instance. On-chain, settlements only move `settled_total` up, and agreements are single-use.
2. **Authorization scope.** A voucher authorizes one request (`request_hash`) to one seller (the tab's on-chain agreement) for at most `max_price`. The seller's charge must continue the lane's cumulative total. The buyer's signer caps the exposure per tab at `settled_total + limit`, and the line caps it across sellers.
3. **Settlement atomicity.** `settleTab` records the settlement and forwards exactly the attached CCD to the snapshot seller wallet in one transaction. If the transfer fails, the whole call is rejected, so payment and record cannot diverge.
4. **Concurrent double execution.** A voucher is claimed in the store before the handler runs. A concurrent copy gets `voucher_in_flight` and is not served twice.
5. **Response integrity.** The receipt binds `response_hash` over the bytes as sent, and the client checks it before it builds on the lane. Content coding is disabled (`accept-encoding: identity`) so the bytes do not change in transit.
6. **Lost state.** A client resyncs only from seller-signed receipts, and its signer accepts only a receipt for a voucher it signed. A seller that loses receipts loses those charges: the buyer's vouchers prove only `acked_cumulative`.
7. **Hot session key.** Anything the session key signed before it was revoked binds the line up to its limits. A provable default is capped at `settled_total + limit` per tab.
8. **Clocks.** On time comes from block time. Past due and default evidence are dated by the seller from its receipts and the buyer's `issued_at`.
9. **Facilitator scope.** Through `/settle`, the facilitator co-signs only a `settleTab` of the bureau it serves, naming one of its sponsor accounts, with an attached amount that equals what the contract will accept and a payee that is the tab's snapshot seller wallet. Sponsoring the out-of-band `openTab`, or any other bureau call, is a separate deployment policy outside this binding, with its own allow-list and limits.

---

## Appendix

### Network requirements

How this binding answers the seven requirements of the generic scheme:

| # | Requirement | Section |
|---|---|---|
| 1 | Commitment format | [`VoucherV1`](#commitment-voucherv1), [Payment payload](#payment-payload), `CloseVoucherV1` in [Redemption](#redemption) |
| 2 | Verification rules | [Verification rules](#verification-rules): the pinned CIS-8 session key, lane continuity, freshness, `check_spend` |
| 3 | Storage behavior and commitment identifier | [Storage](#storage-and-the-commitment-identifier): `commitmentId = SHA-256(VoucherV1)`; idempotency by `commitmentId` is normative |
| 4 | Double-spend prevention | [Double-spend Prevention](#double-spend-prevention) |
| 5 | Commitment expiry | [Commitment Expiry](#commitment-expiry) |
| 6 | Redemption | [Redemption](#redemption): the buyer, one sponsored `settleTab` per cycle |
| 7 | Trust model | [Trust Model](#trust-model): seller-underwritten credit |

### Byte conventions

- Integers are little-endian: `u16`, `u32`, `u64`. **Amount** is a `u64` count of microCCD. **Timestamp** is a `u64` count of milliseconds since the Unix epoch.
- **Hash** is 32 bytes (SHA-256). **ContractAddress** is `index: u64 ‖ subindex: u64`. **AccountAddress** is 32 bytes.
- **Signature** is a 64-byte ed25519 signature (R ‖ S) over the exact message bytes, with no prefix. **Option<T>** is the byte `0`, or the byte `1` followed by `T`.
- Domain tags are ASCII bytes with no length prefix.
- The network id is `ccd:` followed by the first 16 bytes of `genesis`, in hex.

### Opening a tab

Tabs are opened out of band of the x402 exchange. This section is what a client needs to open one with a seller.

```
TabAgreementV1 ::= "CCD-TAB/v1/tab"            14 bytes, domain tag
                   genesis: Hash
                   bureau: ContractAddress
                   line_id: u64
                   seller_token: AgentTokenId      the byte 8, then the token id as u64
                   seller_wallet: AccountAddress   the seller agent's wallet
                   limit: Amount
                   cycle_ms: u64
                   grace_ms: u64                   <= cycle_ms
                   max_lanes: u16                  1..=16
                   price_schedule_hash: Hash       must match the seller's on-chain policy
                   terms_hash: Hash                SHA-256 of the document at extra.termsUrl
                   handshake_hash: Hash
                   nonce: u64
                   expiry: Timestamp               openTab must land before this
```

The seller serves `POST <origin>/.well-known/ccd-tab/handshake`. The buyer sends a `hello` signed by its session key, which names its line, its proposed `limit`, `cycle_ms` and `max_lanes`, the seller's agent, and the exact URL it dialled, and is valid for at most 60 s. The seller checks the buyer's line and standing, and answers with the `TabAgreementV1` signed by its own session key. The messages are JSON canonicalized with RFC 8785, signed over `"CCD-TAB/v1/hello" ‖ JCS(body)` and `"CCD-TAB/v1/accept" ‖ JCS(body)`, and `handshake_hash` binds both. The buyer signs the agreement too, and sends `openTab(agreement, buyer_sig, seller_sig)`.

### `tab_bureau` interface

This binding relies on these parts of the contract:

- **`check_spend(tab_id: u64, amount_after: Amount) -> (0) Go | (1) NoGo(reason: u8)`.** `amount_after` is the tab's cumulative charged total over all lanes after the request. Reasons, in check order: 1 `TabNotActive`, 2 `LineNotActive`, 3 `LineExpired`, 4 `OwnerDefaulted`, 11 `RegistryChanged`, 5 `AgentRevoked`, 6 `OwnerChanged`, 7 `KeyRevokedOrDisplaced`, 8 `SellerNotActive`, 9 `OverLimit` (`amount_after − settled_total > limit`). It re-reads both agents in the Agent Registry and the buyer's key in CIS-8. Past due is decided by the seller, from its receipts.
- **`tabOf(u64) -> Option<Tab>`**, with these fields: `line_id`, `seller_token`, `seller_owner`, `seller_wallet` (snapshot; settlements pay it), `seller_key` (snapshot of the seller session key), `limit`, `cycle_ms`, `grace_ms`, `settle_window_ms`, `max_lanes`, `opened_at`, `lanes: Vec<(seq, charged_cumulative)>`, `settled_total`, the last settlement, `reported_total` and `status` (Active, Defaulted, Closed).
- **`lineOf(u64) -> Option<Line>`**, with `buyer_token`, `owner`, `buyer_wallet: Option<AccountAddress>`, `session_key` (the pinned CIS-8 key id), the limits, `valid_until` and `status`.
- **`settleTab(SettleTabParams)`**, payable, as in [Redemption](#redemption). It rejects a close that regresses a lane, a `total` that is not the recomputed sum, an attached amount other than `total − settled_total`, and a cycle out of range.
- **`reportDefault`**, as in [Commitment Expiry](#commitment-expiry).

The views return these records in the contract's state layout, which the reference implementation documents field by field.

### Test vectors

A `VoucherV1` with the testnet genesis, bureau `<13042,0>`, tab 0, lane 0, `seq` 1, `max_price` 1 000 000, `request_hash` `3fd35306…64a5a5`, a zero `prev_receipt_hash` and `issued_at` 1795521601000:

| | |
|---|---|
| bytes | `4343442d5441422f76312f766f75636865724221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796f2320000000000000000000000000000000000000000000000000100000000000000000000000000000040420f00000000003fd35306eba5fece42d6a1be4d1d58abd1f46b5a7bcc09ac915f15019664a5a50000000000000000000000000000000000000000000000000000000000000000e85d6d0da2010000` |
| `commitmentId` | `3a66464c37d606dbd2335c1ca423476f940b91e5e165518a676fd1f0c56d14f6` |
| public key | `8f2c1b035d6c2b62088158e27f4e7c6905dc5ac32471ad0ed9b47fbb4f3c00ea` |
| signature | `173c80fbb6e611d962f6d62e09c8aae2250d46e84b92d44438b88695c71a3d3a8770427adcdf50568a5f91a87935ee076aef1a3db3ba86bc2713ebaab9e3b20c` |

Its `ReceiptV1`, charging 750 000 with `response_hash` `3d378d21…ad40ee` and `issued_at` 1795521601200:

| | |
|---|---|
| bytes | `4343442d5441422f76312f726563656970744221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796f23200000000000000000000000000000000000000000000000001000000000000003a66464c37d606dbd2335c1ca423476f940b91e5e165518a676fd1f0c56d14f63d378d2165b6bdd03b38eec377f6351b5c67f754191952706f7fb9fa55ad40eeb0710b0000000000b0710b0000000000b05e6d0da2010000` |
| hash | `0a0e4ba169a739df3058c65ab17901ad0b5f9b527fd6a5283d8e58c8c52d21bb` |
| public key | `b527f919534e25107201a67acc6a4a57ef432ada33ad0ce527f69a37d6706f38` |
| signature | `841d521a15653f4a49a3b94e0dd57a373b05433d66bc1001119f1fb10b3279d7a060f0e6611f1539a57095742c4838432fd91101244b12a2c94f68165c5a920a` |

The ed25519 seeds are test-only and must never hold value: `13b4b313f0da5d5385fde19cee13a8f09c23fb11da1cb7198afe75804555a4a6` (buyer) and `35b2681c029b5e8e69bb158657e4f6b2c7dfb9aecb4437360ffe0386f9b26094` (seller). The reference implementation has two cases of every message, including `CloseVoucherV1` and `CloseAckV1`.

### Deployments

`tab_bureau` is deployed on testnet at `<13064,0>`. It is not deployed on mainnet. Each requirement names its instance in `extra.bureau`, so a resource server can use any deployment that implements the interface above.

### Reference implementation

[OpenTab](https://github.com/OoJae/opentab) implements this binding: the `tab_bureau` contract, the client, seller and facilitator, and the golden vectors that the contract tests generate.

### Related work

- [#2051](https://github.com/x402-foundation/x402/pull/2051) added the generic `batch-settlement` scheme and its EVM binding, whose voucher-only response, dynamic pricing and corrective state this binding follows.
- [#2612](https://github.com/x402-foundation/x402/pull/2612) proposes a credit-backed binding with an intermediary. Like this binding, it makes idempotency normative and requires audience and resource binding.
- [#3464](https://github.com/x402-foundation/x402/issues/3464) discusses service delivered before a voucher is protected on-chain; [Trust Model](#trust-model) states how this binding bounds that risk.

### Version History

| Version | Date | Changes |
|---|---|---|
| v0.1 | 2026-11-26 | Initial draft |
