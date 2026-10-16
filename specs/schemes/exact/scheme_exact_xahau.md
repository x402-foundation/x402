# Exact Payment Scheme for Xahau (`exact`)

This document specifies the `exact` payment scheme for the x402 protocol v2 on Xahau.

This scheme facilitates payments of a specific amount of XAH or an issued currency (IOU) on Xahau using a payer-signed `Payment` transaction.

## Scheme Name

`exact`

## Payment Model

| Aspect                    | Description                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Payment authorization** | The payer signs a Xahau `Payment` transaction                                 |
| **Settlement**            | The facilitator submits the signed transaction to Xahau                       |
| **Fee payer**             | The payer pays the Xahau transaction fee embedded in the signed transaction   |

Xahau charges the transaction fee to the transaction `Account`. This exact scheme therefore does not support facilitator-sponsored network fees for the signed `Payment` transaction. Supporting fee sponsorship would require a different payment model, not only a facilitator implementation change.

On Xahau the fee also covers the execution of strongly executed Hooks on the payer and destination accounts (see [Hooks](#hooks)). Clients SHOULD obtain the fee from the `fee` RPC with the unsigned `tx_blob` rather than using the base fee.

`PaymentRequirements.extra.areFeesSponsored` MUST be present and MUST be `false`.

## Asset Transfer Methods

A Xahau `Payment` can be sequenced by the payer account's normal `Sequence` number or by a pre-created Xahau Ticket (`TicketSequence`). This scheme supports both, selected via `extra.assetTransferMethod`:

| AssetTransferMethod  | Use Case                                                            | Recommendation                                               | Usage Semantics                                  |
| :------------------- | :------------------------------------------------------------------ | :----------------------------------------------------------- | :------------------------------------------------ |
| **`sequence`**       | Micropayments, low-balance wallets, resources that settle promptly | **Default** (no ticket reserve, no preflight transaction)    | One pending payment per payer account            |
| **`ticketSequence`** | Long-running resource handlers, concurrent pending payments        | **Strictest settlement safety** (requires ticket inventory)  | Multiple concurrent pending payments per account |

If no `assetTransferMethod` is specified in `PaymentRequired.extra`, clients SHOULD default to `"sequence"`. Payment payloads that use a non-default transfer method MUST echo the selected `assetTransferMethod` in `accepted.extra`. If `PaymentRequired.extra.assetTransferMethod` is present, the client MUST use the specified method. A resource server MAY offer both methods by listing multiple entries in `accepts` that differ only in `extra.assetTransferMethod`.

### Tradeoffs

`"sequence"` uses the payer account's normal, strictly ordered sequence number:

- No preflight transaction and no reserve: the payer only needs balance for the payment and the network fee, which suits low-balance micropayment wallets.
- The payer account is effectively serialized until the payment settles or expires: consuming the same sequence with any other transaction between `/verify` and `/settle` permanently invalidates the payment (`tefPAST_SEQ`) after the resource handler has already run.
- Facilitator sequence checks at `/verify` and `/settle` and client-side sequence locking reduce this race but do not eliminate it. This is a cooperative mitigation, not a protocol-level reservation.

`"ticketSequence"` uses a Xahau Ticket created ahead of time by the payer:

- The ticket reserves the payment's sequencing slot at the protocol level, so the payment cannot be invalidated by other account activity between `/verify` and `/settle`, and multiple payments can be pending concurrently (one ticket each).
- If no ticket is available, the client must first submit a `TicketCreate` transaction, adding one network fee and one transaction round trip before the payment request.
- Each outstanding ticket locks owner reserve (`0.2 XAH` on mainnet at the time of writing, subject to validator fee voting) until it is used or deleted. For a `0.01 XAH` payment this is roughly 20x the payment amount in temporarily locked liquidity, and an account can hold at most 250 outstanding tickets.

### Choosing a Method

- Resource servers that settle promptly after verification (for example, a fast database lookup) MAY accept `"sequence"` and MAY additionally offer `"ticketSequence"` for clients that want concurrent pending requests.
- Resource servers with long-running handlers SHOULD require `"ticketSequence"`, or accept `"sequence"` only if they explicitly accept the risk that settlement fails after the resource handler has run.

## Network Identifier (CAIP-2)

x402 v2 requires CAIP-2 network identifiers. For Xahau, the format is:

```text
xahau:{network_id}
```

Where `network_id` is the Xahau numeric NetworkID (`uint32`).

| Network | Identifier    |
| ------- | ------------- |
| Mainnet | `xahau:21337` |
| Testnet | `xahau:21338` |

Xahau networks have `networkId > 1024`, so the signed `NetworkID` field is mandatory and binds each transaction to a single network (see [Network Binding](#5-network-binding)).

## Protocol Flow

The protocol flow for `exact` on Xahau is client-driven.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a payment required signal containing `PaymentRequired` in the `PAYMENT-REQUIRED` header (base64-encoded JSON).
3. **Client** creates a `Payment` transaction to the resource server's Xahau address for the specified amount, sequenced according to the selected [asset transfer method](#asset-transfer-methods).
4. **Client** signs the transaction with their wallet, producing a fully signed transaction blob.
5. **Client** encodes the signed transaction as a hex string.
6. **Client** sends a new request to the resource server with the `PAYMENT-SIGNATURE` header containing the base64-encoded `PaymentPayload`.
7. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to a **Facilitator Server's** `/verify` endpoint.
8. **Facilitator** decodes the `signedTxBlob`, deserializes the proposed transaction, and validates it against the expected payment parameters.
9. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
10. **Resource Server**, upon successful verification, forwards the payload to the facilitator's `/settle` endpoint.
11. **Facilitator Server** re-runs verification and submits the signed transaction to the Xahau network identified by `paymentRequirements.network`.
12. Upon successful validated settlement, the **Facilitator Server** responds with a `SettlementResponse` to the **Resource Server**.
13. **Resource Server** grants the **Client** access to the resource via the `PAYMENT-RESPONSE` header.

## x402 v2 Headers

| Direction                   | Header              | Content                                 |
| --------------------------- | ------------------- | --------------------------------------- |
| Server -> Client (challenge) | `PAYMENT-REQUIRED`  | Base64-encoded JSON `PaymentRequired`   |
| Client -> Server (payment)   | `PAYMENT-SIGNATURE` | Base64-encoded JSON `PaymentPayload`    |
| Server -> Client (result)    | `PAYMENT-RESPONSE`  | Base64-encoded JSON settlement response |

Legacy header names (`X-PAYMENT`, `X-PAYMENT-RESPONSE`) are deprecated and SHOULD NOT be used for new integrations.

## `PaymentRequirements` for `exact`

The resource server advertises payment requirements in the `accepts` array.

### XAH (Native) Example

```json
{
  "scheme": "exact",
  "network": "xahau:21337",
  "asset": "XAH",
  "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
  "amount": "1000000",
  "maxTimeoutSeconds": 600,
  "extra": {
    "areFeesSponsored": false,
    "assetTransferMethod": "sequence",
    "invoiceId": "INV-2025-001"
  }
}
```

### IOU (Issued Currency) Example

```json
{
  "scheme": "exact",
  "network": "xahau:21337",
  "asset": "USD",
  "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
  "amount": "10.5",
  "maxTimeoutSeconds": 600,
  "extra": {
    "areFeesSponsored": false,
    "assetTransferMethod": "ticketSequence",
    "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
    "invoiceId": "INV-2025-002"
  }
}
```

### Field Definitions

| Field                    | Type    | Required | Description                                      |
| ------------------------ | ------- | -------- | ------------------------------------------------ |
| `scheme`                 | string  | Yes      | Must be `"exact"`                                |
| `network`                | string  | Yes      | CAIP-2 identifier (for example, `"xahau:21337"`) |
| `asset`                  | string  | Yes      | `"XAH"` for native XAH, or currency code for IOU |
| `payTo`                  | string  | Yes      | Xahau classic address receiving the payment       |
| `amount`                 | string  | Yes      | XAH drops string or IOU issued-currency value    |
| `maxTimeoutSeconds`      | integer | Yes      | Maximum validity window for payment attempt      |
| `extra.areFeesSponsored` | boolean | Yes      | Must be `false` for Xahau exact payments          |
| `extra.assetTransferMethod` | string | No     | `"sequence"` (default) or `"ticketSequence"`     |
| `extra.invoiceId`        | string  | No       | Unique invoice identifier for binding            |
| `extra.destinationTag`   | integer | No       | DestinationTag for hosted accounts               |
| `extra.issuer`           | string  | IOU only | Classic address of the IOU issuer                |

`extra.destinationTag` applies to both native XAH and IOU payments. It is used when the receiver is a hosted account or otherwise requires a destination tag for attribution.

`extra.areFeesSponsored` is always `false` because this scheme uses payer-signed Xahau `Payment` transactions whose fee is paid by the payer account.

`extra.assetTransferMethod` selects how the signed transaction is sequenced. See [Asset Transfer Methods](#asset-transfer-methods) for negotiation rules and tradeoffs.

No `extra.decimals` field is defined for Xahau exact payments. Implementations MUST NOT derive the signed transfer amount from server-provided decimal precision metadata.

### Asset Field Values

| Asset Type  | Format            | Example                                      |
| ----------- | ----------------- | -------------------------------------------- |
| Native XAH  | `"XAH"`           | `"XAH"`                                      |
| 3-char IOU  | 3-character code  | `"USD"`                                      |
| 160-bit IOU | 40 hex characters | `"5553444300000000000000000000000000000000"` |

## Amount Formatting

### XAH (Native)

For native XAH, `PaymentRequirements.amount` is a string containing integer drops. One XAH equals 1,000,000 drops.

| Human Amount | `amount` Value |
| ------------ | -------------- |
| 1 XAH        | `"1000000"`    |
| 0.1 XAH      | `"100000"`     |
| 0.000001 XAH | `"1"`          |

### IOU (Issued Currency)

For Xahau issued currencies, `PaymentRequirements.amount` is the exact Xahau issued-currency `value` string to be encoded in the destination amount object.

Xahau issued currencies are identified by `(currency, issuer)` and the ledger `Payment` amount uses a decimal `value` string. Xahau does not define a universal token-decimals field for arbitrary issued currencies, so this scheme does not accept server-declared decimal precision.

| Human Amount | `amount` Value | Xahau destination amount `value` |
| ------------ | -------------- | ------------------------------- |
| 10.50 USD    | `"10.5"`       | `"10.5"`                        |

The facilitator MUST compare IOU amounts using exact decimal arithmetic suitable for Xahau issued-currency values, not binary floating point.

## `PaymentPayload` for `exact`

The `PAYMENT-SIGNATURE` header contains a base64-encoded `PaymentPayload`.

### XAH Example

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "xahau:21337",
    "asset": "XAH",
    "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
    "amount": "1000000",
    "maxTimeoutSeconds": 600,
    "extra": {
      "areFeesSponsored": false,
      "assetTransferMethod": "sequence",
      "invoiceId": "INV-2025-001"
    }
  },
  "payload": {
    "signedTxBlob": "120000228000000024000000036840000000000000C732103AB40A0490F9B7ED8DF29D246BF2D6269820A0EE7742ACDD457BEA7C7D0931EDB74473045022100..."
  }
}
```

The XAH example uses `assetTransferMethod="sequence"`, so the signed blob carries the payer account's current `Sequence`.

### IOU Example

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "xahau:21337",
    "asset": "USD",
    "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
    "amount": "10.5",
    "maxTimeoutSeconds": 600,
    "extra": {
      "areFeesSponsored": false,
      "assetTransferMethod": "ticketSequence",
      "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
      "invoiceId": "INV-2025-002"
    }
  },
  "payload": {
    "signedTxBlob": "1200002280000000240000000020290000C3516840000000000000C732103AB40A0490F9B7ED8DF29D246BF2D6269820A0EE7742ACDD457BEA7C7D0931EDB74473045022100..."
  }
}
```

The IOU example uses `assetTransferMethod="ticketSequence"`, so the signed blob carries `Sequence = 0` and a `TicketSequence`.

### Payload Fields

| Field          | Type   | Required | Description                              |
| -------------- | ------ | -------- | ---------------------------------------- |
| `signedTxBlob` | string | Yes      | Hex-encoded signed Xahau transaction blob |

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`-scheme Xahau payment MUST enforce all of the following checks.

### 1. Envelope Checks (x402 v2)

The facilitator MUST reject if:

- `paymentPayload.x402Version != 2`
- `paymentPayload.accepted.scheme != "exact"`
- `paymentPayload.accepted.network` is unsupported
- `paymentPayload.accepted` does not match `paymentRequirements` on `scheme`, `network`, `asset`, `payTo`, `amount`, or `maxTimeoutSeconds`
- Required `extra` keys are missing or mismatched:
  - `areFeesSponsored=false`
  - `assetTransferMethod` when present in `paymentRequirements.extra` (the payload MUST NOT select a different method; when the requirement omits it, `accepted.extra.assetTransferMethod` MAY declare the selected method, see section 7)
  - `issuer` for IOU payments
  - `invoiceId` when invoice binding is required
  - `destinationTag` when destination tag binding is required

### 2. Transaction Decoding

- Decode `signedTxBlob` (hex) into bytes.
- Decode bytes using the Xahau binary codec (Xahau field definitions, not XRPL's) to obtain `tx_json`.
- If decoding fails, verification MUST fail.

### 3. Transaction Type

- `tx_json.TransactionType` MUST equal `"Payment"`.

### 4. Destination Validation

- `tx_json.Destination` MUST equal `paymentRequirements.payTo`.
- If `paymentRequirements.extra.destinationTag` is present, `tx_json.DestinationTag` MUST be present and equal.

### 5. Network Binding

Let `networkId` be the integer parsed from `paymentRequirements.network` (for example, `"xahau:21337"` -> `21337`).

| Condition           | Requirement                                |
| ------------------- | ------------------------------------------ |
| `networkId <= 1024` | `tx_json.NetworkID` MUST be omitted        |
| `networkId > 1024`  | `tx_json.NetworkID` MUST equal `networkId` |

These are xahaud protocol rules. All public Xahau networks have `networkId > 1024`, so the signed `NetworkID` binds the transaction to one network and a transaction signed for testnet cannot be replayed on mainnet (xahaud rejects it with `telWRONG_NETWORK`).

The facilitator MUST submit the transaction only to the Xahau network identified by `paymentRequirements.network`.

### 6. Amount Validation

The destination amount is `tx_json.Amount`. If it is missing, the facilitator MUST reject.

`DeliverMax` is the name xahaud's JSON API v2 uses for `Amount`; it is not a separate binary field. The signed blob only contains `Amount`, so decoding it with the Xahau binary codec always yields `Amount`.

#### XAH Amount Rules

If `paymentRequirements.asset == "XAH"`:

- Destination amount field MUST be a string of digits representing drops.
- `int(destinationAmount) == int(paymentRequirements.amount)`.
- `tx_json.SendMax` MUST be omitted.
- `tx_json.Paths` MUST be omitted.
- `tx_json.DeliverMin` MUST be omitted.

#### IOU Amount Rules

If `paymentRequirements.asset != "XAH"`:

- Destination amount field MUST be an issued-currency object:
  ```json
  { "currency": "...", "issuer": "...", "value": "..." }
  ```
- `currency` MUST match `paymentRequirements.asset` (3-char or 160-bit hex).
- `issuer` MUST match `paymentRequirements.extra.issuer`.
- `value` MUST equal `paymentRequirements.amount` using exact decimal arithmetic suitable for Xahau issued-currency values.

##### SendMax Policy (Required for IOU)

To prevent cross-currency behaviors while allowing issuer transfer fees:

- `tx_json.SendMax` MUST be present.
- `SendMax` MUST be the same issued currency (same `currency` and `issuer`).
- `Decimal(SendMax.value) >= Decimal(destinationAmount.value)`.

The facilitator MUST reject if:

- `Paths` is present.
- `DeliverMin` is present.
- `Flags` includes `tfPartialPayment` (`0x00020000`).

### 7. Expiry and Account Sequencing

- `tx_json.LastLedgerSequence` MUST be present.
- `LastLedgerSequence` MUST be no later than the facilitator's policy-derived maximum for `paymentRequirements.maxTimeoutSeconds`.

Determine the selected asset transfer method:

- If `paymentPayload.accepted.extra.assetTransferMethod` is present, it is the selected method.
- Else if `paymentRequirements.extra.assetTransferMethod` is present, it is the selected method.
- Else the selected method is `"sequence"`.

The facilitator MUST reject if the selected method is not `"sequence"` or `"ticketSequence"`, or if `paymentRequirements.extra.assetTransferMethod` is present and the selected method differs from it.

If the selected method is `"sequence"`:

- `tx_json.TicketSequence` MUST be absent.
- `tx_json.Sequence` MUST equal the current `Sequence` of `tx_json.Account` on the target network at verification time.
- Because `/settle` re-runs verification, a sequence consumed between `/verify` and `/settle` is detected before submission; the signed transaction is then permanently invalid and settlement MUST fail.

If the selected method is `"ticketSequence"`:

- `tx_json.Sequence` MUST be `0`.
- `tx_json.TicketSequence` MUST refer to an available ticket for `tx_json.Account`.

Recommended `LastLedgerSequence` policy:

- Convert `maxTimeoutSeconds` to ledgers: `maxLedgerDelta = ceil(maxTimeoutSeconds / 5) + 2`.
- Require: `LastLedgerSequence <= currentValidatedLedgerIndex + maxLedgerDelta`.

Client requirements per method:

- `"sequence"`: the client SHOULD NOT sign or submit any other transaction from the payer account until the payment settles or `LastLedgerSequence` has passed, and SHOULD keep at most one pending `"sequence"`-method payment per account. These are cooperative mitigations; the sequence is not reserved at the protocol level.
- `"ticketSequence"`: the client MUST create a ticket (`TicketCreate`) before signing if no available ticket exists, and SHOULD maintain enough available tickets for its expected number of concurrent pending payments.

### 8. Invoice Binding

If `paymentRequirements.extra.invoiceId` is present, the signed transaction MUST commit to that invoice using the canonical Xahau `InvoiceID` field.

The transaction includes:

- `InvoiceID = SHA-256(invoiceId)` as 32-byte hex (64 hex characters).
- Comparison is case-insensitive.

The facilitator MUST reject if `invoiceId` is present and `InvoiceID` is missing or mismatched. Memos MUST NOT be used for invoice binding.

### 9. Safety Checks (MUST)

The facilitator MUST reject transactions with:

- `Fee` above facilitator policy. Because the fee includes strong Hook execution, facilitators SHOULD size this policy for the Hooks installed on the destination accounts they serve.
- `Memos` present.
- `SendMax` present for XAH.
- `Paths` present.
- `DeliverMin` present.
- `Flags` including `tfPartialPayment` (`0x00020000`).
- `Amount` missing.

### 10. Signature Validation

- `/verify` MUST validate the signature offline.
- `/settle` MUST handle signature-related failures and report them appropriately.

### 11. Simulation

`/verify` MUST check that the signed transaction would currently succeed on Xahau. Implementations SHOULD use the xahaud `simulate` RPC, which accepts the transaction with its signature fields removed and returns the engine result without applying it. Any result other than `tesSUCCESS`, including `tecHOOK_REJECTED` and `telINSUF_FEE_P`, MUST fail verification.

If simulation is unavailable, implementations MUST perform targeted checks that cover at least:

- account existence for `tx_json.Account`;
- account sequence currency or ticket availability, according to the selected asset transfer method;
- XAH balance sufficient for the transaction fee;
- destination account existence or create-account funding rules for XAH payments;
- IOU trust line existence, issuer, and balance sufficiency for IOU payments.

## Hooks

Xahau accounts can install Hooks that run on transactions they are a party to. For a direct `Payment`, both the payer and the destination are strong transactional stakeholders, which means:

- Their Hooks execute before the transaction is applied and MAY roll it back (`tecHOOK_REJECTED`).
- Their execution fees are charged to the payer in `tx_json.Fee`.

Implications for this scheme:

- A Hook's decision can depend on Hook state that changes between `/verify` and `/settle`. A payment that passed simulation MAY still be rejected at settlement; `/settle` MUST treat that as a failed settlement. Resource servers that grant access before settlement accept this risk, as with `"sequence"` races.
- A transaction MAY carry top-level `HookParameters`, which Hooks read at runtime. They are covered by the payer's signature, and simulation runs with them, so the facilitator MUST NOT reject a payment solely because they are present.

## Settlement

Given verified `(paymentPayload, paymentRequirements)`, the facilitator:

1. Re-runs verification.
2. Rejects the settlement as a duplicate when the transaction hash is already pending settlement (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-required)).
3. Submits `signedTxBlob` to the Xahau network identified by `paymentRequirements.network`.
4. Waits for a validated result by polling `tx` until `validated=true`.
5. Treats settlement as successful only when the validated result is `tesSUCCESS`.
6. Returns the transaction hash and payer address.

### Fee Responsibility

The payer pays the Xahau transaction fee because:

- `Fee` is embedded in the signed transaction.
- Xahau charges fees to the transaction's `Account` field.
- The fee includes the execution of strongly executed Hooks on the payer and destination accounts.

### Settlement Timeout

The facilitator SHOULD wait for a validated result before returning success to prevent releasing resources for transactions that never validate.

### Duplicate Settlement Mitigation (REQUIRED)

#### Vulnerability

Without a dedup guard, concurrent `/settle` calls carrying the same signed transaction blob each return a successful response. Xahau deduplicates the ledger effect — only one payment lands — but reliable submission is an idempotent read keyed on the transaction hash: submitting an already-known blob and waiting for its hash resolves with the same validated `tesSUCCESS` outcome for every caller instead of failing for all but the first. A malicious client can exploit this to obtain access to the resource N times while paying once.

Unlike a probabilistic confirmation race, this behavior is deterministic on Xahau, so the mitigation is REQUIRED rather than RECOMMENDED.

#### Required Mitigation

Facilitators MUST deduplicate in-flight settlements across every process that serves `/settle`, keyed on the transaction hash. Before submitting a verified transaction:

1. After verification succeeds, derive the cache key from the signed transaction blob: the canonical Xahau transaction hash (as returned by, e.g., `hashSignedTx`).
2. If the key is already present, reject the settlement with a `"duplicate_settlement"` error.
3. If the key is not present, record it and proceed with submission.
4. Retain the key until its transaction can no longer land — that is, until its `LastLedgerSequence` has passed (bounded by `maxTimeoutSeconds`; see [§7. Expiry and Account Sequencing](#7-expiry-and-account-sequencing)). A shorter window reopens the race: while the transaction is still landable, a re-submission passes re-verification because the consumed sequence number — or ticket — is not yet consumed, so the entry MUST outlive that window rather than a fixed interval. (Solana's fixed ~60-90s blockhash lifetime lets its cache use a constant TTL; Xahau's expiry is policy-derived, so the retention window is too.)

The check and record MUST be performed atomically with respect to concurrent settlement requests. A single-process facilitator MAY satisfy this with an in-process map (checking and inserting synchronously between the verification result and the first subsequent suspension point); a horizontally scaled facilitator MUST use a shared store providing the same atomicity, otherwise duplicates routed to different replicas each pass their local guard.

Because the key is retained until the transaction expires rather than removed on completion, a re-submission of the same signed blob after a transient settlement failure is also rejected with `"duplicate_settlement"` within that window; `"duplicate_settlement"` therefore indicates the transaction was already seen, not that it settled successfully.

## `SettlementResponse`

On successful settlement, the `PAYMENT-RESPONSE` header contains:

```json
{
  "success": true,
  "transaction": "A1B2C3D4E5F6...",
  "network": "xahau:21337",
  "payer": "rPayer123..."
}
```

| Field         | Type    | Description                          |
| ------------- | ------- | ------------------------------------ |
| `success`     | boolean | Settlement success status            |
| `transaction` | string  | Xahau transaction hash (64 hex chars) |
| `network`     | string  | CAIP-2 network identifier            |
| `payer`       | string  | Payer's Xahau classic address         |

Implementations MAY include additional fields when defined by the SDK or facilitator API.

## Security Considerations

### Trust Minimization

- The facilitator cannot redirect funds because any mutation of the signed transaction invalidates the payer's signature.
- The resource server cannot collect more than the amount the payer signed for.
- When present, invoice binding commits the payer's transaction to a specific invoice.

### Replay and Race Protection

- `LastLedgerSequence` ensures transactions expire.
- With `assetTransferMethod="ticketSequence"`, the ticket reserves the payment's sequencing slot at the protocol level across the `/verify` -> resource handler -> `/settle` gap.
- With `assetTransferMethod="sequence"`, that gap is protected only cooperatively: the facilitator verifies the sequence is current at `/verify` and re-checks it at `/settle`, and clients avoid other transactions from the same account while the payment is pending. A payer that consumes the sequence elsewhere invalidates settlement after resource execution; resource servers that accept `"sequence"` accept this risk.
- The signed `NetworkID` binds the transaction to a single Xahau network.
- Concurrent `/settle` calls carrying the same signed blob are rejected through a settlement cache keyed on the transaction hash (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-required)).

### Hook Interaction

- Destination Hooks can reject a verified payment at settlement; see [Hooks](#hooks).
- `HookParameters` are allowed and covered by the payer's signature.

### Partial Payment Protection

- `tfPartialPayment` is explicitly rejected.
- `Paths` and `DeliverMin` are rejected.
- IOU payments require `SendMax` to match the destination currency and issuer.

## References

- [Xahau Payment Transaction](https://xahau.network/docs/protocol-reference/transactions/transaction-types/payment/)
- [Xahau Transaction Common Fields](https://xahau.network/docs/protocol-reference/transactions/transaction-common-fields/)
- [Xahau TicketCreate](https://xahau.network/docs/protocol-reference/transactions/transaction-types/ticketcreate/)
- [Xahau Currency Formats](https://xahau.network/docs/protocol-reference/data-types/currency-formats/)
- [Xahau Transaction Fees](https://xahau.network/docs/features/transaction-signing/transaction-fees/)
- [Hook Fees](https://xahau.network/docs/hooks/concepts/hook-fees/)
- [Weak and Strong Transactional Stakeholders](https://xahau.network/docs/hooks/concepts/weak-and-strong/)
- [Hook Parameters](https://xahau.network/docs/hooks/concepts/parameters/)
- [CAIP-2 Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
- [x402 Protocol Specification](../../x402-specification-v2.md)
