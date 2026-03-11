# Scheme: `escrow` on `EVM`

## Summary

The `escrow` scheme on EVM uses the [Commerce Payments Protocol](https://github.com/base/commerce-payments) contract stack:

- **Escrow** (`AuthCaptureEscrow`): Singleton — locks funds, enforces expiries, distributes on capture/refund
- **Operator**: Routes payments through escrow with fee management
- **Token Collector** (`ERC3009PaymentCollector`): Collects funds via `receiveWithAuthorization` signatures

The client signs a single ERC-3009 authorization. The facilitator submits it to the operator, which handles token collection, escrow locking, and fee distribution — all in one transaction.

The escrow scheme uses ERC-3009 (`receiveWithAuthorization`) exclusively. The commerce-payments token collector architecture supports pluggable collection methods; future collectors (e.g., Permit2) could be added via `assetTransferMethod` in `extra` without changing the scheme.

## PaymentRequirements

Escrow-accepting servers advertise with scheme `escrow`:

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "escrow",
      "network": "eip155:8453",
      "amount": "1000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0xReceiverAddress",
      "maxTimeoutSeconds": 60,
      "extra": {
        "name": "USDC",
        "version": "2",
        "escrowAddress": "0xEscrowAddress",
        "operatorAddress": "0xOperatorAddress",
        "tokenCollector": "0xCollectorAddress",
        "settlementMethod": "authorize",
        "minFeeBps": 0,
        "maxFeeBps": 1000,
        "feeReceiver": "0xOperatorAddress"
      }
    }
  ]
}
```

### `extra` Fields

| Field                        | Required | Type                      | Description                                        |
| :--------------------------- | :------- | :------------------------ | :------------------------------------------------- |
| `name`                       | Yes      | `string`                  | EIP-712 domain name for the token (e.g., `"USDC"`) |
| `version`                    | Yes      | `string`                  | EIP-712 domain version (e.g., `"2"`)               |
| `escrowAddress`              | Yes      | `address`                 | AuthCaptureEscrow contract address                 |
| `operatorAddress`            | Yes      | `address`                 | Operator address                                   |
| `tokenCollector`             | Yes      | `address`                 | Token collector contract address                   |
| `settlementMethod`           | No       | `"authorize" \| "charge"` | Settlement path. Default: `"authorize"`            |
| `minFeeBps`                  | No       | `uint16`                  | Minimum fee in basis points. Default: `0`          |
| `maxFeeBps`                  | No       | `uint16`                  | Maximum fee in basis points. Default: `0`          |
| `feeReceiver`                | No       | `address`                 | Fee recipient. Default: `address(0)` (no fees)     |
| `preApprovalExpirySeconds`   | No       | `uint48`                  | ERC-3009 signature validity / pre-approval expiry  |
| `authorizationExpirySeconds` | No       | `uint48`                  | Deadline for capturing escrowed funds              |
| `refundExpirySeconds`        | No       | `uint48`                  | Deadline for refund requests                       |

## PaymentPayload

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/resource",
    "method": "GET"
  },
  "accepted": {
    "scheme": "escrow",
    "network": "eip155:8453",
    "amount": "1000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xReceiverAddress",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USDC",
      "version": "2",
      "escrowAddress": "0xEscrowAddress",
      "operatorAddress": "0xOperatorAddress",
      "tokenCollector": "0xCollectorAddress",
      "settlementMethod": "authorize",
      "minFeeBps": 0,
      "maxFeeBps": 1000,
      "feeReceiver": "0xOperatorAddress"
    }
  },
  "payload": {
    "authorization": {
      "from": "0xPayerAddress",
      "to": "0xCollectorAddress",
      "value": "1000000",
      "validAfter": "0",
      "validBefore": "1740672154",
      "nonce": "0xf374...3480"
    },
    "signature": "0x2d6a...571c",
    "paymentInfo": {
      "operator": "0xOperatorAddress",
      "receiver": "0xReceiverAddress",
      "token": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "maxAmount": "1000000",
      "preApprovalExpiry": 1740672154,
      "authorizationExpiry": 4294967295,
      "refundExpiry": 281474976710655,
      "minFeeBps": 0,
      "maxFeeBps": 1000,
      "feeReceiver": "0xOperatorAddress",
      "salt": "0x0000...0001"
    }
  }
}
```

### Nonce Derivation

The ERC-3009 nonce is deterministically derived from the payment parameters:

```
nonce = keccak256(abi.encode(chainId, escrowAddress, paymentInfoHash))
```

This ties the off-chain signature to the specific escrow contract and payment terms, preventing cross-chain or cross-contract replay.

## Verification Logic

The facilitator performs these checks in order:

1. **Type guard**: Verify `payload` contains `authorization`, `signature`, and `paymentInfo` fields
2. **Scheme match**: Verify `requirements.scheme === "escrow"` and `payload.accepted.scheme === "escrow"`
3. **Network match**: Verify `payload.accepted.network === requirements.network` and format is `eip155:<chainId>`
4. **Extra validation**: Verify `requirements.extra` contains required escrow fields (`escrowAddress`, `operatorAddress`, `tokenCollector`)
5. **Time window**: Verify `validBefore > now + 6s` (not expired) and `validAfter <= now` (active)
6. **ERC-3009 signature**: Recover signer from EIP-712 typed data (`ReceiveWithAuthorization` primary type) and verify matches `authorization.from`
7. **Amount**: Verify `authorization.value === requirements.amount`
8. **Recipient match**: Verify `authorization.to === requirements.extra.tokenCollector`
9. **Token match**: Verify `paymentInfo.token === requirements.asset`
10. **Receiver match**: Verify `paymentInfo.receiver === requirements.payTo`
11. **Simulate** `operator.authorize(...)` or `operator.charge(...)` to ensure success

### EIP-6492 Support

For smart wallet clients, the signature may be EIP-6492 wrapped (containing deployment bytecode). The facilitator extracts the inner ECDSA signature for verification. The on-chain `ERC6492SignatureHandler` in the token collector handles wallet deployment during settlement.

## Settlement Logic

Settlement is performed by the facilitator calling the operator:

1. **Re-verify** the payload (catch expired/invalid payloads before spending gas)
2. **Determine function**: `settlementMethod === "charge" ? "charge" : "authorize"`
3. **Call operator**: `operator.<functionName>(paymentInfo, amount, tokenCollector, collectorData)`
4. **Wait for receipt**: Confirm transaction success with 60s timeout
5. **Return result**: Transaction hash, network, and payer address

The operator handles:

- Calling the token collector to execute `receiveWithAuthorization` with the client's signature (EIP-712 primary type: `ReceiveWithAuthorization`, not `TransferWithAuthorization`)
- Routing funds to escrow (authorize) or directly to receiver (charge)
- Validating fee bounds against the client-signed `PaymentInfo`

## Error Codes

The escrow scheme uses the standard x402 error codes plus these scheme-specific codes:

### Verification Errors

| Error Code                    | Description                                                                          |
| :---------------------------- | :----------------------------------------------------------------------------------- |
| `invalid_payload_format`      | Payload missing `authorization`, `signature`, or `paymentInfo`                       |
| `unsupported_scheme`          | Scheme is not `escrow`                                                               |
| `network_mismatch`            | Payload network does not match requirements                                          |
| `invalid_network`             | Network format is not `eip155:<chainId>`                                             |
| `invalid_escrow_extra`        | Missing required extra fields (`escrowAddress`, `operatorAddress`, `tokenCollector`) |
| `authorization_expired`       | `validBefore <= now + 6s`                                                            |
| `authorization_not_yet_valid` | `validAfter > now`                                                                   |
| `invalid_escrow_signature`    | ERC-3009 signature verification failed                                               |
| `amount_mismatch`             | `authorization.value !== requirements.amount`                                        |
| `token_collector_mismatch`    | `authorization.to !== extra.tokenCollector`                                          |
| `token_mismatch`              | `paymentInfo.token !== requirements.asset`                                           |
| `receiver_mismatch`           | `paymentInfo.receiver !== requirements.payTo`                                        |
| `insufficient_balance`        | Payer balance is less than required amount                                           |
| `simulation_failed`           | Settlement simulation via `eth_call` failed                                          |

### Settlement Errors

| Error Code             | Description                                      |
| :--------------------- | :----------------------------------------------- |
| `verification_failed`  | Re-verification before settlement failed         |
| `transaction_reverted` | On-chain transaction reverted after confirmation |

## Appendix

### PaymentInfo Struct

This struct is signed by the client and validated on-chain:

```solidity
struct PaymentInfo {
    address operator;           // Operator address
    address payer;              // Client wallet (authorization.from)
    address receiver;           // Fund recipient (payTo)
    address token;              // ERC-20 token address
    uint120 maxAmount;          // Maximum authorized amount
    uint48  preApprovalExpiry;  // ERC-3009 validBefore / pre-approval deadline
    uint48  authorizationExpiry;// Capture deadline (authorize path only)
    uint48  refundExpiry;       // Refund request deadline
    uint16  minFeeBps;          // Minimum acceptable fee (basis points)
    uint16  maxFeeBps;          // Maximum acceptable fee (basis points)
    address feeReceiver;        // Fee recipient (address(0) = flexible)
    uint256 salt;               // Client-provided entropy
}
```

### Expiry Ordering

The contract enforces: `preApprovalExpiry <= authorizationExpiry <= refundExpiry`

| Expiry                | Enforced At                | Effect                              |
| :-------------------- | :------------------------- | :---------------------------------- |
| `preApprovalExpiry`   | `authorize()` / `charge()` | Blocks settlement after this time   |
| `authorizationExpiry` | `capture()`                | Blocks capture; enables `reclaim()` |
| `refundExpiry`        | `refund()`                 | Blocks refund requests              |

### Fee System

Fees are enforced on-chain by the escrow contract:

- `minFeeBps` and `maxFeeBps` set by the client in `PaymentInfo` (0–10,000 bps)
- `feeBps` at capture/charge must fall within `[minFeeBps, maxFeeBps]`
- If `feeReceiver` is set in `PaymentInfo`, actual `feeReceiver` at capture/charge must match
- If `feeReceiver` is `address(0)`, the caller can specify any non-zero address
- Fee distribution: `feeAmount = amount * feeBps / 10000`, remainder goes to receiver
