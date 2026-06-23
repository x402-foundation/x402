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

## Protocol Flow

The protocol flow for `exact` on XRPL is client-driven.

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with a payment required signal containing `PaymentRequired` in the `PAYMENT-REQUIRED` header (base64-encoded JSON).
3. **Client** creates a `Payment` transaction to the resource server's XRPL address for the specified amount.
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
    "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
    "invoiceId": "INV-2025-002"
  }
}
```

### Field Definitions

| Field                  | Type    | Required | Description                                      |
| ---------------------- | ------- | -------- | ------------------------------------------------ |
| `scheme`               | string  | Yes      | Must be `"exact"`                                |
| `network`              | string  | Yes      | CAIP-2 identifier (for example, `"xrpl:0"`)      |
| `asset`                | string  | Yes      | `"XRP"` for native XRP, or currency code for IOU |
| `payTo`                | string  | Yes      | XRPL classic address receiving the payment       |
| `amount`               | string  | Yes      | XRP drops string or IOU issued-currency value    |
| `maxTimeoutSeconds`    | integer | Yes      | Maximum validity window for payment attempt      |
| `extra.invoiceId`      | string  | No       | Unique invoice identifier for binding            |
| `extra.destinationTag` | integer | No       | DestinationTag for hosted accounts               |
| `extra.issuer`         | string  | IOU only | Classic address of the IOU issuer                |

`extra.destinationTag` applies to both native XRP and IOU payments. It is used when the receiver is a hosted account or otherwise requires a destination tag for attribution.

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
      "invoiceId": "INV-2025-001"
    }
  },
  "payload": {
    "signedTxBlob": "120000228000000024000000036840000000000000C732103AB40A0490F9B7ED8DF29D246BF2D6269820A0EE7742ACDD457BEA7C7D0931EDB74473045022100..."
  }
}
```

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
      "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
      "invoiceId": "INV-2025-002"
    }
  },
  "payload": {
    "signedTxBlob": "120000228000000024000000036840000000000000C732103AB40A0490F9B7ED8DF29D246BF2D6269820A0EE7742ACDD457BEA7C7D0931EDB74473045022100..."
  }
}
```

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
- The transaction MUST use either a normal `Sequence` or a `TicketSequence`.

Recommended `LastLedgerSequence` policy:

- Convert `maxTimeoutSeconds` to ledgers: `maxLedgerDelta = ceil(maxTimeoutSeconds / 5) + 2`.
- Require: `LastLedgerSequence <= currentValidatedLedgerIndex + maxLedgerDelta`.

`TicketSequence` SHOULD be used for x402 flows where `/verify` and `/settle` are separated by resource-handler execution. A ticket avoids blocking the payer's normal account sequence while the resource server handles the request.

If `TicketSequence` is present:

- `tx_json.Sequence` MUST be `0`.
- `tx_json.TicketSequence` MUST refer to an available ticket for `tx_json.Account`.

If `TicketSequence` is absent:

- `tx_json.Sequence` MUST be present.
- `/verify` MUST check that `tx_json.Sequence` is currently available for `tx_json.Account`.
- Resource servers SHOULD settle promptly after successful verification to minimize sequence-race risk.

### 8. Invoice Binding

If `paymentRequirements.extra.invoiceId` is present, the signed transaction MUST commit to that invoice using the canonical XRPL `InvoiceID` field.

The transaction includes:

- `InvoiceID = SHA-256(invoiceId)` as 32-byte hex (64 hex characters).
- Comparison is case-insensitive.

The facilitator MUST reject if `invoiceId` is present and `InvoiceID` is missing or mismatched. Memos MUST NOT be used for invoice binding.

### 9. Safety Checks (MUST)

The facilitator MUST reject transactions with:

- `Fee` above facilitator policy.
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
- normal sequence availability or ticket availability;
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
- `TicketSequence` is recommended for delayed settlement flows because it avoids blocking the payer's normal account sequence.
- Normal `Sequence` may race if the payer submits another transaction between `/verify` and `/settle`; implementations using normal `Sequence` SHOULD minimize the verify-to-settle window.
- `NetworkID` provides signed network binding only for XRPL networks with `networkId > 1024`; standard XRPL networks require facilitators to route strictly by `paymentRequirements.network`.

### Partial Payment Protection

- `tfPartialPayment` is explicitly rejected.
- `Paths` and `DeliverMin` are rejected.
- IOU payments require `SendMax` to match the destination currency and issuer.

## References

- [XRPL Payment Transaction](https://xrpl.org/docs/references/protocol/transactions/types/payment)
- [XRPL Transaction Common Fields](https://xrpl.org/docs/references/protocol/transactions/common-fields)
- [XRPL Tickets](https://xrpl.org/docs/concepts/accounts/tickets)
- [XRPL Use Tickets](https://xrpl.org/docs/tutorials/best-practices/transaction-sending/use-tickets)
- [XRPL Currency Formats](https://xrpl.org/docs/references/protocol/data-types/currency-formats)
- [CAIP-2 Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
- [x402 Protocol Specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
