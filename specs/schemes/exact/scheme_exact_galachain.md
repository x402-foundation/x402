# Scheme: `exact` on GalaChain

## Summary

The `exact` scheme on GalaChain transfers a specific amount of a GalaChain fungible token class from the Client to the Resource Server's account.

The Client signs a GalaChain `TransferTokenDto` naming `payTo` as receiver but does not submit it. The Facilitator relays the signed DTO to a GalaChain REST gateway during settlement. GalaChain authenticates the DTO by recovering the signer from its signature, not by the identity of whoever submits it, so the Facilitator holds no key, signs nothing, and cannot alter the amount or destination.

GalaChain is a Hyperledger Fabric-based layer 1 (TypeScript chaincode, REST gateways, no EVM, no JSON-RPC). Three chain properties shape this scheme:

- **The payer funds the chain fee.** The `TransferToken` fee gate charges the *calling user* — the DTO signer — from their GALA balance (`galaFeeGate` → `payFeeImmediatelyFromBalance`). The Facilitator sponsors nothing.
- **Replay is exclusive and distinguishable.** Every submit DTO carries a client-chosen `uniqueKey`. The chain records it after validation and authentication but before the fee gate and handler; a second submission fails with `UNIQUE_TRANSACTION_CONFLICT` naming the transaction that consumed it, and an unsigned `DryRun` of the same DTO reports the same conflict.
- **Late failure consumes the key but nothing else.** When the fee gate or handler fails, GalaChain commits only the `uniqueKey` record and discards every other write, so a failed settlement burns no fee and moves no funds, and the same signed DTO cannot be resubmitted. Failures earlier in the wrapper (DTO validation, expiry, authentication) consume nothing.

This scheme defines one asset transfer method:

| AssetTransferMethod | Family | Fee payer | Replay primitive | Validity window | Duplicate submission |
| --- | --- | --- | --- | --- | --- |
| **`transfer-token`** (default) | Facilitator-submitted | Self-funded by the payer | Exclusive to this payment (`uniqueKey`, recorded on chain before execution) | Bounded by `dtoExpiresAt` (unix ms); REQUIRED by this scheme | Distinguishable: HTTP 409 `UNIQUE_TRANSACTION_CONFLICT` naming the original transaction |

If no `assetTransferMethod` is specified in `PaymentRequirements.extra`, clients and facilitators MUST behave as `transfer-token`. A facilitator MUST reject any other value (`invalid_exact_galachain_unsupported_asset_transfer_method`).

Facilitators SHOULD advertise the method per network in `/supported`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "exact",
      "network": "galachain:mainnet",
      "extra": {
        "assetTransferMethods": ["transfer-token"]
      }
    }
  ]
}
```

There is no `extra.feePayer`: the facilitator has no account on the payment path.

## Networks

| Network | CAIP-2 |
| --- | --- |
| GalaChain mainnet | `galachain:mainnet` |
| GalaChain testnet | `galachain:testnet` |

The `galachain` namespace is proposed in [ChainAgnostic/namespaces#232](https://github.com/ChainAgnostic/namespaces/pull/232). Each network is reached through its REST gateway (`https://gateway-mainnet.galachain.com/api`, `https://gateway-testnet.galachain.com/api`); the token contract on the `asset` channel is at `/asset/token-contract/<Method>`.

## Protocol Flow

1. **Client** requests a resource from a **Resource Server**.
2. **Resource Server** responds with a payment-required signal carrying `PaymentRequirements` for `galachain:<network>`, priced in atomic units of a GalaChain token class.
3. **Client** builds a `TransferTokenDto`: `to = payTo`, `tokenInstance` = the token class from `asset` with `instance "0"`, `quantity` = `amount` converted to decimal token units, a fresh `uniqueKey`, and `dtoExpiresAt = now + maxTimeoutSeconds`.
4. **Client** signs the DTO with its secp256k1 key and sends a new request carrying the `PaymentPayload` (`dto` with `signature`, plus `signerPublicKey`).
5. **Resource Server** forwards `PaymentPayload` and `PaymentRequirements` to the **Facilitator** `/verify`.
6. **Facilitator** checks the signature, the DTO fields against the requirements, and the validity window, then runs an unsigned `DryRun` of `TransferToken` against the gateway to confirm the payer can fund both the transfer and the fee.
7. **Resource Server**, on a valid response, serves the resource and calls `/settle`.
8. **Facilitator** POSTs the signed DTO unchanged to the gateway's `TransferToken` endpoint and returns a `SettlementResponse` carrying the transaction id.

## Phase 1: `PAYMENT-SIGNATURE` Header Payload

### `PaymentRequirements`

```json
{
  "scheme": "exact",
  "network": "galachain:mainnet",
  "amount": "100000000",
  "asset": "GALA|Unit|none|none",
  "payTo": "eth|4F13EaaC7f3646c7A698Da4E3523F23541E2D079",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "transfer-token",
    "decimals": 8,
    "name": "GALA"
  }
}
```

- `amount`: integer, atomic units of `asset`. GALA has 8 decimals, so `"100000000"` is 1 GALA.
- `asset`: the GalaChain token class key `collection|category|type|additionalKey`. GALA is `GALA|Unit|none|none`.
- `payTo`: a GalaChain user alias. For secp256k1 users this is `eth|` followed by the EIP-55 checksummed address (no `0x`). The chain's DTO validation rejects a non-checksummed `eth|` alias, so resource servers MUST publish the checksummed form. The chain resolves `to` to a user profile the same way it resolves the payer (`resolveUserAlias`); an alias with no profile is credited as itself.
- `maxTimeoutSeconds`: bounds `dto.dtoExpiresAt` (verification rule 9).

**`extra` field definitions:**

- `extra.assetTransferMethod` (optional, default `"transfer-token"`): if present, MUST be `"transfer-token"`.
- `extra.decimals` (required): decimals of the token class, used to convert `dto.quantity` to atomic units.
- `extra.name` (optional): display name of the token.

### `PaymentPayload`

The `payload` field MUST contain:

- `dto`: the signed `TransferTokenDto`.
- `signerPublicKey`: the payer's secp256k1 public key. Uncompressed hex (130 characters, `04…`) is RECOMMENDED; compressed hex and base64 forms accepted by `@gala-chain/api` MAY be used. This field lives in `payload`, **not** inside `dto` (see envelope rules below).

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
    "network": "galachain:mainnet",
    "amount": "100000000",
    "asset": "GALA|Unit|none|none",
    "payTo": "eth|4F13EaaC7f3646c7A698Da4E3523F23541E2D079",
    "maxTimeoutSeconds": 300,
    "extra": {
      "assetTransferMethod": "transfer-token",
      "decimals": 8,
      "name": "GALA"
    }
  },
  "payload": {
    "signerPublicKey": "04a1b2c3…",
    "dto": {
      "to": "eth|4F13EaaC7f3646c7A698Da4E3523F23541E2D079",
      "tokenInstance": {
        "collection": "GALA",
        "category": "Unit",
        "type": "none",
        "additionalKey": "none",
        "instance": "0"
      },
      "quantity": "1",
      "uniqueKey": "x402-3f9c2a6e-8d41-4b7e-9c1a-2e5f7a8b9c0d",
      "dtoExpiresAt": 1790715000000,
      "signature": "5c1e…9f1b"
    }
  }
}
```

**DTO field semantics:**

- `to`: receiver alias; MUST equal `payTo`.
- `tokenInstance`: the token class from `asset` plus `instance: "0"` (fungible).
- `quantity`: **decimal token units** as a string, the chain API's convention. `"1"` with `decimals: 8` corresponds to `amount: "100000000"`. The chain rejects more fractional digits than the class allows.
- `uniqueKey`: client-chosen, single-use on chain. Clients SHOULD use a random UUID with a recognisable prefix; the value is opaque to the facilitator.
- `dtoExpiresAt`: unix time in **milliseconds**; the chain rejects a DTO whose `dtoExpiresAt` is earlier than the peer's clock at execution (`ExpiredError`). Optional on GalaChain; REQUIRED by this scheme.
- `from`: MAY be omitted; the chain then debits the calling user, i.e. the signer (`dto.from ?? ctx.callingUser`). If present it MUST equal the payer, otherwise the chain treats the call as a transfer on someone else's behalf and looks for an allowance.
- `signature`: secp256k1 signature over `keccak256(payloadToSign)`, encoded as 130 hex characters `r ‖ s ‖ v` with `v` = `1b` or `1c` (low-`s` normalised). The recovery byte is REQUIRED: the chain recovers the signer from it, and the facilitator relies on the same property. `payloadToSign` is defined by `@gala-chain/api` `signatures.getPayloadToSign`: the DTO with `signature`, `multisig`, `trace` and `prefix` removed and serialised deterministically (sorted keys); if `prefix` is set it is prepended to the serialised string; if `domain` and `types` are both present the DTO is instead EIP-712 typed-data encoded. `prefix`, `domain` and `types` MAY therefore appear in the DTO — they are how wallets sign — and are covered by the signature.
- **Envelope fields that MUST be absent from `dto`:** `signerPublicKey`, `signerAddress`, `multisig`. When the public key is recoverable from `signature`, the chain rejects a DTO that also carries `signerPublicKey` or `signerAddress` as redundant, and `multisig` selects a different authentication mode. The payer's key travels in `payload.signerPublicKey` instead.

### `SettlementResponse`

```json
{
  "success": true,
  "transaction": "9fc797fda6a98926ec974a24ca1fa6f2b5603a131a5a637f53d815d70ffff419",
  "network": "galachain:mainnet",
  "payer": "eth|4Dd7f6016cF6d7084aAE30904824F3EEc11E2ebd"
}
```

- `transaction`: the GalaChain (Fabric) transaction id, 64 hex characters.
- `payer`: the alias derived from `signerPublicKey`. See the note on profile resolution under Security Considerations.

## Phase 2: Verification Logic

A facilitator MUST enforce every rule below, in order, before reporting `isValid: true`. Each rule names the `invalidReason` returned on failure.

1. **Envelope.** `x402Version` MUST be `2` (`invalid_exact_galachain_x402_version`); `accepted.scheme` and `requirements.scheme` MUST be `exact` (`unsupported_scheme`); `accepted.network` MUST equal `requirements.network` and be a network this facilitator serves (`network_mismatch`).
2. **Payload shape.** `payload.dto` MUST be an object (`invalid_exact_galachain_payload_missing_dto`); `payload.signerPublicKey` MUST be a string (`invalid_exact_galachain_payload_missing_signer_public_key`) that parses as a secp256k1 public key (`invalid_exact_galachain_payload_signer_public_key`); `dto.signature` MUST be present (`invalid_exact_galachain_payload_missing_signature`).
3. **Signature.** `dto.signature` MUST verify against the DTO and `signerPublicKey` using GalaChain's payload rules (`signatures.isValid` or an equivalent implementing `getPayloadToSign` as described above), and MUST carry a recovery byte (`invalid_exact_galachain_payload_signature`). The proven payer is `eth|` + the checksummed address of the uncompressed public key; it is reported as `payer` in every subsequent response.
4. **Single-signer envelope.** `dto.multisig`, `dto.signerAddress` and `dto.signerPublicKey` MUST be absent (`invalid_exact_galachain_payload_envelope`). If `dto.from` is present it MUST equal the proven payer (`invalid_exact_galachain_from_mismatch`).
5. **Replay primitive present.** `dto.uniqueKey` MUST be a non-empty string (`invalid_exact_galachain_missing_unique_key`).
6. **Destination.** `dto.to` MUST equal `requirements.payTo` (`invalid_exact_galachain_pay_to_mismatch`).
7. **Asset.** `dto.tokenInstance` encoded as `collection|category|type|additionalKey` MUST equal `requirements.asset` and be a class this facilitator supports (`invalid_exact_galachain_asset_mismatch`); `tokenInstance.instance` MUST be `"0"` (`invalid_exact_galachain_asset_instance_mismatch`).
8. **Amount exactness.** `dto.quantity` MUST parse as a **positive** decimal with at most `extra.decimals` fractional digits (`invalid_exact_galachain_quantity`; the chain's own validator accepts zero, so the facilitator rejects it), and its atomic value MUST equal `requirements.amount` exactly (`invalid_exact_galachain_amount_mismatch`).
9. **Validity window.** `dto.dtoExpiresAt` MUST be a finite number (`invalid_exact_galachain_missing_expiry`); MUST be later than now plus a safety margin of at least 1 s (`invalid_exact_galachain_expired`); `requirements.maxTimeoutSeconds` MUST be a finite number (`invalid_exact_galachain_requirements_timeout`); and `dtoExpiresAt` MUST NOT exceed now + `maxTimeoutSeconds` × 1000 + a skew allowance of at most 5 s (`invalid_exact_galachain_expiry_mismatch`). This is the client's protection against a resource server asking for an arbitrarily long-lived authorization; the facilitator enforces it because the chain does not know `maxTimeoutSeconds`.
10. **Dry run** (`authorization` flow). The facilitator MUST call the gateway `DryRun` endpoint with `{ "method": "TransferToken", "callerPublicKey": signerPublicKey, "dto": <dto without signature> }`. GalaChain executes the method as the given identity without authentication and without committing, and returns the simulated read/write set together with the method's own result. **The outer response reports `Status: 1` whenever the dry run itself ran; the simulated call's outcome is `Data.response`**, and the write set is returned even when that outcome is an error. The facilitator MUST require `Data.response.Status === 1`. The dry run executes the whole transaction wrapper except authentication — validation, expiry, `uniqueKey` enforcement, fee gate, handler — so it fails if the payer cannot cover `amount` plus the fee, and it fails with `UNIQUE_TRANSACTION_CONFLICT` if the `uniqueKey` is already consumed. An inner `ErrorKey` of `PAYMENT_REQUIRED` MUST map to `insufficient_funds`; `UNIQUE_TRANSACTION_CONFLICT` MUST map to `invalid_exact_galachain_duplicate`; any other inner error maps to `invalid_exact_galachain_dry_run_failed:<ErrorKey>`. A gateway-level failure (non-2xx or outer `Status: 0`) maps the same way from the outer `ErrorKey`.

Facilitators MAY add stricter policy (allowed assets, maximum amount, per-payer limits) and MUST NOT relax the rules above.

## Phase 3: Settlement Logic

The facilitator MUST re-run verification rules 1–9, then POST `payload.dto` **unchanged** (including `signature`) to the gateway `TransferToken` endpoint. It MUST NOT modify, re-serialise with different key order, or re-sign the DTO; any change invalidates the payer's signature. Rule 10 is not repeated at settlement: submission itself decides balance, fee and `uniqueKey`, and a dry run first would report a consumed key as a verification error instead of the settlement failure this section requires.

Outcomes:

| Gateway response | `SettlementResponse` |
| --- | --- |
| 2xx with `Status: 1` | `success: true`, `transaction` = the transaction id (see note below) |
| 409, or `ErrorKey: UNIQUE_TRANSACTION_CONFLICT` | `success: false`, `errorReason: invalid_exact_galachain_duplicate`, `transaction` = the transaction id named in the error message |
| 402, or `ErrorKey: PAYMENT_REQUIRED` | `success: false`, `errorReason: insufficient_funds` |
| any other error | `success: false`, `errorReason` = the gateway `ErrorKey`, or `unexpected_settle_error` if none |

**What a failed settlement leaves behind.** The transaction wrapper runs DTO validation, the expiry check and authentication first; only then does it record `uniqueKey`, and only then run the fee gate and handler. On an error result it commits *only* the `uniqueKey` record, discarding the balance, fee and usage-counter writes (`GalaContract.afterTransaction`). Consequences the facilitator and client MUST account for:

- A settlement that fails in the fee gate or handler (`PAYMENT_REQUIRED`, `INSUFFICIENT_BALANCE`, …) burns no fee and moves no funds, **but consumes the `uniqueKey`**. Resubmitting the same DTO returns 409 naming the *failed* transaction.
- A settlement that fails before the record — malformed DTO, expired `dtoExpiresAt`, bad signature — consumes nothing; the DTO could be resubmitted, though an expired one never succeeds.
- Therefore a client MUST sign a fresh DTO (new `uniqueKey`) after any settlement failure; the facilitator MUST NOT retry a failed payload.
- A `UNIQUE_TRANSACTION_CONFLICT` is raised before the record is written, so a duplicate submission commits nothing at all.

A consumed `uniqueKey` MUST be reported as settlement failure, never success, per `scheme_exact.md`. The transaction id in the response lets the caller reconcile which earlier submission consumed it.

**Transaction id on success.** At time of writing the public mainnet gateway's success response omits the transaction id. A facilitator that needs one SHOULD run an unsigned `DryRun` of the same DTO after the successful submit: the wrapper now finds the consumed `uniqueKey` and the inner response is `UNIQUE_TRANSACTION_CONFLICT` whose message names the transaction that consumed it (`Unique transaction key <k> is already saved for transaction <64 hex>`). This re-sends nothing signed, makes no Fabric proposal, and costs one gateway round trip. Facilitators MUST NOT re-present the signed DTO for this purpose, and SHOULD prefer a gateway that returns the id directly when one is available.

If the submission succeeds but the transaction id cannot be established (gateway error or timeout on the lookup), the facilitator MAY return `success: true` with an empty `transaction`, or `settlement_pending` per the core specification, and SHOULD document which.

## Payment Flows

`authorization` (default): verify → resource → settle, as described above. This is the only flow this specification declares.

An `upfront` flow (settle → resource) is mechanically possible on GalaChain but has not been exercised and is not declared here. A future revision MAY add it once an implementation has demonstrated it.

## Error Codes

Standard v2 codes (`insufficient_funds`, `invalid_payload`, `invalid_payment_requirements`, `invalid_scheme`, `invalid_network`, `unexpected_verify_error`, `unexpected_settle_error`, `settlement_pending`) apply. Scheme-specific values:

| Code | Rule | Meaning |
| --- | --- | --- |
| `invalid_exact_galachain_x402_version` | 1 | `x402Version` is not 2 |
| `unsupported_scheme` | 1 | scheme is not `exact` |
| `network_mismatch` | 1 | networks disagree or are unsupported |
| `invalid_exact_galachain_unsupported_asset_transfer_method` | — | `extra.assetTransferMethod` is not `transfer-token` |
| `invalid_exact_galachain_payload_missing_dto` | 2 | `payload.dto` absent or not an object |
| `invalid_exact_galachain_payload_missing_signer_public_key` | 2 | `payload.signerPublicKey` absent |
| `invalid_exact_galachain_payload_signer_public_key` | 2 | `payload.signerPublicKey` is not a secp256k1 public key |
| `invalid_exact_galachain_payload_missing_signature` | 2 | `dto.signature` absent |
| `invalid_exact_galachain_payload_signature` | 3 | signature does not verify for `signerPublicKey` |
| `invalid_exact_galachain_payload_envelope` | 4 | `dto` carries `multisig`, `signerAddress` or `signerPublicKey` |
| `invalid_exact_galachain_from_mismatch` | 4 | `dto.from` is not the signer |
| `invalid_exact_galachain_missing_unique_key` | 5 | `dto.uniqueKey` absent |
| `invalid_exact_galachain_pay_to_mismatch` | 6 | `dto.to` is not `payTo` |
| `invalid_exact_galachain_asset_mismatch` | 7 | token class is not `asset` or is unsupported |
| `invalid_exact_galachain_asset_instance_mismatch` | 7 | `tokenInstance.instance` is not `"0"` |
| `invalid_exact_galachain_quantity` | 8 | `dto.quantity` is malformed, zero, or has too many decimals |
| `invalid_exact_galachain_amount_mismatch` | 8 | atomic quantity is not `amount` |
| `invalid_exact_galachain_missing_expiry` | 9 | `dto.dtoExpiresAt` absent |
| `invalid_exact_galachain_expired` | 9 | `dtoExpiresAt` is in the past or inside the safety margin |
| `invalid_exact_galachain_requirements_timeout` | 9 | `maxTimeoutSeconds` is not a finite number |
| `invalid_exact_galachain_expiry_mismatch` | 9 | `dtoExpiresAt` exceeds `maxTimeoutSeconds` |
| `invalid_exact_galachain_dry_run_failed:<ErrorKey>` | 10 | the simulated call failed with an error other than `PAYMENT_REQUIRED` |
| `invalid_exact_galachain_duplicate` | 10 / settle | `uniqueKey` already consumed; at settle, `transaction` names the consuming transaction |

## Security Considerations

1. **Facilitator safety.** The facilitator has no key and no account on the payment path. The signed DTO debits only the signer, for `amount` plus the chain fee. There is no sponsorship to abuse and no gas to drain.
2. **Authorization scope.** The signature covers every DTO field except `multisig` and `trace` (rule 4 forbids the former; the latter is telemetry). `to`, `tokenInstance`, `quantity`, `uniqueKey` and `dtoExpiresAt` cannot be changed by the facilitator or the resource server without invalidating the signature (rule 3), and rules 6–8 pin them to the requirements. A resource server that changes its price after issuing requirements gets a payload that fails rule 8.
3. **EIP-712 signing and unsigned-field injection.** When a wallet signs the DTO as EIP-712 typed data, only fields enumerated in `types` are hashed. `@gala-chain/api` refuses to produce or verify a typed-data signature whose `types` do not cover every DTO field (a guard added after a 2026-08-18 mainnet incident in which a signature for one DTO type was replayed into `TransferToken` with injected fields). Facilitators MUST verify with a library that implements this guard and MUST NOT hand-roll typed-data verification.
4. **Replay.** `uniqueKey` is authoritative on chain and is consumed once the wrapper reaches the fee gate, whether the handler then succeeds or fails. A settled DTO cannot settle twice; a DTO that failed in the fee gate or handler cannot be retried. Nothing needs to be remembered off chain. Resource servers SHOULD still refuse to serve twice for one `transaction`.
5. **Duplicate delivery.** Resubmission is distinguishable at the gateway (409 with the consuming transaction id), so a resubmitted payload cannot cause a second success and the deduplication requirement of `scheme_exact.md` for indistinguishable methods does not apply.
6. **Anyone holding the signed DTO can submit it.** As with any facilitator-submitted method, the payload is a bearer instrument for exactly this transfer. A resource server that receives it at `/verify` could submit it directly to the gateway and withhold the resource. The client's exposure is bounded to `amount` plus one fee per signed DTO, and by `maxTimeoutSeconds` in time. Clients SHOULD cap the `maxTimeoutSeconds` they will sign and SHOULD NOT re-sign for the same resource while an earlier authorization is unresolved.
7. **Validity window.** The chain enforces `dtoExpiresAt` against the executing peer's clock; the facilitator enforces that it does not exceed `maxTimeoutSeconds` (rule 9). Without rule 9 a resource server could request a multi-year window and settle at leisure.
8. **Verify/settle race.** Payer balance can change between `DryRun` and `TransferToken`. The outcome is a settlement failure (`insufficient_funds`) that burns no fee and consumes the `uniqueKey`. The facilitator loses nothing; the resource server has served a resource it will not be paid for, which is inherent to the `authorization` flow; the client signs a fresh DTO if it wants to pay.
9. **Settlement atomicity.** Debit, credit and fee are written by one chaincode invocation and are committed only on a success result; on failure all three are discarded together. The `uniqueKey` record is the one write that commits on a late failure. There is no partial transfer and no soft failure reported as success.
10. **Alias resolution.** The chain resolves the recovered signer, and `to`, to registered user profiles; an alias with no profile is used as itself, so an unregistered key's payer alias is `eth|<address>`, which is what the facilitator reports. A key registered under a legacy `client|` alias is debited under that alias. Facilitators that need the exact debited alias MAY resolve the profile through the gateway; this specification does not require it.
11. **Fee schedule.** The `TransferToken` fee is a curator-defined `FeeCodeDefinition` and MAY step up with the payer's cumulative usage (`FeeThresholdUses`, acceleration types Additive/Multiplicative/Exponential). It is paid from the payer's GALA balance and burned unless a curator-defined split formula directs part of it to fee collectors; users holding a `FeeExemption` pay nothing. It was 1 GALA at the base tier on mainnet at time of writing. The dry run reports the exact fee the payer would be charged (`ErrorPayload.paymentQuantity` on `PAYMENT_REQUIRED`). Payments much smaller than the fee are fee-dominated; resource servers pricing micropayments SHOULD account for this.

Invariants:

| ID | Invariant | Enforced by |
| --- | --- | --- |
| I1 | The facilitator is never debited | It holds no key and appears in no DTO field |
| I2 | `payTo` is credited exactly `amount` of `asset` | Rules 6–8 over signed fields; one transfer per DTO |
| I3 | Only the signer is debited, by `amount` plus the fee | Rule 4; the fee gate charges `ctx.callingUser` |
| I4 | One `uniqueKey` settles at most once | Recorded before the fee gate and handler; committed on success and on late failure; conflict before any write |
| I5 | No signed payment outlives `maxTimeoutSeconds` (plus skew) | Rule 9 at verification; `dtoExpiresAt` on chain |
| I6 | Settlement success means the transfer and fee committed together | `afterTransaction` flushes business writes only on a success result |

## Implementer Notes

- **Signing.** Use `signatures.getSignature(dto, privateKey)` and `signatures.isValid(signature, dto, publicKey)` from `@gala-chain/api` rather than reimplementing the serialisation; key ordering, BigNumber handling, `prefix` and EIP-712 handling are all part of the signed bytes.
- **Address derivation.** `payer` is `eth|` + `signatures.getEthAddress(uncompressedHex)`; normalise other key encodings with `signatures.getNonCompactHexPublicKey` first. Compare aliases case-insensitively on the address part, but publish only checksummed forms.
- **Quantity conversion.** `dto.quantity` is decimal token units; `amount` is atomic. Convert with `extra.decimals` using exact decimal arithmetic, and reject quantities with more fractional digits than `decimals`.
- **Dry run is unsigned and nested.** The chain rejects a signed DTO on `DryRun` ("The dto should have no signature for dry run execution"); strip `signature` and pass the signer as `callerPublicKey`. Read the outcome from `Data.response.Status`, not from the outer `Status` and not from the presence of `writes`. Because the dry run enforces `uniqueKey`, it doubles as the transaction-id lookup after a successful submit.
- **Success response shape.** Check `Status === 1` in the body in addition to the HTTP status.
- **Stateless facilitator.** Because replay is on chain and the facilitator signs nothing, a facilitator for this scheme can run with no persistent state and no secrets.

## Appendix

### Gateway endpoints used

All under `<gateway>/asset/token-contract/`:

| Endpoint | Body | Used for |
| --- | --- | --- |
| `POST DryRun` | `{ "method": "TransferToken", "callerPublicKey": "<hex>", "dto": <unsigned dto> }` | Verification rule 10 |
| `POST TransferToken` | the signed `TransferTokenDto` | Settlement |
| `POST FetchBalances` | `{ "owner": "<alias>", "collection", "category", "type", "additionalKey" }` | Optional balance display / receipts |

Responses are `{ "Status": 1, "Data": … }` on success and `{ "Status": 0, "error": { "ErrorKey", "Message", … } }` on failure; HTTP status mirrors the error class (402 for `PAYMENT_REQUIRED`, 409 for `UNIQUE_TRANSACTION_CONFLICT`). A `DryRun` response is `{ "Status": 1, "Data": { "reads", "writes", "deletes", "response": <GalaChainResponse> } }`.

### Chain behaviour relied on (GalaChain SDK 3.2.5 and `main`)

| Claim | Source |
| --- | --- |
| Signer recovered from signature; `signerPublicKey`/`signerAddress` in the DTO rejected as redundant when recoverable; an alias with no profile resolves to itself | `chaincode/src/contracts/authenticate.ts` |
| Wrapper order: validate → expiry (`dtoExpiresAt` ms, `< Date.now()` on the peer) → authenticate → authorize → record `uniqueKey` → `before` (fee gate) → handler | `chaincode/src/contracts/GalaTransaction.ts` |
| On an error result only `UNTX` (uniqueKey) writes are flushed | `chaincode/src/contracts/GalaContract.ts` `afterTransaction` |
| Conflict raised before the uniqueKey record is written | `chaincode/src/services/UniqueTransactionService.ts` |
| `from` defaults to `ctx.callingUser`; `from` and `to` pass through `resolveUserAlias`; foreign `from` requires an allowance | `GalaChainTokenContract.TransferToken` (the SDK's reference contract), `chaincode/src/transfer/transferToken.ts` |
| Fee charged to `ctx.callingUser`; curator-defined schedule with usage thresholds; burned unless a split formula exists; zero under `FeeExemption` | `chaincode/src/fees/feeGateImplementations.ts`, `galaFeeGate.ts`, `splitFeeBurnAndTransfer.ts` |
| Signed bytes: strip `signature`/`multisig`/`trace`/`prefix`, prepend `prefix`, EIP-712 when `domain`+`types`; full-coverage guard | `@gala-chain/api` `utils/signatures/getPayloadToSign` |
| Signature encoding `r‖s‖v`, `v ∈ {1b,1c}`, low-`s` | `@gala-chain/api` `utils/signatures/eth` |
| `DryRun` runs the wrapper as `callerPublicKey` without authentication (so it enforces `uniqueKey`), rejects signed DTOs, returns inner `response` plus read/write set | `chaincode/src/contracts/GalaContract.ts` `DryRun` |

### Measured behaviour (GalaChain mainnet, 2026-09-29)

Reference implementation and receipts: [bnskaggs/x402-galachain](https://github.com/bnskaggs/x402-galachain).

- End-to-end `authorization` flow through the stock `@x402/core` 2.27 plugin interfaces with no core changes: HTTP 200, transaction `9fc797fda6a98926ec974a24ca1fa6f2b5603a131a5a637f53d815d70ffff419`, payer −2 GALA (1 payment + 1 fee), payee +1 GALA.
- Resubmitting a settled DTO: HTTP 409, `UNIQUE_TRANSACTION_CONFLICT`, message names the original transaction id, payer balance unchanged.
- Two concurrent submissions of one DTO: exactly one settled (payer −1.01, payee +0.01 for a 0.01 GALA payment). Seller double-settle: first settle succeeded with tx `505c281feaa01a7cdcf5a3d16630aa99f772d850b4849bfdcba77022b9fa61cf` (id obtained by the unsigned `DryRun` lookup), second returned `invalid_exact_galachain_duplicate` naming the same tx. Both re-run after the facilitator's dry-run handling was corrected.
- `DryRun` from an unfunded key: HTTP 200, outer `Status: 1`, `Data.response` = `PAYMENT_REQUIRED` ("burnTokens for payingUser: eth|…, quantity: 1, feeCode: TransferToken … Insufficient balance"), write set present. `DryRun` to a non-checksummed `eth|` alias: inner `DTO_VALIDATION_FAILED`. `DryRun` of a consumed `uniqueKey` from an unrelated unfunded caller: inner `UNIQUE_TRANSACTION_CONFLICT` naming the consuming transaction, ahead of the fee gate. `DryRun` of an expired DTO: inner `EXPIRED`, nothing consumed.
- Adversarial resource servers (take-and-run, price change, double settle, concurrent replay, pay-to swap, long validity window): every scenario resolved as this specification predicts; the naive stock client lost only what it had signed for, and a client enforcing rule 9 and its own pay-to/price pins lost nothing beyond fair payments.

### Known limitations

- The reference implementation supports the GALA token class only; the scheme itself is written for any fungible GalaChain token class.
- The `galachain` CAIP-2 namespace is proposed, not yet accepted; the network identifiers could change on editor feedback.
- The transaction-id gap on success is a gateway behaviour, not a chain property.
- Testnet has not been exercised.
