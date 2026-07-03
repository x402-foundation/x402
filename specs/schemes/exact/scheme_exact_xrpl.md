# Exact Payment Scheme for XRP Ledger (XRPL) (`exact`)

This document specifies the `exact` payment scheme for the x402 protocol v2 on the XRP Ledger.

This scheme facilitates payments of a specific amount of XRP or an issued currency (IOU) on the XRP Ledger using a payer-signed `Payment` transaction.

## Scheme Name

`exact`

## Payment Model

| Aspect                    | Description                                                                  |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Payment authorization** | The payer signs a standard XRPL `Payment` transaction                        |
| **Settlement**            | The facilitator submits the signed transaction to XRPL                       |
| **Fee payer**             | The payer pays the XRPL transaction fee embedded in the signed transaction   |

XRPL charges the transaction fee to the transaction `Account`. This exact scheme therefore does not support facilitator-sponsored network fees for the signed `Payment` transaction. Supporting fee sponsorship would require a different payment model, not only a facilitator implementation change.

`PaymentRequirements.extra.areFeesSponsored` MUST be present and MUST be `false`.

## Asset Transfer Methods

An XRPL `Payment` can be sequenced by the payer account's normal `Sequence` number or by a pre-created XRPL Ticket (`TicketSequence`). This scheme supports both, selected via `extra.assetTransferMethod`:

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

`"ticketSequence"` uses an XRPL Ticket created ahead of time by the payer:

- The ticket reserves the payment's sequencing slot at the protocol level, so the payment cannot be invalidated by other account activity between `/verify` and `/settle`, and multiple payments can be pending concurrently (one ticket each).
- If no ticket is available, the client must first submit a `TicketCreate` transaction, adding one network fee and one transaction round trip before the payment request.
- Each outstanding ticket locks owner reserve (currently `0.2 XRP` on mainnet, subject to validator fee voting) until it is used or deleted. For a `0.01 XRP` payment this is roughly 20x the payment amount in temporarily locked liquidity, and an account can hold at most 250 outstanding tickets.

### Choosing a Method

- Resource servers that settle promptly after verification (for example, a fast database lookup) MAY accept `"sequence"` and MAY additionally offer `"ticketSequence"` for clients that want concurrent pending requests.
- Resource servers with long-running handlers SHOULD require `"ticketSequence"`, or accept `"sequence"` only if they explicitly accept the risk that settlement fails after the resource handler has run.

## Network Identifier (CAIP-2)

x402 v2 requires CAIP-2 network identifiers. For XRPL, the format is:

```text
xrpl:{network_id}
```

Where `network_id` is the XRPL numeric NetworkID (`uint32`).

Common XRPL network identifiers:

| Network | Identifier |
| ------- | ---------- |
| Mainnet | `xrpl:0`   |
| Testnet | `xrpl:1`   |
| Devnet  | `xrpl:2`   |

> [!WARNING]
> For standard XRPL networks where `networkId <= 1024`, XRPL protocol rules require omitting the signed `NetworkID` field. Wallets SHOULD use separate XRPL accounts for mainnet, testnet, and devnet x402 payments. If the same account has funds and a compatible account sequence or ticket state on multiple standard networks, a malicious or misconfigured facilitator could replay a transaction signed for one network on another.

## Protocol Flow

The protocol flow for `exact` on XRPL is client-driven.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a payment required signal containing `PaymentRequired` in the `PAYMENT-REQUIRED` header (base64-encoded JSON).
3. **Client** creates a `Payment` transaction to the resource server's XRPL address for the specified amount, sequenced according to the selected [asset transfer method](#asset-transfer-methods).
4. **Client** signs the transaction with their wallet, producing a fully signed transaction blob.
5. **Client** encodes the signed transaction as a hex string.
6. **Client** sends a new request to the resource server with the `PAYMENT-SIGNATURE` header containing the base64-encoded `PaymentPayload`.
7. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to a **Facilitator Server's** `/verify` endpoint.
8. **Facilitator** decodes the `signedTxBlob`, deserializes the proposed transaction, and validates it against the expected payment parameters.
9. **Facilitator** returns a `VerifyResponse` to the **Resource Server**.
10. **Resource Server**, upon successful verification, forwards the payload to the facilitator's `/settle` endpoint.
11. **Facilitator Server** re-runs verification and submits the signed transaction to the XRPL network identified by `paymentRequirements.network`.
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

### XRP (Native) Example

```json
{
  "scheme": "exact",
  "network": "xrpl:0",
  "asset": "XRP",
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
  "network": "xrpl:0",
  "asset": "524C555344000000000000000000000000000000",
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
| `network`                | string  | Yes      | CAIP-2 identifier (for example, `"xrpl:0"`)      |
| `asset`                  | string  | Yes      | `"XRP"` for native XRP, or currency code for IOU |
| `payTo`                  | string  | Yes      | XRPL classic address receiving the payment       |
| `amount`                 | string  | Yes      | XRP drops string or IOU issued-currency value    |
| `maxTimeoutSeconds`      | integer | Yes      | Maximum validity window for payment attempt      |
| `extra.areFeesSponsored` | boolean | Yes      | Must be `false` for XRPL exact payments          |
| `extra.assetTransferMethod` | string | No     | `"sequence"` (default) or `"ticketSequence"`     |
| `extra.invoiceId`        | string  | No       | Unique invoice identifier for binding            |
| `extra.destinationTag`   | integer | No       | DestinationTag for hosted accounts               |
| `extra.issuer`           | string  | IOU only | Classic address of the IOU issuer                |

`extra.destinationTag` applies to both native XRP and IOU payments. It is used when the receiver is a hosted account or otherwise requires a destination tag for attribution.

`extra.areFeesSponsored` is always `false` because this scheme uses payer-signed XRPL `Payment` transactions whose fee is paid by the payer account.

`extra.assetTransferMethod` selects how the signed transaction is sequenced. See [Asset Transfer Methods](#asset-transfer-methods) for negotiation rules and tradeoffs.

No `extra.decimals` field is defined for XRPL exact payments. Implementations MUST NOT derive the signed transfer amount from server-provided decimal precision metadata.

### Asset Field Values

| Asset Type  | Format            | Example                                      |
| ----------- | ----------------- | -------------------------------------------- |
| Native XRP  | `"XRP"`           | `"XRP"`                                      |
| 3-char IOU  | 3-character code  | `"USD"`                                      |
| 160-bit IOU | 40 hex characters | `"524C555344000000000000000000000000000000"` |

## Amount Formatting

### XRP (Native)

For native XRP, `PaymentRequirements.amount` is a string containing integer drops. One XRP equals 1,000,000 drops.

| Human Amount | `amount` Value |
| ------------ | -------------- |
| 1 XRP        | `"1000000"`    |
| 0.1 XRP      | `"100000"`     |
| 0.000001 XRP | `"1"`          |

### IOU (Issued Currency)

For XRPL issued currencies, `PaymentRequirements.amount` is the exact XRPL issued-currency `value` string to be encoded in the destination amount object.

XRPL issued currencies are identified by `(currency, issuer)` and the ledger `Payment` amount uses a decimal `value` string. XRPL does not define a universal token-decimals field for arbitrary issued currencies, so this scheme does not accept server-declared decimal precision.

| Human Amount | `amount` Value | XRPL destination amount `value` |
| ------------ | -------------- | ------------------------------- |
| 10.50 USD    | `"10.5"`       | `"10.5"`                        |
| 0.01 RLUSD   | `"0.01"`       | `"0.01"`                        |

The facilitator MUST compare IOU amounts using exact decimal arithmetic suitable for XRPL issued-currency values, not binary floating point.

## `PaymentPayload` for `exact`

The `PAYMENT-SIGNATURE` header contains a base64-encoded `PaymentPayload`.

### XRP Example

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "xrpl:0",
    "asset": "XRP",
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

The XRP example uses `assetTransferMethod="sequence"`, so the signed blob carries the payer account's current `Sequence`.

### IOU Example

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "xrpl:0",
    "asset": "524C555344000000000000000000000000000000",
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
| `signedTxBlob` | string | Yes      | Hex-encoded signed XRPL transaction blob |

## Facilitator Verification Rules (MUST)

A facilitator verifying an `exact`-scheme XRPL payment MUST enforce all of the following checks.

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
- Decode bytes using the XRPL binary codec to obtain `tx_json`.
- If decoding fails, verification MUST fail.

### 3. Transaction Type

- `tx_json.TransactionType` MUST equal `"Payment"`.

### 4. Destination Validation

- `tx_json.Destination` MUST equal `paymentRequirements.payTo`.
- If `paymentRequirements.extra.destinationTag` is present, `tx_json.DestinationTag` MUST be present and equal.

### 5. Network Binding

Let `networkId` be the integer parsed from `paymentRequirements.network` (for example, `"xrpl:1"` -> `1`).

| Condition           | Requirement                                |
| ------------------- | ------------------------------------------ |
| `networkId <= 1024` | `tx_json.NetworkID` MUST be omitted        |
| `networkId > 1024`  | `tx_json.NetworkID` MUST equal `networkId` |

For XRPL mainnet, testnet, devnet, and other standard networks with `networkId <= 1024`, `NetworkID` is omitted by XRPL protocol rules. This omission is a transaction-format requirement, not a standalone cryptographic replay guarantee between standard XRPL networks.

For `networkId <= 1024`, the facilitator MUST submit the transaction only to the XRPL network identified by `paymentRequirements.network`. For custom XRPL networks with `networkId > 1024`, the signed `NetworkID` field provides explicit network binding.

Clients and wallets SHOULD use different XRPL accounts for mainnet, testnet, devnet, and other standard networks. If one account has funds and a compatible account sequence or ticket state on more than one standard network, a malicious or misconfigured facilitator could replay a transaction intended for one standard network on another standard network where the signed `NetworkID` field is also omitted.

### 6. Amount Validation

XRPL API v2 uses `DeliverMax`; API v1 uses `Amount`. The facilitator MUST determine the destination amount field:

- If `tx_json.DeliverMax` is present, use it.
- Else use `tx_json.Amount`.
- If neither is present, reject.
- If both are present, reject.

#### XRP Amount Rules

If `paymentRequirements.asset == "XRP"`:

- Destination amount field MUST be a string of digits representing drops.
- `int(destinationAmount) == int(paymentRequirements.amount)`.
- `tx_json.SendMax` MUST be omitted.
- `tx_json.Paths` MUST be omitted.
- `tx_json.DeliverMin` MUST be omitted.

#### IOU Amount Rules

If `paymentRequirements.asset != "XRP"`:

- Destination amount field MUST be an issued-currency object:
  ```json
  { "currency": "...", "issuer": "...", "value": "..." }
  ```
- `currency` MUST match `paymentRequirements.asset` (3-char or 160-bit hex).
- `issuer` MUST match `paymentRequirements.extra.issuer`.
- `value` MUST equal `paymentRequirements.amount` using exact decimal arithmetic suitable for XRPL issued-currency values.

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

If `paymentRequirements.extra.invoiceId` is present, the signed transaction MUST commit to that invoice using the canonical XRPL `InvoiceID` field.

The transaction includes:

- `InvoiceID = SHA-256(invoiceId)` as 32-byte hex (64 hex characters).
- Comparison is case-insensitive.

The facilitator MUST reject if `invoiceId` is present and `InvoiceID` is missing or mismatched. Memos MUST NOT be used for invoice binding.

### 9. Safety Checks (MUST)

The facilitator MUST reject transactions with:

- `Fee` above facilitator policy.
- `Delegate` present.
- `Memos` present.
- `SendMax` present for XRP.
- `Paths` present.
- `DeliverMin` present.
- `Flags` including `tfPartialPayment` (`0x00020000`).
- Both `Amount` and `DeliverMax` present.
- Neither `Amount` nor `DeliverMax` present.

### 10. Signature Validation

- `/verify` MUST validate the signature offline.
- `/settle` MUST handle signature-related failures and report them appropriately.

### 11. Simulation

`/verify` MUST check that the signed transaction would currently succeed on XRPL. Implementations SHOULD use XRPL transaction simulation when available.

If simulation is unavailable, implementations MUST perform targeted checks that cover at least:

- account existence for `tx_json.Account`;
- account sequence currency or ticket availability, according to the selected asset transfer method;
- XRP balance sufficient for the transaction fee;
- destination account existence or create-account funding rules for XRP payments;
- IOU trust line existence, issuer, and balance sufficiency for IOU payments.

## Settlement

Given verified `(paymentPayload, paymentRequirements)`, the facilitator:

1. Re-runs verification.
2. Submits `signedTxBlob` to the XRPL network identified by `paymentRequirements.network`.
3. Waits for a validated result by polling `tx` until `validated=true`.
4. Treats settlement as successful only when the validated result is `tesSUCCESS`.
5. Returns the transaction hash and payer address.

### Fee Responsibility

The payer pays the XRPL transaction fee because:

- `Fee` is embedded in the signed transaction.
- XRPL charges fees to the transaction's `Account` field.
- `Delegate` is not supported by this scheme.

### Settlement Timeout

The facilitator SHOULD wait for a validated result before returning success to prevent releasing resources for transactions that never validate.

## `SettlementResponse`

On successful settlement, the `PAYMENT-RESPONSE` header contains:

```json
{
  "success": true,
  "transaction": "A1B2C3D4E5F6...",
  "network": "xrpl:0",
  "payer": "rPayer123..."
}
```

| Field         | Type    | Description                          |
| ------------- | ------- | ------------------------------------ |
| `success`     | boolean | Settlement success status            |
| `transaction` | string  | XRPL transaction hash (64 hex chars) |
| `network`     | string  | CAIP-2 network identifier            |
| `payer`       | string  | Payer's XRPL classic address         |

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
- `NetworkID` provides signed network binding only for XRPL networks with `networkId > 1024`; standard XRPL networks require facilitators to route strictly by `paymentRequirements.network`.
- Clients SHOULD use different XRPL accounts for standard networks such as mainnet and testnet to reduce replay risk when `NetworkID` must be omitted.

### Partial Payment Protection

- `tfPartialPayment` is explicitly rejected.
- `Paths` and `DeliverMin` are rejected.
- IOU payments require `SendMax` to match the destination currency and issuer.

## References

- [XRPL Payment Transaction](https://xrpl.org/docs/references/protocol/transactions/types/payment)
- [XRPL Transaction Common Fields](https://xrpl.org/docs/references/protocol/transactions/common-fields)
- [XRPL Tickets](https://xrpl.org/docs/concepts/accounts/tickets)
- [XRPL Use Tickets](https://xrpl.org/docs/tutorials/best-practices/transaction-sending/use-tickets)
- [XRPL Reserves](https://xrpl.org/docs/concepts/accounts/reserves)
- [XRPL Currency Formats](https://xrpl.org/docs/references/protocol/data-types/currency-formats)
- [CAIP-2 Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
- [x402 Protocol Specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
