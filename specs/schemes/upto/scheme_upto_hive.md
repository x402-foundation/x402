# Scheme: `upto` on `Hive`

## Versions Supported

- ✅ `v1`
- ❌ `v2` — planned for future alignment once a Hive implementation exists

## Supported Networks

- `hive:mainnet` — Hive mainnet

## Summary

The `upto` scheme on Hive enables usage-based payments where the Client authorizes a **maximum HBD amount**, and the Facilitator settles for the **actual amount consumed** at the end of the request. This is ideal for variable-cost resources like LLM token generation, bandwidth metering, or compute-based pricing.

This scheme uses Hive's **native escrow operations** to enforce maximum-amount authorization with flexible settlement. The Client creates an `escrow_transfer` with the maximum amount, and the Facilitator acts as the escrow **agent** — releasing the actual amount to the resource server and returning the remainder to the Client.

| Property | Value |
|:---|:---|
| **Network** | `hive:mainnet` |
| **Asset** | HBD (Hive Backed Dollars, $1 peg) |
| **Fee Model** | Zero fees (no gas, no sponsoring needed) |
| **Finality** | ~3 seconds (irreversible) |
| **Signature Scheme** | secp256k1 (Hive active key authority) |
| **Chain ID** | `beeab0de00...00` (32 bytes) |
| **Authorization Mechanism** | Hive escrow operations |

## Use Cases

- **LLM Token Generation**: Client authorizes up to 5.000 HBD, actual charge based on tokens generated
- **Bandwidth/Data Transfer**: Pay per byte transferred in a single request, up to a cap
- **Dynamic Compute**: Authorize max cost, charge based on actual compute resources consumed

---

## Protocol Flow

1. **Client** makes a request to a **Resource Server**.
2. **Resource Server** responds with `402 Payment Required` and an `x-payment` header containing base64-encoded `PaymentRequired` with Hive upto requirements.
3. **Client** generates a random 16-byte nonce for replay protection.
4. **Client** fetches the current block reference (`head_block_number`, `head_block_id`) from a Hive API node.
5. **Client** constructs a transaction with a single `escrow_transfer` operation, creating an escrow with the **maximum** HBD amount and designating the Facilitator as the escrow agent.
6. **Client** signs the transaction with their **active private key** using `cryptoUtils.signTransaction(tx, activeKey, chainId)`. The transaction is **not broadcast**.
7. **Client** base64-encodes the `PaymentPayload` (containing the signed transaction and nonce) and sends a new request to the Resource Server with the `x-payment` header.
8. **Resource Server** forwards the `PaymentPayload` and `PaymentRequirements` to the **Facilitator's** `/verify` endpoint (with the payment amount field set to the maximum authorized).
9. **Facilitator** verifies the transaction structure, signature, escrow parameters, and nonce.
10. **Resource Server** processes the request and determines the actual cost.
11. **Resource Server** forwards the `PaymentPayload` and updated `PaymentRequirements` to the **Facilitator's** `/settle` endpoint (with the payment amount field set to the actual cost).
12. **Facilitator** broadcasts the escrow transaction, then executes `escrow_release` for the actual amount and `escrow_release` for the remainder back to the Client.
13. **Resource Server** grants the **Client** access to the resource upon successful settlement.

---

## `PaymentRequirements` for `upto`

**v1 example:**

```json
{
  "x402Version": 1,
  "scheme": "upto",
  "network": "hive:mainnet",
  "maxAmountRequired": "5.000 HBD",
  "resource": "https://api.example.com/llm/generate",
  "description": "LLM text generation — charged per token",
  "mimeType": "application/json",
  "payTo": "api-provider",
  "validAfter": "2026-02-25T11:55:00Z",
  "validBefore": "2026-02-25T12:05:00Z",
  "extra": {
    "facilitatorAccount": "x402.ecency"
  }
}
```

**Field Definitions:**

| Field | Type | Description |
|:---|:---|:---|
| `x402Version` | `number` | Protocol version. Must be `1`. |
| `scheme` | `string` | Must be `"upto"`. |
| `network` | `string` | Must be `"hive:mainnet"`. |
| `maxAmountRequired` | `string` | Phase-dependent: maximum at verification, actual amount at settlement. HBD format: `"X.XXX HBD"`. |
| `resource` | `string` | URL of the protected resource. |
| `description` | `string?` | Human-readable description of the resource. |
| `mimeType` | `string?` | MIME type of the resource content. |
| `payTo` | `string` | Hive account name that will receive payment. |
| `validAfter` | `string` | ISO 8601 timestamp before which the payment requirements are not valid. |
| `validBefore` | `string` | ISO 8601 timestamp after which the payment requirements expire. |
| `extra` | `object` | Must include `facilitatorAccount` — the Hive account acting as escrow agent. |

> **Phase-Dependent Payment Amount:** The `maxAmountRequired` field is phase-dependent. At verification time, this is the maximum the client authorizes. At settlement time, the resource server sets this to the actual amount to charge. The facilitator MUST verify the settlement amount does not exceed the authorized maximum.

---

## `PaymentPayload` `payload` Field

The `payload` field of the `PaymentPayload` contains:

- `signedTransaction`: A fully signed Hive transaction containing an `escrow_transfer` operation.
- `nonce`: A 16-byte random hex string (32 characters) used for replay protection.
- `escrowId`: The escrow ID (uint32) used in the `escrow_transfer`.

**Full `PaymentPayload` object:**

```json
{
  "x402Version": 1,
  "scheme": "upto",
  "network": "hive:mainnet",
  "payload": {
    "signedTransaction": {
      "ref_block_num": 54321,
      "ref_block_prefix": 2876543210,
      "expiration": "2026-02-25T12:01:00",
      "operations": [
        [
          "escrow_transfer",
          {
            "from": "alice",
            "to": "api-provider",
            "agent": "x402.ecency",
            "escrow_id": 12345678,
            "hbd_amount": "5.000 HBD",
            "hive_amount": "0.000 HIVE",
            "fee": "0.000 HBD",
            "ratification_deadline": "2026-02-25T12:03:00",
            "escrow_expiration": "2026-02-25T12:05:00",
            "json_meta": "{\"protocol\":\"x402\",\"nonce\":\"a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6\"}"
          }
        ]
      ],
      "extensions": [],
      "signatures": [
        "2030a1b2c3d4...65-byte-hex-encoded-signature..."
      ]
    },
    "nonce": "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    "escrowId": 12345678
  }
}
```

### Payload Construction

The Client constructs the payment as follows:

1. **Generate nonce**: 16 random bytes → hex string (32 characters).
2. **Generate escrow ID**: A random uint32 to uniquely identify this escrow.
3. **Fetch block reference**: Query `database.getDynamicGlobalProperties()` from a Hive API node.
4. **Set deadlines**:
   - `ratification_deadline`: Current UTC + 120 seconds. The agent must approve before this.
   - `escrow_expiration`: Current UTC + 300 seconds. After this, the escrow can be released by either party.
5. **Construct `escrow_transfer` operation**:
   - `from`: Client's Hive account name
   - `to`: `paymentRequirements.payTo`
   - `agent`: `paymentRequirements.extra.facilitatorAccount`
   - `escrow_id`: The generated escrow ID
   - `hbd_amount`: `paymentRequirements.maxAmountRequired` — the maximum authorized
   - `hive_amount`: `"0.000 HIVE"` (only HBD is used)
   - `fee`: `"0.000 HBD"` (Facilitator does not charge an escrow agent fee)
   - `ratification_deadline`: As computed above
   - `escrow_expiration`: As computed above
   - `json_meta`: `{"protocol":"x402","nonce":"{nonce}"}`
6. **Sign transaction**: `cryptoUtils.signTransaction(tx, activePrivateKey, chainId)` where `chainId` = `beeab0de00...00` (Hive mainnet, 32 bytes).
7. **Encode**: Base64-encode the JSON `PaymentPayload` and set as the `x-payment` request header.

> **Important:** The transaction is signed but **NOT** broadcast by the Client. Only the Facilitator broadcasts.

---

## Facilitator Verification Rules (MUST)

A facilitator verifying an `upto` scheme on Hive MUST enforce all of the following checks:

### 1. Transaction Structure

- The signed transaction MUST contain exactly **one operation**.
- The operation type MUST be `"escrow_transfer"`.

### 2. Escrow Parameters

- `escrow_transfer.to` MUST equal `paymentRequirements.payTo`.
- `escrow_transfer.agent` MUST equal the Facilitator's own Hive account.
- `escrow_transfer.hbd_amount` MUST end with `" HBD"`. Only HBD is accepted.
- The numeric portion of `escrow_transfer.hbd_amount` MUST be ≥ the numeric portion of `paymentRequirements.maxAmountRequired`.
- `escrow_transfer.hive_amount` MUST be `"0.000 HIVE"`.
- `escrow_transfer.fee` MUST be `"0.000 HBD"` (zero agent fee).

### 3. Temporal Validity

- The current time MUST be ≥ `paymentRequirements.validAfter` (authorization is not yet active before this).
- `paymentRequirements.validBefore` MUST be in the future.
- `signedTransaction.expiration` MUST be in the future.
- `escrow_transfer.ratification_deadline` MUST be in the future and within a reasonable window (≤ 300 seconds from now).
- `escrow_transfer.escrow_expiration` MUST be after `ratification_deadline`.

### 4. Signature Verification

- The transaction MUST have at least one signature.
- Compute the transaction digest: `cryptoUtils.transactionDigest(signedTx, chainId)`.
- Recover the public key: `Signature.fromString(signatures[0]).recover(digest)`.
- Fetch the sender's account: `database.getAccounts([escrow_transfer.from])`.
- The recovered public key MUST match at least one entry in the account's `active.key_auths` array.

### 5. Replay Protection

- The `payload.nonce` MUST NOT have been previously spent.
- The `json_meta` in the escrow MUST contain a `nonce` field matching `payload.nonce`.

### 6. Metadata Validation

- `escrow_transfer.json_meta` MUST be valid JSON.
- The parsed JSON MUST contain `"protocol": "x402"`.

### Verification Response

```json
{
  "isValid": true,
  "payer": "alice"
}
```

---

## Settlement Logic

Settlement in the `upto` scheme is a multi-step process where the Facilitator broadcasts the escrow, approves it as agent, and releases the actual amount.

### Phase 1: Re-verification

1. **Check nonce**: Confirm the nonce has not been spent since initial verification.
2. **Validate settlement amount**: The `maxAmountRequired` field in the settlement-time `PaymentRequirements` represents the **actual** amount to charge. This MUST be ≤ the `hbd_amount` in the signed `escrow_transfer`.
3. **Re-verify**: Run the full verification logic above (using the original authorized maximum for amount checks).

### Phase 2: Broadcast Escrow

1. **Broadcast the escrow transaction**: `client.broadcast.send(signedTransaction)` to submit the `escrow_transfer` to the Hive network.
2. **Failover**: Use multiple Hive API nodes with automatic failover.

### Phase 3: Agent Approval

1. **Approve the escrow**: The Facilitator broadcasts an `escrow_approve` operation:
   ```json
   {
     "from": "alice",
     "to": "api-provider",
     "agent": "x402.ecency",
     "who": "x402.ecency",
     "escrow_id": 12345678,
     "approve": true
   }
   ```
2. This operation is signed with the **Facilitator's active key**.

### Phase 4: Release Funds

1. **Release actual amount to resource server**: The Facilitator broadcasts an `escrow_release` operation:
   ```json
   {
     "from": "alice",
     "to": "api-provider",
     "agent": "x402.ecency",
     "who": "x402.ecency",
     "receiver": "api-provider",
     "escrow_id": 12345678,
     "hbd_amount": "2.350 HBD",
     "hive_amount": "0.000 HIVE"
   }
   ```
   Where `hbd_amount` is the **actual amount** to charge (from settlement-time `maxAmountRequired`).

2. **Release remainder to client**: If `actual < maximum`, the Facilitator broadcasts a second `escrow_release`:
   ```json
   {
     "from": "alice",
     "to": "api-provider",
     "agent": "x402.ecency",
     "who": "x402.ecency",
     "receiver": "alice",
     "escrow_id": 12345678,
     "hbd_amount": "2.650 HBD",
     "hive_amount": "0.000 HIVE"
   }
   ```

3. **Zero Settlement**: If the actual amount is `"0.000 HBD"`, the Facilitator releases the **entire** escrow back to the Client. No funds are transferred to the resource server.

### Phase 5: Finalize

1. **Mark nonce spent**: Only after successful escrow release(s), mark the nonce as spent.
2. **Return `SettleResponse`**:

```json
{
  "success": true,
  "txId": "abc123def456789...",
  "blockNum": 12345678,
  "payer": "alice",
  "amount": "2.350 HBD"
}
```

### Settlement Guarantees

- **Zero cost**: Hive transactions have no fees. All escrow operations are feeless.
- **Atomic escrow**: The escrow is enforced at the blockchain level — the Facilitator cannot release more than the escrowed amount.
- **Maximum enforcement**: The signed `escrow_transfer` locks exactly the maximum amount. The Facilitator can only release up to this amount.
- **Non-modifiable**: The Client's signed transaction cannot be altered by the Facilitator.
- **Replay-safe**: Each nonce can only be settled once.
- **Client protection**: If the Facilitator fails to settle before `escrow_expiration`, the Client can reclaim their funds.

---

## `SettleResponse` Schema Extension

The `upto` scheme on Hive extends the base `SettleResponse` with the actual settled amount:

| Field | Type | Description |
|:---|:---|:---|
| `success` | `boolean` | Whether settlement was successful |
| `txId` | `string?` | Transaction hash of the escrow broadcast |
| `blockNum` | `number?` | Block number of the escrow broadcast |
| `payer` | `string?` | Hive account that paid |
| `amount` | `string?` | Actual amount charged in HBD format (e.g., `"2.350 HBD"`) |
| `errorReason` | `string?` | Error reason if settlement failed |

---

## Security Considerations

1. **Maximum Amount Authorization**: Clients should carefully consider the `maxAmountRequired` they authorize. While the Facilitator can only charge up to this amount, a malicious Facilitator could charge the full maximum regardless of actual usage.

2. **Agent Trust**: The Facilitator serves as the escrow agent. Clients must trust the Facilitator to release funds fairly. However, the escrow mechanism provides a safety net — if the agent does not act before `escrow_expiration`, either party can release funds.

3. **Escrow Expiration Safety**: The `escrow_expiration` provides a time-bound guarantee. If the Facilitator becomes unresponsive, the Client can reclaim funds after expiration.

4. **Replay Protection**: The nonce mechanism prevents the same escrow authorization from being settled twice.

5. **Zero Settlement**: Allowing zero-amount settlements means unused authorizations result in full refund to the Client, with minimal on-chain overhead (the escrow operations still execute but no value transfers to the server).

6. **Fee Field**: The `fee` field in `escrow_transfer` MUST be `"0.000 HBD"` — the Facilitator does not extract an agent fee through the escrow mechanism. Any Facilitator compensation should be handled out-of-band.

---

## Implementer Notes

- **Hive Escrow Operations**: Hive natively supports `escrow_transfer`, `escrow_approve`, `escrow_release`, and `escrow_dispute` operations. These are first-class blockchain operations — no smart contracts required.

- **Escrow ID Uniqueness**: The `escrow_id` is a uint32 scoped to the `from` account. Implementations should generate random IDs and handle the unlikely collision case.

- **Agent Key**: The Facilitator must hold an **active key** for its Hive account to sign `escrow_approve` and `escrow_release` operations.

- **Transaction Batching**: The `escrow_approve` and `escrow_release` operations can potentially be batched into fewer transactions where Hive node software supports it, reducing settlement latency.

- **Hive API Nodes**: Use multiple public nodes with failover: `api.hive.blog`, `api.deathwing.me`, `techcoderx.com`, `rpc.ausbit.dev`, `hive-api.arcange.eu`.

- **Asset Format**: HBD amounts use exactly 3 decimal places: `"2.350 HBD"`. Use `formatHBD()` for consistency.

- **Comparison with EVM `upto`**: The EVM scheme uses Permit2's `permitWitnessTransferFrom` to authorize a maximum amount. Hive's escrow operations provide equivalent semantics natively — the `escrow_transfer` locks the maximum, and `escrow_release` settles for the actual amount. The key difference is that Hive escrows require an explicit agent approval step, which adds one extra transaction but provides stronger guarantees (the agent cannot silently drain funds).

---

## Reference Implementation

No reference implementation is published yet for Hive `upto`. One possible middleware API shape could look like:

```ts
import { paywall } from "some-hive-x402-middleware";

app.get("/llm/generate", paywall({
  amount: async ({ raw: req }) => {
    // Dynamic pricing based on request parameters
    const model = req.query.model ?? "default";
    return model === "premium" ? "5.000 HBD" : "1.000 HBD";
  },
  receivingAccount: "api-provider",
  facilitatorUrl: "https://x402.ecency.com",
  extra: { facilitatorAccount: "x402.ecency" },
}), handler);
```
