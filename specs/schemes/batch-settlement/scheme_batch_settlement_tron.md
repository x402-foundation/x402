# Scheme: `batch-settlement` on `TRON`

## Summary

The TRON binding implements capital-backed, unidirectional payment channels. The payer deposits
TRC-20 funds once, signs cumulative TIP-712 vouchers for requests, and the receiver later claims and
settles many vouchers on-chain. A cooperative refund returns unused funds.

The wire structures match the EVM binding where possible. TRON Base58Check addresses are accepted at
the protocol boundary and normalized to 20-byte hex for hashing, typed data, and contract calls.

## Networks and Contracts

| Network | Channel contract | ERC-3009 collector | Permit2 collector |
| --- | --- | --- | --- |
| `tron:728126428` | `TW9yNhTySkEHYfjnGQU2u4NAsdb1tW4fbm` | `TTWA7aWMdx4jfcbp8XRAS2JAd2sUhyF9qj` | `TAg5qqp1K9x5KeSTWnRa8LT79B5HUjzSHY` |
| `tron:3448148188` | `TWBwWHZWwH8TzrZnbxit1J645VGYY1K2fA` | `TJUQ3BQt4YFg8EeevjiUa5LbfSGz5BxzRW` | `TEp6bCqSEKAr99sCiqANC84RtRwx7xGbA4` |
| `tron:2494104990` | `TA3MZHMLsgi8JMU1DL8H4gKp1YjJKATibf` | `TRd1KBfy1iUs6R45oZrtbLUjtcSKzXAvPG` | `TNmfrxbKCHqPUTj9zHVfg4Dq8WNZXPyf1x` |

The channel TIP-712 domain is `{ name: "x402 Batch Settlement", version: "1", chainId,
verifyingContract: channelContract }`.

## Payment Requirements

`PaymentRequirements.extra` contains:

| Field | Required | Meaning |
| --- | --- | --- |
| `receiverAuthorizer` | Yes | Key authorized to approve claims and cooperative refunds |
| `withdrawDelay` | Yes | Withdrawal delay in seconds, from 900 through 2,592,000 |
| `name`, `version` | For ERC-3009 deposits | Token TIP-712 domain |
| `assetTransferMethod` | No | `eip3009` (default) or `permit2` |
| `channelState`, `voucherState` | Corrective 402 only | Server state used to resynchronize a client |

The receiver authorizer may be held by the resource server or advertised by the facilitator. It MUST
be non-zero and must match `channelConfig.receiverAuthorizer`.

## Channel Configuration and ID

```text
ChannelConfig(
  address payer,
  address payerAuthorizer,
  address receiver,
  address receiverAuthorizer,
  address token,
  uint40 withdrawDelay,
  bytes32 salt
)
```

The channel ID is the hash of the typed channel configuration under the network's channel-contract
domain. `payerAuthorizer` signs vouchers; it may equal the payer or be a delegated key.

## Request Payloads

The first request or a top-up uses `type: "deposit"`:

```json
{
  "type": "deposit",
  "channelConfig": {
    "payer": "TPayerAddress",
    "payerAuthorizer": "TPayerAddress",
    "receiver": "TReceiverAddress",
    "receiverAuthorizer": "TAuthorizerAddress",
    "token": "TTokenAddress",
    "withdrawDelay": 900,
    "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "voucher": {
    "channelId": "0x...",
    "maxClaimableAmount": "1000",
    "signature": "0x..."
  },
  "deposit": {
    "amount": "5000",
    "authorization": {
      "permit2Authorization": {
        "from": "0x...",
        "permitted": { "token": "0x...", "amount": "5000" },
        "spender": "0x...",
        "nonce": "1",
        "deadline": "1786500000",
        "witness": { "channelId": "0x..." },
        "signature": "0x..."
      }
    }
  }
}
```

An EIP-3009 deposit instead carries `erc3009Authorization` with `validAfter`, `validBefore`, `salt`,
and `signature`. Its signed `ReceiveWithAuthorization` sends the deposit to the configured collector;
the nonce is `keccak256(abi.encode(channelId, salt))`.

Subsequent requests use `type: "voucher"` with the same `channelConfig` and a voucher whose
`maxClaimableAmount` is cumulative. The voucher primary type is
`Voucher(bytes32 channelId,uint128 maxClaimableAmount)`.

The server MAY accept a `type: "refund"` payload carrying the latest voucher and an optional amount.
It enriches that request with current claim data and authorizer signatures before facilitator
settlement.

## Verification

For deposits, the facilitator MUST validate:

1. Scheme, network, channel ID, receiver, receiver authorizer, token, and withdrawal delay.
2. The deposit authorization selected by `assetTransferMethod`.
3. For Permit2: configured collector spender, token, deposit amount, channel witness, deadline,
   signature, and sufficient allowance.
4. For ERC-3009: token domain, collector recipient, deposit amount, derived nonce, time window, and
   signature.
5. The cumulative voucher signature and that `maxClaimableAmount` fits within post-deposit balance
   and is greater than already claimed value.

For vouchers and refunds, the facilitator verifies channel configuration, voucher signature,
on-chain channel existence, monotonic cumulative value, and balance bounds.

The resource server serializes same-channel requests with a bounded pending reservation. It rejects a
voucher whose cumulative value does not equal `chargedCumulativeAmount + requestAmount`, and returns
corrective `channelState`/`voucherState` when the client must resynchronize.

## Settlement and Deferred Actions

| Payload type | Action |
| --- | --- |
| `deposit` | Call channel `deposit` through the selected collector and return the updated channel state |
| `voucher` | No immediate transfer; persist the verified cumulative commitment |
| `claim` | Call `claimWithSignature` for a batch of vouchers and update accounting |
| `settle` | Transfer claimed-but-unsettled tokens for a receiver/token pair |
| enriched `refund` | Claim as needed, then call `refundWithSignature` cooperatively |

Successful deposit settlement returns the deposited amount and channel state. Voucher request
responses carry `chargedAmount`, channel state, and the latest signed voucher in `SettleResponse.extra`.

For every broadcast action (`deposit`, `claim`, `settle`, or `refund`), the facilitator waits for a
receipt using a configurable confirmation budget (90 seconds by default). If the budget expires,
receipt RPC fails, or receipt effect processing is indeterminate after broadcast, it returns
`success: false`, `errorReason: "settlement_pending"`, and the original transaction ID. An explicit
revert is terminal and also preserves the transaction ID. The original transaction MUST be
reconciled and MUST NOT be rebroadcast.

When an operation returns `settlement_pending`, the resource server MUST retain the corresponding
channel reservation until the original transaction reaches a terminal status. It commits channel
state after confirmed success and releases only the matching reservation after confirmed revert.
Status-query failures remain fail-closed and MUST NOT cause a reservation to be released merely
because its ordinary TTL elapsed.

## Error Codes

TRON errors use the prefix `invalid_batch_settlement_tron_`. Stable categories cover channel lookup
and ID mismatch, token/receiver/authorizer mismatch, invalid voucher signatures, cumulative amount
bounds, deposit authorization or allowance failures, channel busy/resynchronization, invalid refund
amounts, RPC reads, `settlement_pending`, and failed deposit/claim/settle/refund transactions. The exported names in
`typescript/packages/mechanisms/tron/src/batch-settlement/errors.ts` are the authoritative list.

## Security Considerations

- Vouchers are cumulative and MUST be monotonic relative to on-chain claimed state.
- A server MUST durably store its charged cumulative amount before accepting concurrent work.
- The receiver authorizer can approve claims and refunds; operators SHOULD isolate and rotate this key.
- `withdrawDelay` bounds unilateral exit risk and MUST stay within the contract limits.
- Deposit collectors and Permit2 addresses are network constants, never payload-selected contracts.
- A corrective 402 is part of state recovery, not authorization to reduce an already claimed amount.
