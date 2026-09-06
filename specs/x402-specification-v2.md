# X402 Protocol Specification

**Protocol Version**: 2

**Document Scope**

This specification defines the core x402 protocol for internet-native payments. It covers:

- **Protocol fundamentals**: Payment requirements format, payment payload structure, and core message schemas
- **Facilitator interface**: Standard APIs for payment verification and settlement
- **Payment schemes**: Extensible payment methods (including `exact`, `upto`, and `batch-settlement`; see `specs/schemes/`)
- **Security considerations**: Replay attack prevention and trust minimization

**Out of Scope**: This specification does not include:

- Transport-specific implementations (covered in transport specifications)
- Specific implementation patterns (covered in application notes)
- Framework-specific integrations
- Client-side budget management
- Session handling mechanisms

**Architecture**

x402 is made up of three core components:

1. **Types**: Core data structures (e.g., `PaymentRequirements`, `PaymentPayload`, `SettlementResponse`) that are independent of both transport mechanism and payment scheme
2. **Logic**: Payment formation and verification logic that depends on the payment scheme (e.g., exact, upto, batch-settlement) and network (e.g., evm, solana, etc.)
3. **Representation**: How payment data is transmitted and signaled, which depends on the transport mechanism (e.g., HTTP, MCP, A2A)

**1. Overview**

x402 is an open payment standard that enables clients to pay for external resources. The protocol defines standardized message formats and payment flows that can be implemented over various transport layers, providing a standardized mechanism for payments across different payment schemes, networks and transport layers.

This specification is based on the x402 protocol implementation and documentation available in the [x402 repository](https://github.com/x402-foundation/x402). It aims to provide a comprehensive and implementation-agnostic specification for the x402 protocol.

**2. Core Payment Flow**

The x402 protocol follows a standard request-response cycle with payment integration:

1. **Client Request**: Client makes a request to a resource server
2. **Payment Required Response**: If no valid payment is attached, the server responds with a payment required signal and payment requirements
3. **Payment Authorization Request**: Client submits a signed payment authorization in the subsequent request
4. **Settlement Response**: Server verifies the payment authorization and initiates blockchain settlement

This cycle describes the default `authorization` payment flow, in which the payment is verified before the resource executes and settled afterward. Schemes may declare other flows that settle before execution; see section 6.1 Payment Flow Models.

**3. Protocol Components**

The x402 protocol involves three primary components:

- **Resource Server**: A service that requires payment for access to protected resources (APIs, content, data, etc.)
- **Client**: Any application or agent that requests access to protected resources
- **Facilitator**: A service that handles payment verification and blockchain settlement

**4. Response Types**

The x402 protocol defines standard response types with specific semantics:

- **Success**: Request successful, payment verified and settled
- **Payment Required**: Payment required to access the resource
- **Invalid Request**: Invalid payment payload or payment requirements
- **Server Error**: Server error during payment processing

Transport-specific implementations map these response types to appropriate transport mechanisms (e.g., HTTP status codes, JSON-RPC error codes, etc.).

**5. Types**

This section defines the core data structures used in the x402 protocol. These are completely independent of both transport mechanism and payment scheme. All transports and schemes use these exact data structures, differing only in how they represent them (transport layer) and what validation/settlement logic they apply (scheme layer).

**5.1 PaymentRequired Schema**

**5.1.1 JSON Payload**

When a resource server requires payment, it responds with a payment required signal containing the `PaymentRequired` object. The transport defines where this object is carried. For HTTP, the canonical wire location is the base64-encoded `PAYMENT-REQUIRED` response header, see [HTTP Payment Required Signaling](./transports-v2/http.md#payment-required-signaling).

Example `PaymentRequired` object:

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json",
    "serviceName": "Example Market Data",
    "tags": ["market-data", "finance"],
    "iconUrl": "https://api.example.com/icon.png"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ],
  "extensions": {}
}
```

**5.1.2 Field Descriptions**

The `PaymentRequired` schema contains the following fields:

| Field Name    | Type     | Required | Description                                                            |
| ------------- | -------- | -------- | ---------------------------------------------------------------------- |
| `x402Version` | `number` | Required | Protocol version identifier (must be 2)                                |
| `error`       | `string` | Optional | Human-readable error message explaining why payment is required        |
| `resource`    | `object` | Required | ResourceInfo object describing the protected resource                  |
| `accepts`     | `array`  | Required | Array of payment requirement objects defining acceptable payment methods |
| `extensions`  | `object` | Optional | Protocol extensions data                                               |

Each `PaymentRequirements` object in the `accepts` array contains:

| Field Name          | Type     | Required | Description                                                                                                               |
| ------------------- | -------- | -------- |---------------------------------------------------------------------------------------------------------------------------|
| `scheme`            | `string` | Required | Payment scheme identifier (e.g., "exact")                                                                                 |
| `network`           | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., "eip155:84532")                                                     |
| `amount`            | `string` | Required | Required payment amount in atomic token units                                                                             |
| `asset`             | `string` | Required | Token contract address or ISO 4217 currency code for fiat     |
| `payTo`             | `string` | Required | Recipient wallet address or role constant (e.g., "merchant")                                                              |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion                                                                               |
| `extra`             | `object` | Optional | Additional information. Reserved protocol keys: `assetTransferMethod`, `paymentFlow` (section 6.1); other keys are scheme-specific |

The `ResourceInfo` object contains:

| Field Name      | Type            | Required | Description                                                                                                          |
| --------------- | --------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| `url`           | `string`        | Required | URL of the protected resource                                                                                        |
| `description`   | `string`        | Optional | Human-readable description of the resource                                                                           |
| `mimeType`      | `string`        | Optional | MIME type of the expected response                                                                                   |
| `serviceName`   | `string`        | Optional | Human-readable name of the service hosting the resource. Printable ASCII, max 32 characters.                         |
| `tags`          | `array[string]` | Optional | Topical tags for the service, used for discovery filtering. Max 5 entries; each printable ASCII, max 32 characters.  |
| `iconUrl`       | `string`        | Optional | Absolute `https`/`http` URL to an icon representing the service. Max 2048 characters.                               |

The `Extensions` object is a key-value map where each key is an extension identifier and each value follows a standardized structure:

| Field Name | Type     | Required | Description                                              |
| ---------- | -------- | -------- | -------------------------------------------------------- |
| `info`     | `object` | Required | Extension-specific data provided by the server           |
| `schema`   | `object` | Required | JSON Schema defining the expected structure of `info`    |

Extensions enable modular optional functionality beyond core payment mechanics. Servers advertise supported extensions in `PaymentRequired`, and clients echo them in `PaymentPayload`. The client must include at least the info received; it may append additional info but cannot delete or overwrite existing info.

**5.2 PaymentPayload Schema**

**5.2.1 JSON Structure**

The client includes payment authorization as JSON in the payment payload field:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Access to premium market data",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "value": "10000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480"
    }
  },
  "extensions": {}
}
```

**5.2.2 Field Descriptions**

The `PaymentPayload` schema contains the following fields:

| Field Name    | Type     | Required | Description                                                         |
| ------------- | -------- | -------- | ------------------------------------------------------------------- |
| `x402Version` | `number` | Required | Protocol version identifier                                         |
| `resource`    | `object` | Optional | ResourceInfo object describing the resource being accessed          |
| `accepted`    | `object` | Required | PaymentRequirements object indicating the payment method chosen     |
| `payload`     | `object` | Required | Scheme-specific payment data                                        |
| `extensions`  | `object` | Optional | Protocol extensions data                                            |

The `accepted` field contains a `PaymentRequirements` object (see section 5.1.2).

The `payload` field contains scheme-specific data. For example, with exact EVM scheme, this includes:

| Field Name      | Type     | Required | Description                         |
| --------------- | -------- | -------- | ----------------------------------- |
| `signature`     | `string` | Required | EIP-712 signature for authorization |
| `authorization` | `object` | Required | EIP-3009 authorization parameters   |

The `Authorization` object contains the following fields:

| Field Name    | Type     | Required | Description                                     |
| ------------- | -------- | -------- | ----------------------------------------------- |
| `from`        | `string` | Required | Payer's wallet address                          |
| `to`          | `string` | Required | Recipient's wallet address                      |
| `value`       | `string` | Required | Payment amount in atomic units                  |
| `validAfter`  | `string` | Required | Unix timestamp when authorization becomes valid |
| `validBefore` | `string` | Required | Unix timestamp when authorization expires       |
| `nonce`       | `string` | Required | 32-byte random nonce to prevent replay attacks  |

**5.3 SettlementResponse Schema**

**5.3.1 JSON Structure**

After payment settlement, the server includes transaction details in the payment response field as JSON:

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:84532",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**5.3.2 Field Descriptions**

The `SettleResponse` schema contains the following fields:

| Field Name    | Type      | Required | Description                                                           |
| ------------- | --------- | -------- | --------------------------------------------------------------------- |
| `success`     | `boolean` | Required | Indicates whether the payment settlement was successful               |
| `errorReason` | `string`  | Optional | Error reason if settlement failed (omitted if successful)             |
| `payer`       | `string`  | Optional | Address of the payer's wallet                                         |
| `transaction` | `string`  | Required | Blockchain transaction hash (empty string if no transaction was broadcast; MUST be non-empty when `errorReason` is `settlement_pending` — see [§9 Error Handling](#9-error-handling)) |
| `network`     | `string`  | Required | Blockchain network identifier in CAIP-2 format                        |
| `amount`      | `string`  | Optional | The actual amount settled in atomic units (omitted if not applicable) |
| `extensions`  | `object`  | Optional | Protocol extensions data                                              |
| `status`      | `string`  | Optional | Settlement status per §5.3.3: one of `settled`, `pending`, `deferred_until`, `blocked`, `canceled`, `expired`. When omitted, §5.3.3 does not apply and the response carries the semantics above unchanged. |
| `statusAnchor` | `object` | Optional | REQUIRED when `status` is present. The evidence object backing `status`; shape in §5.3.4. |
| `statusDetail` | `object` | Optional | REQUIRED when the state takes parameters: `deferred_until` → `t` (in the declared unit) and `basis`; `canceled` → `by`. No other state takes parameters. |

**5.3.3 Settlement Status**

`status` refines the binary `success`/`errorReason` for the **collect** settle only — the settle that records the final charge (`authorization`, `upfront`, and the final settle of `escrow`). Facilitators MUST omit `status` on other lifecycle settles. Absence of `status` carries no status information: a response without it keeps today's semantics, and this section imposes nothing on it. Readers MUST treat an unknown `status` value as unsupported rather than mapping it to the nearest known state.

`Subject` is what the state is terminal *about*. A terminal state MUST NOT be followed by a different `status` with the same subject; an attempt- or observation-scoped state never closes the authorization.

| `status`         | Subject       | Terminal | REQUIRED anchor                                                                                                                    | A reader MUST NOT conclude                                                                                                            |
| ---------------- | ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `settled`        | authorization | Yes      | `kind` `event`, `transaction` or `composite` — the scheme-defined settlement object; plus `ledgerTime` where the binding declares a consensus time source | that the settlement matched the intent beyond the fields the anchor commits to; *which* purchase it discharges is scheme-defined |
| `pending`        | attempt       | No       | `kind` `transaction` — the broadcast reference (`transaction` non-empty per §5.3.2). Post-broadcast only                             | that the transaction will confirm, or that it will not; nor, from `pending` alone, that no receipt exists — read `finality`             |
| `deferred_until` | observation   | No       | `kind` `predicate`, naming the enforcement object the binding declares (§5.3.3.1). `statusDetail.basis` MUST be `"enforced"`         | that the payer cannot settle later by another route; over a binding with no matching declaration — anything at all (malformed)          |
| `blocked`        | observation   | No       | `kind` `read` (or `composite` where the binding's ordering coordinate is a separate part)                                            | that the condition persists past `observedAt`, or that it will clear; a mutable read is true only at the point it names                 |
| `canceled`       | authorization | Yes      | `kind` `event`, or `composite` where the binding requires ordering evidence alongside the revocation artifact. `statusDetail.by` names the party | cancellation from a consumed nonce, an invalidated bitmap bit, a bumped sequence, or any supersession or displacement artifact (a superseded frontier, a spent output) alone — those prove unexecutability, not intent, on any binding |
| `expired`        | authorization | Yes      | `kind` `none`, with `absentReason` stating the binding's expiry rule                                                                 | that the payer refused, or that the authorization was ever presented — expiry is silence and is indistinguishable from both             |

`success` and `errorReason` take these values alongside `status`:

- `settled` → `success: true`, `errorReason` omitted.
- `pending` → `success: false`, `errorReason: settlement_pending`, non-empty `transaction` (per §9). This covers both sub-cases — broadcast with confirmation not established, and confirmed but not yet final under the binding's finality rule — with `statusAnchor.finality` discriminating them, so a status-unaware reader still receives the reconcile-on-chain instruction §9 attaches to the code.
- `blocked`, `deferred_until`, `expired` → `success: false`. Each MAY carry the binding's existing §9 code for the same fact (e.g. `insufficient_funds`; `invalid_exact_evm_payload_authorization_valid_after`; `invalid_exact_evm_payload_authorization_valid_before`). Terminality comes from `status`, never from the code.
- `canceled` → `success: false`, `errorReason` omitted. §9 has no code for cancellation, and a facilitator MUST NOT substitute a nonce-consumed code, which asserts the opposite fact.

`statusDetail.basis` takes exactly one value in this amendment, `"enforced"`; the field exists so a future basis can ship without reshaping the wire.

**Failure to resolve.** An emitter that cannot establish which state holds — a null read, a dropped request, an anchor that cannot be ordered — MUST omit `status` entirely and fall back to `success`/`errorReason`. It MUST NOT emit any of the six states for that case.

**Finality.** `settled` and `canceled` are terminal *with respect to the binding's named finality rule*. A facilitator MUST NOT emit a terminal status for an anchor observed at a depth the binding does not treat as irreversible; before that depth it emits `pending`, and `statusAnchor.finality` discriminates "broadcast, confirmation not established" from "confirmed, not yet final".

**5.3.3.1 Capability declarations.** A scheme/network binding that emits `status` declares, in its own scheme specification: per-state reachability — `reachable` (the binding can emit the state and meet its evidence requirement), `unreachable` (the condition cannot arise on this rail), or `unclaimable` (the condition arises and is anchorable, but the state's semantic requirement cannot be met, so the binding will not emit it) — and, for `deferred_until`, the enforcement object: the contract and field that enforce `t`, with their comparator and unit. A cell declared `unreachable` or `unclaimable` MUST carry a one-line reason. Declarations are an append-only versioned list; each entry carries `version` (monotonic per binding) and `effectiveFrom` (a CAIP-2 network plus a chain-verifiable height at which the named enforcement object took effect — a deployment or upgrade height a reader can confirm, not an asserted number; for a request-derived enforcer, `effectiveFrom` resolves per-asset to the named asset contract's deployment or upgrade height, under the predicate the declaration states). A reader validating a settlement at height `H` uses the entry whose `[effectiveFrom, next.effectiveFrom)` covers `H`.

A reader encountering a `status` the binding's declaration marks `unreachable` or `unclaimable`, or a `deferred_until` whose declared enforcement object does not match its anchor, MUST treat the status object as malformed and fall back to the response's `success`/`errorReason`. It MUST NOT downgrade the claim to a weaker reading. For an `unclaimable` state, a reader MUST NOT infer absence of the condition from absence of the state — the evidence is on-chain and the reader's to check.

**5.3.4 Status Anchor Object**

| Field Name     | Type     | Required | Description                                                                                                                              |
| -------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `about`        | `object` | Required | Scheme-defined identity of the authorization this status describes. The binding MUST name its members. A status object whose `about` cannot be resolved MUST be treated as malformed. |
| `kind`         | `string` | Required | `transaction` \| `event` \| `read` \| `predicate` \| `composite` \| `none`                                                                |
| `network`      | `string` | Optional | CAIP-2. REQUIRED when `kind` is not `none`.                                                                                               |
| `ref`          | `string` | Optional | Scheme-defined reference the anchor lives in. Bindings MUST define its shape.                                                             |
| `locator`      | `object` | Optional | Scheme-defined narrowing inside `ref`. The binding MUST name its members.                                                                 |
| `observation`  | `object` | Optional | REQUIRED when `kind` is `read`: the contract or account read, the key, the returned values, and the binding's ordering coordinate where it declares one. |
| `parts`        | `array`  | Optional | REQUIRED when `kind` is `composite`: two or more anchor objects. ALL parts MUST resolve for the state to hold, and the binding MUST state the join rule relating them. |
| `observedAt`   | `string` | Optional | RFC 3339 UTC. REQUIRED on every non-terminal state.                                                                                       |
| `ledgerTime`   | `string` | Optional | RFC 3339 UTC, derived from the named object by a consensus rule the binding names. REQUIRED on `settled` where the binding declares a consensus time source; MUST be absent otherwise. A node-reported or facilitator wall-clock value MUST NOT be emitted in this field. |
| `finality`     | `string` | Optional | REQUIRED on `pending` and on terminal states whose `kind` is not `none`: the binding-defined basis on which the anchor is treated as irreversible (e.g. `finalized`, `confirmations:<n>`), or `unconfirmed` on `pending` where no receipt has been observed. |
| `absentReason` | `string` | Required | A non-empty line stating why no anchor exists when `kind` is `none`; explicit `null` otherwise.                                           |

**5.4 VerifyResponse Schema**


**5.4.2 Field Descriptions**

The `VerifyResponse` schema contains the following fields:

| Field Name      | Type      | Required | Description                                             |
| --------------- | --------- | -------- | ------------------------------------------------------- |
| `isValid`       | `boolean` | Required | Indicates whether the payment authorization is valid    |
| `invalidReason` | `string`  | Optional | Reason for invalidity (omitted if valid)                |
| `payer`         | `string`  | Optional | Address of the payer's wallet                           |
| `extensions`    | `object`  | Optional | Protocol extensions data                                |
| `extra`         | `object`  | Optional | Scheme-specific additional data                         |

Facilitators MAY expose extension outcomes separately from `extensions` as `extensionResponses` (populated from the transport sidechannel; never serialized to buyers). See section 7.2.1.

**6. Payment Schemes (The Logic)**

This section describes the payment schemes supported by the x402 protocol. Payment schemes define how payments are formed, validated, and settled on specific payment networks. Schemes are independent of the underlying transport mechanism.

Each scheme defines:

- How to construct the `payload` field within `PaymentPayload`
- Settlement and validation procedures
- Requirements in the `extra` field of `PaymentRequirements` (reserved protocol keys in section 6.1; remaining keys are scheme-specific)

Individual schemes and their per-network bindings — including `exact`, `upto`, `batch-settlement`, and `auth-capture` — are specified under [`specs/schemes/`](./schemes/).

**6.1 Asset Transfer Methods and Payment Flow Models**

An `assetTransferMethod` identifies **how** value is authorized or moved for a mechanism (a scheme on a specific network) — for example `eip3009` vs `permit2` on EVM `exact`, or `sequence` vs `ticketSequence` on XRPL `exact`. Allowed `assetTransferMethod` string values are mechanism-defined; this protocol reserves the key name, not a global ATM vocabulary. Mechanisms MAY reuse the same ATM string across networks when semantics align. `extra.assetTransferMethod` and `extra.paymentFlow` are protocol-reserved keys in `PaymentRequirements.extra`: clients and servers MUST interpret them as defined here rather than as opaque scheme-private fields.

Schemes differ not only in how a payment is formed and validated, but in **when** settlement occurs relative to resource execution. A mechanism declares supported payment flows **per `assetTransferMethod`**, each with a default flow, plus a scheme-level default `assetTransferMethod` used when `extra.assetTransferMethod` is omitted. The resolved flow determines which of the facilitator's read-only `/verify` (section 7.1) and state-committing `/settle` (section 7.2) run, and in what order, around the resource server's execution of the protected request. A flow's ordering MAY omit `/verify` (see `upfront` and `escrow` below).

Omitting `extra.assetTransferMethod` or `extra.paymentFlow` means the mechanism default when resolving. When the resolved payment flow is not `authorization`, `PaymentRequired` `accepts[].extra.paymentFlow` MUST be present so clients can reason about pre-handler fund commitment without scheme-specific knowledge (for example, distinguishing an SVM upto `escrow` default from an EVM upto `authorization` default). `authorization` MAY be omitted or explicit. Resource servers MUST reject unsupported `assetTransferMethod` / payment flow combinations. Clients MUST NOT construct a payment for a `paymentFlow` they do not recognize, and SHOULD skip such `accepts[]` entries when selecting. When a resource offers both `authorization` (post-handler settlement) and a pre-handler-settlement flow (`upfront` or `escrow`) for the same request, clients SHOULD prefer `authorization`.

The following flows are defined:

| Flow                  | Ordering                                        | Description                                                                                                                              |
| --------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `authorization` (default) | verify → resource → settle → respond        | Read-only verify before the resource executes; funds move only after it completes successfully. |
| `upfront`             | settle → resource → respond                     | Payment is durably committed before the resource executes, giving the server finality first. Facilitator `/verify` is not part of this ordering; validity is established by settle. Required by networks with no pull-settlement primitive. |
| `escrow`              | settle → resource → settle → respond            | A first settle commits a deposit or ceiling, the resource executes, and a second settle records the final charge. Facilitator `/verify` is not part of this ordering; the first settle is the pre-resource check. |

Invariant: at least one check — a verify or settle before the resource — MUST run before the resource executes. The resource never executes with nothing checked.

**7. Facilitator Interface**

The facilitator provides HTTP REST APIs for payment verification and settlement. This allows resource servers to delegate blockchain operations to trusted third parties or host the endpoints themselves. Note that while the core x402 protocol is transport-agnostic, facilitator APIs are currently standardized as HTTP endpoints.

**7.1 POST /verify**

Verifies a payment authorization without executing the transaction on the blockchain. `/verify` is **read-only**: it validates payment state but MUST NOT commit payment state or write onchain state. Resource servers invoke `/verify` only when the resolved payment flow's ordering includes it (section 6.1); `upfront` and `escrow` omit it.

**Request (Exact Scheme):**

```json
{
  "x402Version": 2,
  "paymentPayload": {
    /* PaymentPayload schema */
  },
  "paymentRequirements": {
    /* PaymentRequirements schema */
  }
}
```

Example with actual data:

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "resource": {
      "url": "https://api.example.com/premium-data",
      "description": "Access to premium market data",
      "mimeType": "application/json"
    },
    "accepted": {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "10000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    },
    "payload": {
      "signature": "0x...",
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "10000",
        "validAfter": "1740672089",
        "validBefore": "1740672154",
        "nonce": "0x..."
      }
    }
  },
  "paymentRequirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "10000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  }
}
```

**Successful Response:**

```json
{
  "isValid": true,
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**Error Response:**

```json
{
  "isValid": false,
  "invalidReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
}
```

**7.2 POST /settle**

Durably commits payment state for the request — establishing finality from the resource server's perspective — typically by updating a network ledger (for example, broadcasting a transaction). Commitment need not be an onchain write: for client-prepaid methods, settle MAY bind a payment proof to the request (for example, consuming a challenge or marking a transaction as used) after read-only observation of ledger or backend state. A settle need not be the final charge: it MAY establish an escrow, record a charge, or transfer funds, depending on the scheme and payment flow (see section 6.1 Payment Flow Models).

**Request:** Same structure as `/verify` endpoint (contains `paymentPayload` and `paymentRequirements`).

> **Note**: While the request structure is identical, some payment schemes may assign different semantics to fields at settlement time versus verification time. For example, in the `upto` scheme, the `amount` field in `paymentRequirements` represents the maximum authorized amount at verification time, but the actual amount to settle at settlement time. See individual scheme specifications for details.

> **Note**: `/settle` MAY be invoked more than once for a single payment (for example, the `escrow` flow settles a deposit before the resource executes and the final charge after). A scheme defining multiple settles MUST specify how the facilitator distinguishes them from payload content. Because the client typically signs a single payload, that distinction is usually server-led (for example, a scheme-specific `step` field), though a facilitator MAY instead infer the step from network-ledger state.

**Successful Response:**

```json
{
  "success": true,
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:84532"
}
```

**Error Response:**

```json
{
  "success": false,
  "errorReason": "insufficient_funds",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "transaction": "",
  "network": "eip155:84532"
}
```

**7.2.1 Extension Responses Sidechannel**

Facilitators MAY communicate extension-specific processing outcomes on verify and settle responses through a transport-specific sidechannel that is **not** part of the JSON response body and **not** forwarded to buyers.

On HTTP, the sidechannel is the `EXTENSION-RESPONSES` header:

| Property | Value |
| -------- | ----- |
| Header name | `EXTENSION-RESPONSES` |
| Header value | Base64-encoded JSON object keyed by extension name |

Each key holds the extension's outcome object. Extension specs define the payload shape under their key (for example, `bazaar` in `specs/extensions/bazaar.md`).

**7.3 GET /supported**

Returns the list of payment schemes, networks, and extensions supported by the facilitator.

**Response:**

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:84532"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:8453"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:43113"
    },
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "eip155:43114"
    }
  ],
  "extensions": [],
  "signers": {
    "eip155:*": ["0x1234567890abcdef1234567890abcdef12345678"],
    "solana:*": ["CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5"]
  }
}
```

**7.3.1 SupportedResponse Fields**

| Field Name   | Type     | Required | Description                                                              |
| ------------ | -------- | -------- | ------------------------------------------------------------------------ |
| `kinds`      | `array`  | Required | Array of supported payment kind objects                                       |
| `extensions` | `array`  | Required | Array of extension identifiers the facilitator has implemented                |
| `signers`    | `object` | Required | Map of CAIP-2 patterns (e.g., `eip155:*`) to public signer addresses          |

Each `SupportedKind` object in the `kinds` array contains:

| Field Name    | Type     | Required | Description                                                |
| ------------- | -------- | -------- | ---------------------------------------------------------- |
| `x402Version` | `number` | Required | Protocol version supported (2 for v2)                      |
| `scheme`      | `string` | Required | Payment scheme identifier (e.g., "exact")                  |
| `network`     | `string` | Required | Blockchain network identifier in CAIP-2 format             |
| `extra`       | `object` | Optional | Additional scheme-specific configuration                   |

**8. Discovery API**

The x402 protocol includes a discovery mechanism that allows clients to find and explore available x402-enabled resources. This enables the creation of marketplaces (known as "Bazaars") where users can discover and access monetized APIs and digital services.

Discovery is currently implemented as HTTP REST APIs, though the discovered resources may use any x402-supported transport.

8.1 GET /discovery/resources

List discoverable x402 resources from the Bazaar.

**Request Parameters:**

| Parameter | Type     | Required | Description                                 | Default |
| --------- | -------- | -------- | ------------------------------------------- | ------- |
| `type`    | `string` | Optional | Filter by resource type (e.g., "http")      | -       |
| `payTo`   | `string` | Optional | Filter by payment recipient address          | -       |
| `scheme`  | `string` | Optional | Filter by payment scheme (e.g., "exact")    | -       |
| `network` | `string` | Optional | Filter by payment network (e.g., "eip155:8453") | -   |
| `extensions` | `string` | Optional | Filter by extension key present on each resource | -       |
| `limit`   | `number` | Optional | Maximum number of results to return (1-100) | 20      |
| `offset`  | `number` | Optional | Number of results to skip for pagination    | 0       |

**Response:**

```json
{
  "x402Version": 2,
  "items": [
    {
      "resource": "https://api.example.com/premium-data",
      "type": "http",
      "x402Version": 2,
      "accepts": [
        {
          "scheme": "exact",
          "network": "eip155:84532",
          "amount": "10000",
          "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
          "maxTimeoutSeconds": 60,
          "extra": {
            "name": "USDC",
            "version": "2"
          }
        }
      ],
      "lastUpdated": "2025-08-09T01:07:04.005Z"
    }
  ],
  "pagination": {
    "limit": 10,
    "offset": 0,
    "total": 1
  }
}
```

**8.2 GET /discovery/search**

Search semantics and response shape are defined in the Bazaar extension specification at
`specs/extensions/bazaar.md`, since this endpoint is extension-specific behavior.

**8.3 Discovered Resource Fields**

| Field Name    | Type     | Required | Description                                                     |
| ------------- | -------- | -------- | --------------------------------------------------------------- |
| `resource`    | `string` | Required | The resource URL or identifier being monetized                  |
| `type`        | `string` | Required | Resource type (currently "http" for HTTP endpoints)             |
| `x402Version` | `number` | Required | Protocol version supported by the resource                      |
| `accepts`     | `array`  | Required | Array of PaymentRequirements objects specifying payment methods |
| `lastUpdated` | `string` | Required | ISO 8601 timestamp of when the resource was last updated        |
| `extensions`  | `object` | Optional | Additional extension payloads associated with this discovered resource |

**8.4 Bazaar Concept**

The Bazaar is a marketplace ecosystem where x402-enabled resources can be discovered and accessed. Key features:

- **Resource Discovery**: Find APIs and services by category, provider, or payment requirements
- **Payment Transparency**: View pricing and payment methods upfront
- **Provider Information**: Learn about service providers and their offerings
- **Dynamic Updates**: Resources can be added, updated, or removed dynamically

**8.5 Example Usage**

```bash
# List financial data APIs
GET /discovery/resources?type=http&limit=10

# Search for weather APIs
GET /discovery/search?query=weather+APIs&type=http&limit=5

# Continue a paginated search (when server supports it)
GET /discovery/search?query=financial+data&limit=10&cursor=eyJwYWdlIjoyfQ==
```

**9. Error Handling**

The x402 protocol defines standard error codes that may be returned by facilitators or resource servers. These error codes help clients understand why a payment failed and take appropriate action.

- **`insufficient_funds`**: Client does not have enough tokens to complete the payment
- **`invalid_exact_evm_payload_authorization_valid_after`**: Payment authorization is not yet valid (before validAfter timestamp)
- **`invalid_exact_evm_payload_authorization_valid_before`**: Payment authorization has expired (after validBefore timestamp)
- **`invalid_exact_evm_payload_authorization_value_mismatch`**: Payment amount does not exactly match the required amount
- **`invalid_exact_evm_payload_signature`**: Payment authorization signature is invalid or improperly signed
- **`invalid_exact_evm_payload_recipient_mismatch`**: Recipient address does not match payment requirements
- **`invalid_network`**: Specified blockchain network is not supported
- **`invalid_payload`**: Payment payload is malformed or contains invalid data
- **`invalid_payment_requirements`**: Payment requirements object is invalid or malformed
- **`invalid_scheme`**: Specified payment scheme is not supported
- **`unsupported_scheme`**: Payment scheme is not supported by the facilitator
- **`invalid_x402_version`**: Protocol version is not supported
- **`invalid_transaction_state`**: Blockchain transaction failed or was rejected
- **`unexpected_verify_error`**: Unexpected error occurred during payment verification
- **`unexpected_settle_error`**: Unexpected error occurred during payment settlement
- **`settlement_pending`**: The settlement transaction was broadcast but its confirmation could not be established (e.g. a node/RPC error or timeout while waiting for the receipt). Facilitators MAY return this **non-terminal** code — the transaction may still confirm on chain. A `SettleResponse` with this `errorReason` MUST carry a non-empty `transaction` (the broadcast hash) and `network` so the caller can reconcile on chain before deciding whether to retry.

Where a code accompanies a `status` (§5.3.3), terminality comes from the `status`, not from the code: `insufficient_funds` alongside `status: "blocked"`, or `invalid_exact_evm_payload_authorization_valid_after` alongside `status: "deferred_until"`, records the same fact without closing the payment. Responses without `status` are unaffected.

**10. Security Considerations**

**10.1 Replay Attack Prevention**

The x402 protocol implements multiple layers of protection against replay attacks:

- **EIP-3009 Nonce**: Each authorization includes a unique 32-byte nonce to prevent replay attacks
- **Blockchain Protection**: EIP-3009 contracts inherently prevent nonce reuse at the smart contract level
- **Time Constraints**: Authorizations have explicit valid time windows to limit their lifetime
- **Signature Verification**: All authorizations are cryptographically signed by the payer

**10.2 Authentication Integration**

The protocol supports integration with authentication systems (e.g., Sign-In with Ethereum - SIWE) to enable authenticated pricing models where verified users receive discounted rates or special access terms.

**11. Implementation Notes**

**11.1 Network Identifiers**

Networks in x402 v2 use CAIP-2 (Chain Agnostic Improvement Proposal) format: `namespace:reference`.

**Format:** `{namespace}:{reference}` (e.g., `eip155:8453` for Base mainnet)

Non-blockchain networks are encouraged to follow the CAIP-2 format (e.g., `ach:us`, `sepa:eu`).

Both EVM and Solana networks are supported by the reference implementations, e.g.:

- **`eip155:84532`**: Base Sepolia testnet
- **`eip155:8453`**: Base mainnet
- **`eip155:43113`**: Avalanche Fuji testnet
- **`eip155:43114`**: Avalanche mainnet
- **`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`**: Solana mainnet
- **`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`**: Solana devnet

**11.2 Supported Assets**

Token support varies by network:

**EVM Networks:**
- ERC-20 tokens implementing EIP-3009 (Transfer with Authorization)
- Example: USDC

**Solana:**
- Any SPL token
- Token2022 program tokens

Token availability depends on facilitator service capabilities and network-specific deployments.

**12. Use Cases and Applications**

The x402 protocol enables diverse monetization scenarios across the internet. While the core protocol is HTTP-native and chain-agnostic, specific implementations can vary based on use case requirements.

### 12.1 AI Agent Integration

AI agents can use x402 to autonomously pay for resources and services. The protocol supports:

- **Automatic payment handling** for resource access
- **Resource discovery** through facilitator services
- **Budget management** and spending controls (implementation-specific)
- **Correlation tracking** for operation grouping (implementation-specific)
- **Multi-transport support** allowing agents to work across HTTP APIs, MCP tools, and other protocol layers

### 12.2 Human User Applications

Applications can implement x402 for:

- **Session-based access** (time-limited subscriptions)
- **Pay-per-use content** (articles, videos, downloads, tools)
- **Resource monetization** with per-call pricing
- **Authentication-based pricing** (discounted rates for verified users)
- **Cross-protocol payments** supporting web, desktop, and AI applications

### 12.3 Transport Support

x402 integrates across multiple transport layers:

- **HTTP**: Web APIs, REST services, server frameworks (Express.js, FastAPI, Next.js, etc.)
- **MCP (Model Context Protocol)**: AI agent tools and resources
- **A2A (Agent-to-Agent Protocol)**: Direct agent-to-agent payments
- **Custom Protocols**: Any request-response based system can implement x402 payment flows

### 12.4 Server Frameworks

x402 integrates with popular frameworks:

- **Express.js**: `require_payment()` middleware
- **FastAPI/Flask**: Framework-specific middleware
- **Hono**: Edge runtime support
- **Next.js**: Fullstack integration
- **ai/agents**: AI agent and MCP frameworks

### 12.5 Client Libraries

Clients across different transports can be enhanced with x402 payment capabilities:

- **HTTP clients**: axios/fetch (browser), httpx/requests (Python), curl (CLI)
- **MCP clients**: ai/agents MCP Clients
- **A2A**: x402_a2a (python)
- **Custom integrations**: Application-specific payment handling

### 12.6 Advanced Patterns

The protocol enables sophisticated monetization strategies:

- **Dynamic pricing** based on user authentication or usage patterns
- **Session management** for time-based access control
- **Batch payments** for multiple resource access
- **Subscription models** built on micropayments

_Note: Implementation details for specific patterns (such as budget management, correlation tracking, or session handling) are available in application notes and implementation guides. Transport-specific implementation details are covered in the transport specification documents._

---

## Version History

| Version | Date        | Changes                                                           | Author                    |
| ------- | ----------- | ----------------------------------------------------------------- | ------------------------- |
| v2.0    | 2025-12-9   | Protocol v2: CAIP-2 networks, restructured PaymentPayload/Required, ResourceInfo separation, extensions support | x402 team |
| v0.2    | 2025-10-3   | Transport-agnostic redesign                                       | Ethan Niser               |
| v0.1    | 2025-8-29   | Initial draft                                                     | [derived from repository] |
