# Scheme: `upto` on `EVM`

## Summary

The `upto` scheme on EVM enables usage-based payments where the Client (user) authorizes a **maximum amount**, and the Facilitator (server) settles for the **actual amount used** at the end of the request. This is ideal for variable-cost resources like LLM token generation, bandwidth metering, or time-based access.

This scheme supports native **EIP-3009** authorization for compatible tokens and **Permit2** as the generic ERC-20 path.

| AssetTransferMethod | Use Case                                                    | Notes                                                                                  |
| :------------------ | :---------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| **EIP-3009**        | Tokens with native `receiveWithAuthorization`, such as USDC. | Pulls the signed maximum into `x402UptoERC3009Proxy`, pays actual, and refunds unused. |
| **Permit2**         | All ERC-20 tokens.                                          | Uses `x402UptoPermit2Proxy` to transfer only the actual amount.                        |

For backward compatibility, an omitted `assetTransferMethod` means `permit2`. Servers offering the
EIP-3009 path MUST publish `assetTransferMethod: "eip3009"` explicitly.

---

## Use Cases

- **LLM Token Generation**: Client authorizes up to $5, actual charge based on tokens generated
- **Bandwidth/Data Transfer**: Pay per byte transferred in a single request, up to a cap
- **Dynamic Compute**: Authorize max cost, charge based on actual compute resources consumed

---

## 1. AssetTransferMethod: `EIP-3009`

The `eip3009` asset transfer method uses `receiveWithAuthorization`. The client authorizes the
`x402UptoERC3009Proxy` to receive the maximum amount. At settlement, the proxy atomically:

1. receives the full maximum;
2. transfers the actual amount to `payTo`; and
3. refunds the remainder to the client.

`transferWithAuthorization` MUST NOT be used for this flow. A third party could submit it directly
to the token and transfer funds to the proxy without executing the payment and refund.

### Phase 1: `PAYMENT-SIGNATURE` Header Payload

The payload contains:

- `signature`: the client's `ReceiveWithAuthorization` signature;
- `authorization`: the standard EIP-3009 authorization;
- `paymentInfo`: the recipient, selected settler, and random salt committed through the nonce.

```json
{
  "payload": {
    "signature": "0x...",
    "authorization": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "<x402UptoERC3009Proxy>",
      "value": "5000000",
      "validAfter": "1740672089",
      "validBefore": "1740672154",
      "nonce": "0x..."
    },
    "paymentInfo": {
      "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
      "settler": "0xSettlerAddress",
      "salt": "0x..."
    }
  }
}
```

The authorization fields have the standard EIP-3009 meaning, with these additional requirements:

- `authorization.to` MUST equal the canonical `x402UptoERC3009Proxy`.
- `authorization.value` MUST equal the maximum `PaymentRequirements.amount`.
- `paymentInfo.payTo` MUST equal `PaymentRequirements.payTo`.
- `paymentInfo.settler` MUST equal `extra.settlerAddress`.
- `paymentInfo.salt` MUST be a fresh random 32-byte value.
- `authorization.nonce` MUST equal:

```text
NONCE_TYPEHASH = keccak256(
  "x402UptoERC3009Nonce(address payTo,address settler,bytes32 salt)"
)

authorization.nonce = keccak256(
  abi.encode(NONCE_TYPEHASH, paymentInfo.payTo, paymentInfo.settler, paymentInfo.salt)
)
```

The nonce is a hash commitment. EIP-3009 has no witness or arbitrary-data field, so the client sends
the commitment preimage in `paymentInfo` and the proxy recomputes it onchain.

`extra.settlerAddress` selects one address for each payment. A server settling directly uses an
address it controls. A server delegating settlement uses an address advertised by its facilitator.
The selected address MUST remain available until `authorization.validBefore`.

### Phase 2: Verification Logic

The verifier MUST:

1. validate the payload shape and EIP-712 `ReceiveWithAuthorization` signature;
2. verify the network and EIP-712 token domain from `extra.name` and `extra.version`;
3. verify `authorization.to`, `authorization.value`, `paymentInfo.payTo`, and
   `paymentInfo.settler` against the requirements;
4. recompute the nonce commitment from `paymentInfo`;
5. verify `validAfter`, `validBefore`, and that the authorization is unused;
6. verify the client balance covers the full signed maximum; and
7. simulate `x402UptoERC3009Proxy.settle` for the full maximum from the selected settler.

The full-maximum simulation is required even when the resource server expects a lower charge. The
client must still hold the entire maximum because the proxy receives it before refunding the unused
portion.

### Phase 3: Settlement Logic

At settlement, `PaymentRequirements.amount` carries the actual amount selected by the resource
server. The settler MUST:

1. re-verify the signature against `authorization.value`, not the settle-time amount;
2. require `0 < PaymentRequirements.amount <= authorization.value`; and
3. call:

```solidity
x402UptoERC3009Proxy.settle(
    requirements.asset,
    requirements.amount,
    authorization,
    paymentInfo,
    signature
);
```

The transaction MUST be sent by `paymentInfo.settler`. The proxy receives the full
`authorization.value`, transfers `requirements.amount` to `paymentInfo.payTo`, and refunds
`authorization.value - requirements.amount` to `authorization.from`. Any failure reverts the
entire transaction, including token receipt and nonce consumption.

If the settled amount is zero, no transaction is submitted and the authorization expires unused.
The onchain contract rejects zero-amount settlement.

### Token Compatibility

This method requires the `bytes signature` form of `receiveWithAuthorization` used by current USDC
deployments. Tokens that charge transfer fees, rebase during settlement, or otherwise fail to
transfer exact requested amounts are unsupported. Smart-wallet signature support depends on the
token's EIP-3009 implementation.

---

## 2. AssetTransferMethod: `Permit2`

This method uses `permitWitnessTransferFrom` from the [canonical **Permit2** contract](#canonical-permit2) combined with [`x402UptoPermit2Proxy`](#reference-implementation-x402uptopermit2proxy) to enforce receiver address security via the witness pattern.

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
- _Flow:_ Facilitator calls `x402UptoPermit2Proxy.settleWithPermit()`

### Phase 2: `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `signature`: The signature for `permitWitnessTransferFrom`.
- `permit2Authorization`: Parameters to reconstruct the message.

**Important Logic:** The `permit2Authorization.permitted.amount` represents the **maximum** amount the client is willing to pay. The actual amount charged will be determined at settlement and will be less than or equal to this maximum.

> **Requirement**: The `x402UptoPermit2Proxy` contract is deployed to the same address across all supported EVM chains using `CREATE2`.

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
        "assetTransferMethod": "permit2",
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
      "assetTransferMethod": "permit2",
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

    > **Note**: This check applies at **verification** time, where `requirements.amount` represents the authorized maximum. At **settlement** time, `requirements.amount` carries the actual settlement amount, which may be less than `permitted.amount`. See [Phase 4 — Settle-Time Verification](#settle-time-verification) for the required handling.

5.  **Verify** the `deadline` (not expired) and `witness.validAfter` (active).

6.  **Verify** the Token and Network match the requirement.

7.  **Simulation:**

    - _Standard:_ Simulate `x402UptoPermit2Proxy.settle` with the full `amount` (worst case).
    - _With "Sponsored ERC20 Approval" (Extension):_ Simulate batch `transfer` -> `approve` -> `settle`.
    - _With "EIP2612 Permit" (Extension):_ Simulate `x402UptoPermit2Proxy.settleWithPermit`.

### Phase 4: Settlement Logic

Settlement is performed by calling `x402UptoPermit2Proxy` with the **actual amount** to charge.

The server determines the actual amount based on resource consumption during the request (tokens generated, bytes transferred, time elapsed, etc.).

**Settlement Amount Rules:**

- The settled `amount` MUST be `<=` the authorized maximum
- The settled `amount` MAY be `0` (no charge if no usage occurred)
- The settled `amount` is determined by the resource server, not the client

#### Settle-Time Verification

Before executing an on-chain settlement, the facilitator MUST re-verify the client's signature. Because the `upto` scheme uses phase-dependent `amount` semantics (see [§3 PaymentRequirements Schema](#3-paymentrequirements-schema)), the `/settle` request will carry `paymentRequirements.amount` set to the **actual settlement amount** (as communicated by the resource server via `setSettlementOverrides`), which may be less than `paymentPayload.payload.permit2Authorization.permitted.amount` (the **authorized maximum** the client signed).

The facilitator MUST handle this case as follows:

1.  **Verify the signature against `permitted.amount`** — When re-verifying the client's signature at settle time, use `permit2Authorization.permitted.amount` (the ceiling from the signed payload), NOT `paymentRequirements.amount` (the actual settlement amount). The client signed for the ceiling; comparing against the metered amount would always fail for partial settlements.

2.  **Validate** `paymentRequirements.amount <= permit2Authorization.permitted.amount` — The actual settlement amount must not exceed the authorized maximum.

3.  **Execute the on-chain transfer for `paymentRequirements.amount`** — The `x402UptoPermit2Proxy.settle` call uses the actual settlement amount, not the ceiling.

> **Conformance note**: A facilitator that enforces `paymentRequirements.amount === permit2Authorization.permitted.amount` at settle time will reject all partial settlements, breaking the core `upto` value proposition. The Phase 3 step 4 equality check (`permitted.amount === requirements.amount`) applies only to the `/verify` endpoint, where `requirements.amount` carries the ceiling.

**Example settle request wire shape** (partial settlement):

```json
{
  "x402Version": 2,
  "paymentPayload": {
    "x402Version": 2,
    "accepted": { "scheme": "upto", "network": "eip155:84532", "amount": "20000", ... },
    "payload": {
      "signature": "0x...",
      "permit2Authorization": {
        "permitted": { "token": "0x036CbD53...", "amount": "20000" },
        "from": "<buyer>", "spender": "0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002",
        "nonce": "...", "deadline": "...",
        "witness": { "to": "<payTo>", "facilitator": "<facilitatorAddress>", "validAfter": "0" }
      }
    }
  },
  "paymentRequirements": {
    "scheme": "upto", "network": "eip155:84532",
    "asset": "0x036CbD53...", "payTo": "<payTo>",
    "amount": "1858"
  }
}
```

In this example, the buyer signed for up to `20000` atomic units. The resource server consumed `1858` units of work. The facilitator verifies the signature against `permitted.amount` (`20000`), confirms `1858 <= 20000`, then transfers `1858` on-chain.

**Settlement Process:**

1.  **Standard Settlement:**
    Call `x402UptoPermit2Proxy.settle(permit, actualAmount, owner, witness, signature)` where `actualAmount <= permit.permitted.amount`.

2.  **With Sponsored ERC20 Approval (Extension):**
    If `erc20ApprovalGasSponsoring` is used, the facilitator must construct a batched transaction that executes the sponsored `ERC20.approve` call strictly before the `x402UptoPermit2Proxy.settle` call.

3.  **With EIP-2612 Permit (Extension):**
    If `eip2612GasSponsoring` is used, call `x402UptoPermit2Proxy.settleWithPermit`.

4.  **Zero Settlement:**
    If the settled `amount = 0`, no on-chain transaction is required. The authorization simply expires unused.

If the settlement transaction broadcasts successfully but its confirmation cannot be established (e.g. a node/RPC error or timeout while waiting for the receipt), the facilitator MAY return `settlement_pending` (see [§9 Error Handling](../../x402-specification-v2.md#9-error-handling)) with the broadcast transaction hash in `transaction`, so the caller can reconcile on chain before retrying.

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

## 3. PaymentRequirements Schema

The `upto` scheme uses the following `PaymentRequirements` schema:

| Field Name          | Type     | Required | Description                                                                   |
| ------------------- | -------- | -------- | ----------------------------------------------------------------------------- |
| `scheme`            | `string` | Required | Must be `"upto"`                                                              |
| `network`           | `string` | Required | Blockchain network identifier in CAIP-2 format (e.g., "eip155:84532")         |
| `amount`            | `string` | Required | Phase-dependent: maximum amount at verification, actual amount at settlement  |
| `asset`             | `string` | Required | Token contract address                                                        |
| `payTo`             | `string` | Required | Recipient wallet address                                                      |
| `maxTimeoutSeconds` | `number` | Required | Maximum time allowed for payment completion                                   |
| `extra`             | `object` | Required | Method-specific fields, including `assetTransferMethod` and settlement authority |

For `eip3009`, `extra` MUST contain `assetTransferMethod: "eip3009"`, token-domain `name` and
`version`, and `settlerAddress`. For `permit2`, `extra` MUST contain
`assetTransferMethod: "permit2"` and `facilitatorAddress`; `name` and `version` are required when
the EIP-2612 gas-sponsoring extension is used.

> **Note**: In the `upto` scheme, the `amount` field of `PaymentRequirements` is phase-dependent for server-to-facilitator communication:
>
> - At _verification_ time, `amount` represents the **maximum** amount the client authorizes.
> - At _settlement_ time, `amount` represents the **actual amount to settle**, which MUST be less than or equal to the previously authorized maximum.
>
> The actual settled amount is communicated by the resource server to the facilitator via the `amount` field in the settlement-time payment requirements. This allows the server to determine the final charge based on actual resource consumption without requiring additional fields or a separate settlement type.

---

## 4. SettlementResponse Schema Extension

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

## 5. Error Codes

The `upto` scheme uses the standard x402 error codes defined in the [x402 specification](../../x402-specification-v2.md#9-error-handling).

### Scheme-Specific Error Code

The `upto` scheme defines these additional error codes:

- **`invalid_upto_evm_payload_settlement_exceeds_amount`**: Attempted to settle for more than the authorized `amount`
- **`invalid_upto_evm_eip3009_nonce_mismatch`**: EIP-3009 nonce does not commit to the supplied payment information
- **`invalid_upto_evm_eip3009_settler_mismatch`**: Bound settler does not match the requirements or facilitator submitter

---

## Annex

### Canonical Permit2

The Canonical Permit2 contract address can be found at [https://docs.uniswap.org/contracts/v4/deployments](https://docs.uniswap.org/contracts/v4/deployments).

### Reference Implementation: `x402UptoERC3009Proxy`

The EIP-3009 path uses `x402UptoERC3009Proxy` at
`0x40208Cd083acD9559Ce44742c4BcD9Cf04850006`. The pre-audit contract is
deterministically deployable at this address with CREATE2 on supported EVM chains.

### Reference Implementation: `x402UptoPermit2Proxy`

The `upto` scheme uses its own `x402UptoPermit2Proxy` contract (deployed at `0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002`), which is structurally similar to the `x402ExactPermit2Proxy` used by the [exact scheme](../exact/scheme_exact_evm.md#reference-implementation-x402permit2proxy) but includes a `facilitator` field in the witness struct for access control. The contract's `settle` function accepts an `amount` parameter that can be less than or equal to `permit.permitted.amount`, which enables the variable settlement amounts required by the `upto` scheme.

---

## Security Considerations

1. **Maximum Amount Authorization**: Clients should carefully consider the `amount` they authorize. While servers can only charge up to this amount, clients bear the risk of the full amount being charged.

2. **Server Trust**: The `upto` scheme requires clients to trust that servers will charge fair amounts based on actual usage. Malicious servers could charge up to `amount` regardless of actual usage.

3. **Signature Reuse Prevention**: Permit2 and EIP-3009 consume their signed nonces. Each authorization can only be settled once.

4. **Time Constraints**: Authorizations have explicit validity bounds to limit their lifetime and reduce exposure.

5. **Zero Settlement**: Allowing $0 settlements means unused authorizations naturally expire without on-chain transactions, reducing gas costs and blockchain bloat.

6. **EIP-3009 Full-Balance Requirement**: EIP-3009 settlement temporarily pulls the maximum and
   refunds the unused amount. The client must retain the full maximum until settlement, and both
   outgoing transfers must succeed atomically.

7. **Bound Settlement Authority**: The EIP-3009 path is not an arbitrary-relayer design. Only the
   address committed as `paymentInfo.settler` may select the actual charge. That address has the
   same ability as the Permit2 facilitator to charge any amount up to the signed maximum.

