# Scheme: `upto` on `EVM`

## Summary

The `upto` scheme on EVM enables usage-based payments where the Client (user) authorizes a **maximum amount**, and the Facilitator (server) settles for the **actual amount used** at the end of the request. This is ideal for variable-cost resources like LLM token generation, bandwidth metering, or time-based access.

This scheme uses the **Permit2** asset transfer method exclusively, leveraging the `permitWitnessTransferFrom` function to allow settling for any amount up to the signed maximum.

| AssetTransferMethod | Use Case                                                        | Notes                                           |
| :------------------ | :-------------------------------------------------------------- | :---------------------------------------------- |
| **Permit2**         | All ERC-20 tokens. Client signs max, server settles actual.     | Uses existing `x402Permit2Proxy` contract.      |

> **Note**: EIP-3009 (`transferWithAuthorization`) is **not supported** for the `upto` scheme because it requires exact amounts at signature time.

---

## Use Cases

- **LLM Token Generation**: Client authorizes up to $5, actual charge based on tokens generated
- **Bandwidth/Data Transfer**: Pay per byte transferred in a single request, up to a cap
- **Dynamic Compute**: Authorize max cost, charge based on actual compute resources consumed

---

## 1. AssetTransferMethod: `Permit2`

This scheme uses the `permitWitnessTransferFrom` from the [canonical **Permit2** contract](#canonical-permit2) combined with the [`x402Permit2Proxy`](#reference-implementation-x402permit2proxy) to enforce receiver address security via the "Witness" pattern.

The `permit.permitted.amount` represents the **maximum** authorized amount, while the actual settlement amount is determined by the server at settlement time.

### Phase 1: One-Time Gas Approval

Permit2 requires the user to approve the [**Permit2 Contract** (Canonical Address)](#canonical-permit2) to spend their tokens. This is a one-time setup. The specification supports three approval methods:

#### Option A: Direct User Approval (Standard)

The user submits a standard on-chain `approve(Permit2)` transaction paying their own gas.

- _Prerequisite:_ User must have Native Gas currency.

#### Option B: Sponsored ERC20 Approval (Extension: [`erc20ApprovalGasSponsoring`](../../extensions/erc20_gas_sponsoring.md))

The Facilitator pays the gas for the approval transaction on the user's behalf.

- _Prerequisite:_ Server supports this extension.
- _Flow:_ Facilitator batches the following transactions: `from.transfer(gas_amount)` -> `ERC20.approve(Permit2)` -> `settle`.

#### Option C: EIP2612 Permit (Extension: [`eip2612GasSponsoring`](../../extensions/eip2612_gas_sponsoring.md))

If the token supports EIP-2612, the user signs a permit authorizing Permit2.

- _Prerequisite:_ Token supports EIP-2612.
- _Flow:_ Facilitator calls `x402Permit2Proxy.settleWithPermit()`

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `signature`: The signature for `permitWitnessTransferFrom`.
- `permit2Authorization`: Parameters to reconstruct the message.

**Important Logic:** The `permit2Authorization.permitted.amount` represents the **maximum** amount the client is willing to pay. The actual amount charged will be determined at settlement and will be less than or equal to this maximum.

> **Requirement**: The `x402Permit2Proxy` contract will be deployed to the same address across all supported EVM chains using `CREATE2` to ensure consistent behavior and simpler integration.

**Facilitator Address Discovery:** The facilitator announces its address via the `/supported` endpoint in the `extra` field of each supported scheme. The client MUST include this `facilitatorAddress` in the `permit2Authorization.witness.facilitator` field when constructing the payment signature. This binds the authorization to a specific facilitator, preventing unauthorized settlement by other parties.

**Example PaymentRequired (402 Response):**

```json
{
  "x402Version": 2,
  "error": "PAYMENT-SIGNATURE header is required",
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "upto",
      "network": "eip155:84532",
      "amount": "5000000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "facilitatorAddress": "0xFacilitatorAddress1234567890123456789012"
      }
    }
  ]
}
```

**Example PaymentPayload (Client Request):**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/llm/generate",
    "description": "LLM text generation endpoint",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "upto",
    "network": "eip155:84532",
    "amount": "5000000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2"
    }
  },
  "payload": {
    "signature": "0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c",
    "permit2Authorization": {
      "permitted": {
        "token": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        "amount": "5000000"
      },
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "spender": "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
      "nonce": "0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480",
      "deadline": "1740672154",
      "witness": {
        "to": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        "facilitator": "0xFacilitatorAddress1234567890123456789012",
        "validAfter": "1740672089"
      }
    }
  }
}
```

### Phase 3: Verification Logic

The verifier must execute these checks in order:

1.  **Verify** `payload.signature` is valid and recovers to the `permit2Authorization.from`.

    - Note that `extra` must be converted to its ABI encoded version.

2.  **Verify** that the `client` has enabled the Permit2 approval.

    - if ERC20.allowance(from, Permit2_Address) < amount:
      - Check for **Sponsored ERC20 Approval** (Extension): Refers to [`erc20ApprovalGasSponsoring`](../../extensions/erc20_gas_sponsoring.md).
      - Check for **EIP2612 Permit** (Extension): Refers to [`eip2612GasSponsoring`](../../extensions/eip2612_gas_sponsoring.md).
      - **If neither exists:** Return `412 Precondition Failed` (Error Code: `PERMIT2_ALLOWANCE_REQUIRED`). This signals the client that a one-time Direct Approval transaction is required before retrying.

3.  **Verify** the `client` has sufficient balance of the `asset` to cover `amount`.

4.  **Verify** the `permit2Authorization.permitted.amount` equals the `amount` from requirements.

5.  **Verify** the `deadline` (not expired) and `witness.validAfter` (active).

6.  **Verify** the Token and Network match the requirement.

7.  **Simulation:**

    - _Standard:_ Simulate `x402Permit2Proxy.settle` with the full `amount` (worst case).
    - _With "Sponsored ERC20 Approval" (Extension):_ Simulate batch `transfer` -> `approve` -> `settle`.
    - _With "EIP2612 Permit" (Extension):_ Simulate `x402Permit2Proxy.settleWithPermit`.

### Phase 4: Settlement Logic

Settlement is performed by calling the `x402Permit2Proxy` with the **actual amount** to charge.

The server determines the actual amount based on resource consumption during the request (tokens generated, bytes transferred, time elapsed, etc.).

**Settlement Amount Rules:**

- The settled `amount` MUST be `<=` the authorized maximum
- The settled `amount` MAY be `0` (no charge if no usage occurred)
- The settled `amount` is determined by the resource server, not the client

**Settlement Process:**

1.  **Standard Settlement:**
    Call `x402Permit2Proxy.settle(permit, actualAmount, owner, witness, signature)` where `actualAmount <= permit.permitted.amount`.

2.  **With Sponsored ERC20 Approval (Extension):**
    If `erc20ApprovalGasSponsoring` is used, the facilitator must construct a batched transaction that executes the sponsored `ERC20.approve` call strictly before the `x402Permit2Proxy.settle` call.

3.  **With EIP-2612 Permit (Extension):**
    If `eip2612GasSponsoring` is used, call `x402Permit2Proxy.settleWithPermit`.

4.  **Zero Settlement:**
    If the settled `amount = 0`, no on-chain transaction is required. The authorization simply expires unused.

**Example SettlementResponse:**

```json
{
  "success": true,
  "transaction": "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  "network": "eip155:84532",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "amount": "2350000"
}
```

---

## 2. PaymentRequirements Schema

The `upto` scheme uses the following `PaymentRequirements` schema:

| Field Name          | Type     | Required | Description                                                                   |
| ------------------- | -------- | -------- | ----------------------------------------------------------------------------- |
| `scheme`            | `string` | Required | Must be `"upto"`                                                              |
| `network`           | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., "eip155:84532")         |
| `amount`            | `string` | Required | Phase-dependent: maximum amount at verification, actual amount at settlement  |
| `asset`             | `string` | Required | Token contract address                                                        |
| `payTo`             | `string` | Required | Recipient wallet address                                                      |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion                                   |
| `extra`             | `object` | Optional | Scheme-specific additional information (must include `name`, `version`, and `facilitatorAddress`) |

> **Note**: In the `upto` scheme, the `amount` field of `PaymentRequirements` is phase-dependent for server-to-facilitator communication:
>
> - At _verification_ time, `amount` represents the **maximum** amount the client authorizes.
> - At _settlement_ time, `amount` represents the **actual amount to settle**, which MUST be less than or equal to the previously authorized maximum.
>
> The actual settled amount is communicated by the resource server to the facilitator via the `amount` field in the settlement-time payment requirements. This allows the server to determine the final charge based on actual resource consumption without requiring additional fields or a separate settlement type.

---

## 3. SettlementResponse Schema Extension

The `upto` scheme extends the base [`SettlementResponse`](../../x402-specification-v2.md#53-settlementresponse-schema) with the actual settled amount:

| Field Name      | Type      | Required | Description                                                           |
| --------------- | --------- | -------- | --------------------------------------------------------------------- |
| `success`       | `boolean` | Required | Indicates whether the payment settlement was successful               |
| `errorReason`   | `string`  | Optional | Error reason if settlement failed (omitted if successful)             |
| `payer`         | `string`  | Optional | Address of the payer's wallet                                         |
| `transaction`   | `string`  | Required | Blockchain transaction hash (empty string if $0 settlement)           |
| `network`       | `string`  | Required | Blockchain network identifier in CAIP-2 format                        |
| `amount`        | `string`  | Required | Actual amount charged in atomic token units (may be 0)                |

---

## 4. Error Codes

The `upto` scheme uses the standard x402 error codes defined in the [x402 specification](../../x402-specification-v2.md#9-error-handling).

### Scheme-Specific Error Code

The `upto` scheme defines one additional error code:

- **`invalid_upto_evm_payload_settlement_exceeds_amount`**: Attempted to settle for more than the authorized `amount`

---

## Annex

### Canonical Permit2

The Canonical Permit2 contract address can be found at [https://docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments).

### Reference Implementation: `x402Permit2Proxy`

The `upto` scheme uses its own `x402UptoPermit2Proxy` contract (deployed at `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`), which is structurally similar to the `x402ExactPermit2Proxy` used by the [exact scheme](../exact/scheme_exact_evm.md#reference-implementation-x402permit2proxy) but includes a `facilitator` field in the witness struct for access control. The contract's `settle` function accepts an `amount` parameter that can be less than or equal to `permit.permitted.amount`, which enables the variable settlement amounts required by the `upto` scheme.

---

## Security Considerations

1. **Maximum Amount Authorization**: Clients should carefully consider the `amount` they authorize. While servers can only charge up to this amount, clients bear the risk of the full amount being charged.

2. **Server Trust**: The `upto` scheme requires clients to trust that servers will charge fair amounts based on actual usage. Malicious servers could charge up to `amount` regardless of actual usage.

3. **Signature Reuse Prevention**: The Permit2 nonce mechanism prevents signature reuse. Each authorization can only be settled once.

4. **Time Constraints**: Authorizations have explicit valid time windows (`deadline`, `validAfter`) to limit their lifetime and reduce exposure.

5. **Zero Settlement**: Allowing $0 settlements means unused authorizations naturally expire without on-chain transactions, reducing gas costs and blockchain bloat.

