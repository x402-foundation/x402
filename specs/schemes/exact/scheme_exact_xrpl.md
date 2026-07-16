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
| `extra.crossCurrency`    | boolean | No       | Must be `true` to permit a different source asset |
| `extra.issuer`           | string  | IOU only | Classic address of the IOU issuer                |

`extra.destinationTag` applies to both native XRP and IOU payments. It is used when the receiver is a hosted account or otherwise requires a destination tag for attribution.

`extra.areFeesSponsored` is always `false` because this scheme uses payer-signed XRPL `Payment` transactions whose fee is paid by the payer account.

`extra.assetTransferMethod` selects how the signed transaction is sequenced. See [Asset Transfer Methods](#asset-transfer-methods) for negotiation rules and tradeoffs.

`extra.crossCurrency` is an opt-in capability. The only valid value is `true`; `false` is invalid and omission selects the existing same-asset behavior. A resource server MUST NOT advertise `crossCurrency=true` unless its facilitator advertises `extra.features.crossCurrency=true` for the selected XRPL network and exact scheme.

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

## Cross-Currency Exact Payments

Cross-currency behavior is enabled only when both `PaymentRequirements.extra.crossCurrency` and `PaymentPayload.accepted.extra.crossCurrency` are exactly `true`. If the value is absent in both objects, the same-asset rules remain unchanged. If it is `false`, malformed, present in only one object, or mismatched, the client and facilitator MUST reject the payment.

The destination `Amount` (API v1) or `DeliverMax` (API v2) remains the exact target amount and asset from `PaymentRequirements`. Because `tfPartialPayment` is forbidden, the transaction either delivers that full amount or fails. The facilitator and resource server MUST NOT interpret `SendMax` as the amount owed.

`SendMax` is REQUIRED and is the payer's signed, absolute cap in the source asset. It includes transfer fees, exchange rates, and the payer's chosen slippage allowance, but excludes the XRP transaction fee. `SendMax` MUST be positive and use a source asset different from the destination asset. Issued-currency values MAY use any XRPL-valid decimal string representation, including `e` or `E` scientific notation; implementations MUST parse them with arbitrary-precision decimal arithmetic rather than binary floating point.

- For an XRP destination, `SendMax` MUST be an issued-currency amount with a valid currency, issuer, and positive decimal value.
- For an issued-currency destination, `SendMax` MAY be a positive XRP drops string or an issued-currency amount. An issued-currency source MUST differ from the destination by currency or issuer.
- The special XRPL issuer forms where the source issuer equals the payer or the destination issuer equals the destination remain XRPL protocol behavior; clients MUST account for them during preflight and facilitators MUST rely on successful simulation rather than assuming an issuer from the currency code alone.

The resource server does not select the source asset or cap. Before signing, the client MUST obtain pathfinding or equivalent quote data from a current validated ledger, apply its own source-asset authorization policy, and set `SendMax` no lower than the quoted source amount and no higher than the payer-authorized cap. The client SHOULD simulate the final unsigned transaction before signing. A quote or simulation is not a price guarantee because ledger liquidity can change.

For example, a requirement for exactly `10.5 USD` may opt in as follows:

```json
{
  "scheme": "exact",
  "network": "xrpl:0",
  "asset": "USD",
  "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
  "amount": "10.5",
  "maxTimeoutSeconds": 600,
  "extra": {
    "areFeesSponsored": false,
    "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
    "crossCurrency": true
  }
}
```

A payer choosing XRP as the source might sign these transaction fields after quote preflight; the resource server does not advertise the `SendMax` value:

```json
{
  "TransactionType": "Payment",
  "Amount": {
    "currency": "USD",
    "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
    "value": "10.5"
  },
  "SendMax": "25000000"
}
```

The matching accepted envelope echoes the opt-in exactly:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "exact",
    "network": "xrpl:0",
    "asset": "USD",
    "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
    "amount": "10.5",
    "maxTimeoutSeconds": 600,
    "extra": {
      "areFeesSponsored": false,
      "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q",
      "crossCurrency": true
    }
  },
  "payload": {
    "signedTxBlob": "1200002280000000240000000361D4838D7EA4C68000000000000000000000000000555344000000000000..."
  }
}
```

A facilitator that implements this amendment advertises the capability in its
`/supported` response:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "xrpl:0",
      "extra": {
        "areFeesSponsored": false,
        "features": { "crossCurrency": true }
      }
    }
  ],
  "extensions": [],
  "signers": { "xrpl:*": [] }
}
```

### Paths and Default-Path Policy

- If `Paths` is omitted, the transaction uses XRPL's default path and `tfNoRippleDirect` MUST NOT be set.
- If `Paths` is present, it MUST be a non-empty path set containing at least one non-empty path. Without `tfNoRippleDirect`, XRPL may use the supplied paths or the default path. With `tfNoRippleDirect`, only the explicit paths are eligible.
- The client MUST obtain and review explicit paths before signing. It MUST NOT allow a resource server or facilitator to add or replace paths after the payer chooses its source cap.
- The facilitator MUST validate the signed path-set shape and simulate the exact signed `Amount`, `SendMax`, `Paths`, and flags. It MUST NOT perform new pathfinding and substitute a different path set.

### Partial Payments, Simulation, and Failure

`tfPartialPayment` and `DeliverMin` are forbidden. `tfLimitQuality` MAY be used, but it does not relax exact delivery: if no eligible path can deliver the full destination amount within `SendMax`, the transaction fails.

For cross-currency payments, facilitator simulation is REQUIRED at `/verify` and again when `/settle` re-runs verification. Targeted balance, trust-line, or sequence checks are not a substitute because they do not prove current path liquidity or cap sufficiency. If simulation is unavailable, fails, returns any result other than `tesSUCCESS`, or does not return matching `delivered_amount` metadata as defined below, verification MUST fail and the resource server MUST NOT run or release the protected resource.

Liquidity may change after simulation. If re-verification at `/settle` no longer succeeds, the facilitator MUST NOT submit. If ledger state changes between the final simulation and validation, the submitted transaction may fail; the facilitator MUST return settlement failure and the resource server MUST NOT grant access.

XRPL uses 15 decimal digits of precision for issued currencies, and metadata for a successful non-partial token payment can differ slightly from `Amount` because of ledger rounding. For this scheme, two positive issued-currency values are **XRPL-precision equivalent** when they are exactly equal or their absolute difference is no more than one unit in the required amount's 15th significant decimal digit:

```text
abs(delivered - required) <= 10^(floor(log10(required)) - 14)
```

For a zero required value, only exact zero is equivalent. This comparison MUST use arbitrary-precision decimal arithmetic and MUST accept XRPL scientific notation. It does not weaken issue matching or permit partial payments.

Both successful simulation and validated settlement metadata MUST contain `delivered_amount` in the exact negotiated asset/issue. XRP drops MUST equal the negotiated amount exactly. Issued-currency values MUST be XRPL-precision equivalent to the negotiated amount.

After validation, the facilitator MUST require all of the following before returning settlement success:

- `validated=true`;
- `TransactionResult=tesSUCCESS`;
- transaction metadata contains `delivered_amount` satisfying the asset, issue, and XRPL-precision rules above.

Missing, unavailable, malformed, or mismatched `delivered_amount` MUST fail settlement even if the transaction result is `tesSUCCESS`.

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
  - `crossCurrency=true` when cross-currency behavior is required

`crossCurrency` MUST be absent from both envelopes for same-asset payments or exactly `true` in both envelopes for cross-currency payments. Any other combination MUST be rejected.

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
- If `crossCurrency` is absent, `tx_json.SendMax` and `tx_json.Paths` MUST be omitted.
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

##### Same-Asset SendMax Policy (Required for IOU)

When `crossCurrency` is absent, the following rules prevent cross-currency behavior while allowing issuer transfer fees:

- `tx_json.SendMax` MUST be present.
- `SendMax` MUST be the same issued currency (same `currency` and `issuer`).
- `Decimal(SendMax.value) >= Decimal(destinationAmount.value)`.

The facilitator MUST reject if:

- `Paths` is present.
- `DeliverMin` is present.
- `Flags` includes `tfPartialPayment` (`0x00020000`).

#### Cross-Currency Amount and Path Rules

When `crossCurrency=true`, the facilitator MUST apply all rules in [Cross-Currency Exact Payments](#cross-currency-exact-payments), including:

- exact destination amount and issue comparison;
- a positive `SendMax` in a different source asset/issue;
- the default/explicit `Paths` and `tfNoRippleDirect` policy;
- rejection of `DeliverMin` and `tfPartialPayment`;
- successful simulation of the signed cap, paths, and flags.

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
- `SendMax` present for XRP unless `crossCurrency=true` and `SendMax` is a valid issued-currency source cap.
- `Paths` present unless `crossCurrency=true` and the signed path set follows the explicit-path policy.
- `DeliverMin` present.
- `Flags` including `tfPartialPayment` (`0x00020000`).
- Both `Amount` and `DeliverMax` present.
- Neither `Amount` nor `DeliverMax` present.

### 10. Signature Validation

- `/verify` MUST validate the signature offline.
- `/settle` MUST handle signature-related failures and report them appropriately.

### 11. Simulation

`/verify` MUST check that the signed transaction would currently succeed on XRPL. Implementations SHOULD use XRPL transaction simulation when available for same-asset payments and MUST use it for `crossCurrency=true` payments.

For same-asset payments only, if simulation is unavailable, implementations MUST perform targeted checks that cover at least:

- account existence for `tx_json.Account`;
- account sequence currency or ticket availability, according to the selected asset transfer method;
- XRP balance sufficient for the transaction fee;
- destination account existence or create-account funding rules for XRP payments;
- IOU trust line existence, issuer, and balance sufficiency for IOU payments.

## Settlement

Given verified `(paymentPayload, paymentRequirements)`, the facilitator:

1. Re-runs verification.
2. Rejects the settlement as a duplicate when the transaction hash is already pending settlement (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-required)).
3. Submits `signedTxBlob` to the XRPL network identified by `paymentRequirements.network`.
4. Waits for a validated result by polling `tx` until `validated=true`.
5. Treats settlement as successful only when the validated result is `tesSUCCESS`. For `crossCurrency=true`, it also verifies metadata `delivered_amount` equals the exact negotiated destination amount and issue.
6. Returns the transaction hash and payer address.

### Fee Responsibility

The payer pays the XRPL transaction fee because:

- `Fee` is embedded in the signed transaction.
- XRPL charges fees to the transaction's `Account` field.
- `Delegate` is not supported by this scheme.

### Settlement Timeout

The facilitator SHOULD wait for a validated result before returning success to prevent releasing resources for transactions that never validate.

### Duplicate Settlement Mitigation (REQUIRED)

#### Vulnerability

Without a dedup guard, concurrent `/settle` calls carrying the same signed transaction blob each return a successful response. XRPL deduplicates the ledger effect — only one payment lands — but reliable submission is an idempotent read keyed on the transaction hash: submitting an already-known blob and waiting for its hash resolves with the same validated `tesSUCCESS` outcome for every caller instead of failing for all but the first. A malicious client can exploit this to obtain access to the resource N times while paying once.

Unlike a probabilistic confirmation race, this behavior is deterministic on XRPL, so the mitigation is REQUIRED rather than RECOMMENDED.

#### Required Mitigation

Facilitators MUST deduplicate in-flight settlements across every process that serves `/settle`, keyed on the transaction hash. Before submitting a verified transaction:

1. After verification succeeds, derive the cache key from the signed transaction blob: the canonical XRPL transaction hash (as returned by, e.g., `hashSignedTx`).
2. If the key is already present, reject the settlement with a `"duplicate_settlement"` error.
3. If the key is not present, record it and proceed with submission.
4. Retain the key until its transaction can no longer land — that is, until its `LastLedgerSequence` has passed (bounded by `maxTimeoutSeconds`; see [§7. Expiry and Account Sequencing](#7-expiry-and-account-sequencing)). A shorter window reopens the race: while the transaction is still landable, a re-submission passes re-verification because the consumed sequence number — or ticket — is not yet consumed, so the entry MUST outlive that window rather than a fixed interval. (Solana's fixed ~60-90s blockhash lifetime lets its cache use a constant TTL; XRPL's expiry is policy-derived, so the retention window is too.)

The check and record MUST be performed atomically with respect to concurrent settlement requests. A single-process facilitator MAY satisfy this with an in-process map (checking and inserting synchronously between the verification result and the first subsequent suspension point); a horizontally scaled facilitator MUST use a shared store providing the same atomicity, otherwise duplicates routed to different replicas each pass their local guard.

Because the key is retained until the transaction expires rather than removed on completion, a re-submission of the same signed blob after a transient settlement failure is also rejected with `"duplicate_settlement"` within that window; `"duplicate_settlement"` therefore indicates the transaction was already seen, not that it settled successfully.

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
- Concurrent `/settle` calls carrying the same signed blob are rejected through a settlement cache keyed on the transaction hash (see [Duplicate Settlement Mitigation](#duplicate-settlement-mitigation-required)).
- Clients SHOULD use different XRPL accounts for standard networks such as mainnet and testnet to reduce replay risk when `NetworkID` must be omitted.

### Partial Payment Protection

- `tfPartialPayment` is explicitly rejected.
- `DeliverMin` is rejected.
- Same-asset IOU payments require `SendMax` to match the destination currency and issuer, and all same-asset payments reject `Paths`.
- Opt-in cross-currency payments require a different source asset, a signed `SendMax` cap, deterministic path policy, mandatory simulation, and post-settlement `delivered_amount` equality.

## References

- [XRPL Payment Transaction](https://xrpl.org/docs/references/protocol/transactions/types/payment)
- [XRPL Cross-Currency Payments](https://xrpl.org/docs/concepts/payment-types/cross-currency-payments)
- [XRPL Paths](https://xrpl.org/docs/concepts/tokens/fungible-tokens/paths)
- [XRPL Simulate](https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate)
- [XRPL Transaction Metadata](https://xrpl.org/docs/references/protocol/transactions/metadata)
- [XRPL Transaction Common Fields](https://xrpl.org/docs/references/protocol/transactions/common-fields)
- [XRPL Tickets](https://xrpl.org/docs/concepts/accounts/tickets)
- [XRPL Use Tickets](https://xrpl.org/docs/tutorials/best-practices/transaction-sending/use-tickets)
- [XRPL Reserves](https://xrpl.org/docs/concepts/accounts/reserves)
- [XRPL Currency Formats](https://xrpl.org/docs/references/protocol/data-types/currency-formats)
- [CAIP-2 Specification](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md)
- [x402 Protocol Specification](https://github.com/coinbase/x402/blob/main/specs/x402-specification-v2.md)
