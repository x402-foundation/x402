# Scheme: `batch-settlement` on `Hedera`

## Summary

The `batch-settlement` scheme on Hedera is a **capital-backed** network binding using stateless unidirectional payment channels, with the same channel mechanics as the [EVM binding](./scheme_batch_settlement_evm.md): clients deposit HTS tokens into an onchain escrow once and sign off-chain **cumulative vouchers** per request; servers verify vouchers with fast signature checks and claim them onchain periodically in batches, then sweep claimed funds to the receiver with a separate settle operation.

The binding is native to Hedera in three ways:

- **Any Hedera account key.** Vouchers, claim batches, refunds and deposit authorizations are raw signatures by Hedera account keys, ED25519 or ECDSA secp256k1, verified onchain through the Hedera Account Service system contract (HIP-632 `isAuthorizedRaw`). No EIP-1271, no EVM-only wallets.
- **HTS allowance deposits.** Escrow is funded from an HTS fungible-token allowance the payer grants once to the deposit collector (a natively signed `AccountAllowanceApproveTransaction`), plus a per-deposit signed authorization that binds the channel. There is no Permit2 or ERC-3009.
- **HAPI transport.** The facilitator submits contract calls as `ContractExecuteTransaction`s from its own account (it is the fee payer and `msg.sender`); reads use the Mirror Node `contracts/call` API. Clients never submit transactions during a paid request.

The scheme supports **dynamic pricing**: the client authorizes a maximum per-request, and the server charges the actual cost within that ceiling.

Network identifiers are `hedera:mainnet` and `hedera:testnet`. Contracts see EVM chain id `295` (mainnet) and `296` (testnet) in `block.chainid`.

---

## Channel Lifecycle

### Channel creation and deposits

A channel is created implicitly on the first deposit. The facilitator calls `deposit(config, amount, collector, collectorData)` on the escrow; the `HederaAllowanceDepositCollector` verifies the payer's deposit authorization through the Hedera Account Service and pulls `amount` of the HTS token from the payer into the escrow via the HTS system contract `transferFrom` (HIP-906), consuming the allowance the payer granted the collector. Deposits are sponsored by the facilitator (the client pays only for its one-time allowance approval).

Channel identity is derived from the same immutable config struct as EVM:
```solidity
struct ChannelConfig {
    address payer;              // Client account EVM address (alias or long-zero)
    address payerAuthorizer;    // Voucher-signing account EVM address (alias or long-zero), or address(0) to use payer
    address receiver;           // Server account, long-zero address of payTo
    address receiverAuthorizer; // Claim/refund authorizer account EVM address (alias or long-zero)
    address token;              // HTS token, long-zero address of the token id
    uint40  withdrawDelay;      // Seconds before timed withdrawal completes (15 min – 30 days)
    bytes32 salt;               // Differentiates channels with identical parameters
}
```
with `channelId = EIP712Hash(ChannelConfig)` under the `x402 Batch Settlement` domain (`version "1"`), bound to `block.chainid` and the deployed `x402BatchSettlementHedera` address.

### Address rules

Hedera entities are referred to by EVM address inside `ChannelConfig`, by Hedera entity id (`0.0.x`) on the x402 wire where the EVM binding uses addresses:

| Field | Value |
| --- | --- |
| `channelConfig.payer` | The client account's EVM address as the network resolves it: its EVM address alias when it has one (ECDSA accounts created through an alias), otherwise its long-zero address (`0x` + 12 zero bytes + 8-byte account number). Clients read it from the Mirror Node `/api/v1/accounts/{id}` `evm_address` field. |
| `channelConfig.payerAuthorizer` | EVM address (alias or long-zero, as resolved by the network) of the voucher-signing account (the client's own account by default), or `address(0)` to verify vouchers against `payer`. |
| `channelConfig.receiver` | Long-zero address of `PaymentRequirements.payTo`. |
| `channelConfig.receiverAuthorizer` | EVM address (alias or long-zero, as resolved by the network) of the account that signs claim batches and refunds (`extra.receiverAuthorizer`). The Hedera Account Service rejects the long-zero form for accounts that carry an EVM alias, so signers MUST use the Mirror Node `evm_address`. |
| `channelConfig.token` | Long-zero address of `PaymentRequirements.asset` (the HTS token id). |
| `PaymentRequirements.payTo`, `asset` | Hedera entity ids (`0.0.x`), as in the Hedera `exact` scheme. |
| `VerifyResponse.payer`, `SettleResponse.payer` | `channelConfig.payer` (EVM address). |
| `SettleResponse.transaction` | Hedera transaction id (`0.0.x@seconds.nanos`) of the submitted contract call. |

### Signatures

All signatures are raw Hedera account signatures over a 32-byte digest, hex encoded:

- **ED25519**: 64 bytes, the signature over the digest bytes.
- **ECDSA secp256k1**: 65 bytes `r || s || v` (`v` = 27 or 28) over the digest (no extra hashing).

The escrow and collector verify them with `isAuthorizedRaw(account, digest, signature)` on the Hedera Account Service (`0x16a`). Only accounts with a **single primitive key** are supported; threshold and key-list accounts are rejected. A reverting `isAuthorizedRaw` call (e.g. signature length not matching the key type) is treated as an invalid signature.

Digests:

| Signature | Digest | Signer |
| --- | --- | --- |
| Voucher | EIP-712 `Voucher(bytes32 channelId,uint128 maxClaimableAmount)` | `payerAuthorizer`, or `payer` when zero |
| Claim batch | EIP-712 `ClaimBatch(ClaimEntry[] claims)` | `receiverAuthorizer` |
| Refund | EIP-712 `Refund(bytes32 channelId,uint256 nonce,uint128 amount)` | `receiverAuthorizer` |
| Deposit authorization | `keccak256(abi.encode(DEPOSIT_TYPEHASH, channelId, token, amount, nonce, deadline, collector, chainId))`, `DEPOSIT_TYPEHASH = keccak256("HederaAllowanceDeposit(bytes32 channelId,address token,uint256 amount,uint256 nonce,uint256 deadline,address collector,uint256 chainId)")` | `payer` |

### Requests, vouchers, claim, settle, refund, withdrawal

Identical to the EVM binding: cumulative `maxClaimableAmount` vouchers, `claimWithSignature` batches across channels, permissionless `settle(receiver, token)`, cooperative `refundWithSignature` with a per-channel `refundNonce` that advances on every executed refund, and the payer-driven timed withdrawal escape hatch (`initiateWithdraw` / `finalizeWithdraw`, called by the payer through a HAPI `ContractExecuteTransaction` it pays for itself). See the EVM binding for the detailed semantics; only the signature verification differs.

### Account requirements

| Role | Requirement |
| --- | --- |
| Client (payer) | Holds the HTS token (associated) and has granted the network's deposit collector an HTS allowance covering its deposits (`AccountAllowanceApproveTransaction`, spender = collector contract id). HTS amounts are `int64`; deposits above `2^63-1` are rejected. Must have a single ED25519 or ECDSA key. |
| Server (receiver) | `payTo` account is associated with the token (or has auto-association capacity) so `settle` can deliver funds. |
| Receiver authorizer | A Hedera account (single primitive key). |
| Escrow contract | Associated with the token (`associateToken(token)` is permissionless; deployments also enable unlimited automatic associations). |
| Facilitator | Operator account funded with HBAR for gas; it is `msg.sender` of every deposit/claim/settle/refund call. |

---

## 402 Response (PaymentRequirements)

```json
{
  "scheme": "batch-settlement",
  "network": "hedera:testnet",
  "amount": "100000",
  "asset": "0.0.429274",
  "payTo": "0.0.5001",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "assetTransferMethod": "hts-allowance",
    "receiverAuthorizer": "0x000000000000000000000000000000000000138a",
    "withdrawDelay": 900,
    "minDeposit": "1000000"
  }
}
```

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `extra.assetTransferMethod` | `string` | yes | Always `"hts-allowance"`. |
| `extra.receiverAuthorizer` | `string` | yes | EVM address of the account that authorizes claims/refunds. |
| `extra.withdrawDelay` | `number` | yes | Withdrawal delay in seconds (15 min – 30 days). |
| `extra.minDeposit` | `string` | optional | Atomic deposit target; MUST be a positive integer `>= amount` when present. |
| `extra.channelState` | `object` | optional | Corrective-only server channel snapshot. |
| `extra.voucherState` | `object` | optional | Corrective-only signed voucher proof. |

`extra.name` / `extra.version` and `extra.feePayer` are not used: HTS tokens have no EIP-712 domain, and clients never build transactions.

---

## Client: Payment Construction

Payload types are `deposit`, `voucher` and `refund` exactly as in the EVM binding. The deposit authorization is Hedera-specific.

### Deposit Payload

```json
{
  "x402Version": 2,
  "accepted": { "...": "..." },
  "payload": {
    "type": "deposit",
    "channelConfig": {
      "payer": "0x8f6b3F4C0e4A9d1F6bC1F6C02Bb2b9E7a8c3D4e5",
      "payerAuthorizer": "0x8f6b3F4C0e4A9d1F6bC1F6C02Bb2b9E7a8c3D4e5",
      "receiver": "0x0000000000000000000000000000000000001389",
      "receiverAuthorizer": "0x000000000000000000000000000000000000138a",
      "token": "0x0000000000000000000000000000000000068cDa",
      "withdrawDelay": 900,
      "salt": "0x0000000000000000000000000000000000000000000000000000000000000000"
    },
    "voucher": {
      "channelId": "0xabc123...channelId",
      "maxClaimableAmount": "100000",
      "signature": "0x...raw account signature over the Voucher digest"
    },
    "deposit": {
      "amount": "1000000",
      "authorization": {
        "hederaAllowanceAuthorization": {
          "nonce": "1234567890",
          "deadline": "1770000000",
          "signature": "0x...raw account signature over the deposit digest"
        }
      }
    }
  }
}
```

`deposit.authorization.hederaAllowanceAuthorization`:

| Field | Description |
| --- | --- |
| `nonce` | Payer-chosen unique `uint256` (decimal string); the collector marks it used. |
| `deadline` | Unix timestamp (decimal string) after which the authorization is invalid. |
| `signature` | Raw account signature over the deposit digest defined above, binding `channelId`, `token`, `amount`, `nonce`, `deadline`, the collector address and the chain id. |

The voucher and refund payloads are unchanged from the EVM binding.

---

## Server: State & Forwarding

Identical to the EVM binding (per-channel state, request serialization, corrective 402 with `invalid_batch_settlement_hedera_cumulative_amount_mismatch`, payment response contract with `extra.chargedAmount` / `extra.channelState`). Local voucher verification resolves the `payerAuthorizer` account key from the Mirror Node and checks the raw signature off-chain; when the key cannot be resolved the server defers to the facilitator.

---

## Facilitator Interface

Uses the standard x402 facilitator interface (`/verify`, `/settle`, `/supported`). Payload shapes for `claim`, `settle` and enriched `refund` are the EVM ones (`receiver` / `token` as EVM addresses).

### GET /supported

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement",
      "network": "hedera:testnet",
      "extra": { "receiverAuthorizer": "0x000000000000000000000000000000000000138a" }
    }
  ],
  "extensions": [],
  "signers": { "hedera:*": ["0.0.5002"] }
}
```

`signers` lists the facilitator's fee-payer account ids.

### Verification Rules

A facilitator MUST enforce:

1. **Channel config consistency** (deposit, voucher, refund): the config's chain-bound EIP-712 hash must equal the claimed channel id.
2. **Token match**: `channelConfig.token` must equal the long-zero address of `asset`.
3. **Receiver match**: `channelConfig.receiver` must equal the long-zero address of `payTo`.
4. **Receiver authorizer match**: `channelConfig.receiverAuthorizer` must equal `extra.receiverAuthorizer`.
5. **Withdraw delay match and bounds**.
6. **Voucher signature**: resolve the signing account's key (Mirror Node); the account must have a single ED25519 or ECDSA key (`invalid_batch_settlement_hedera_unsupported_account_key` otherwise); verify the raw signature over the voucher digest exactly as `isAuthorizedRaw` would.
7. **Channel existence** (voucher/refund): positive balance.
8. **Deposit authorization** (deposit): fields present and well-formed; `deadline` in the future; nonce unused on the collector; signature valid for `payer`; `amount <= 2^63-1`; the payer's HTS allowance to the collector is at least `amount`.
9. **Balance check** (deposit): the payer's token balance covers the deposit.
10. **Association**: the escrow is associated with the token (deposit); the receiver (settle) and payer (refund) can receive the token.
11. **Deposit sufficiency / not below claimed**: as in the EVM binding.
12. **Signed refunds**: refund nonce equals the onchain `refundNonce`; the `Refund` digest binds the submitted amount.
13. **Simulation**: deposit, claim, settle and refund calls SHOULD be simulated through the Mirror Node `contracts/call` API (which executes the HAS and HTS system contracts) before submission.

The facilitator MUST return the channel snapshot (`balance`, `totalClaimed`, `withdrawRequestedAt`, `refundNonce`) in `/verify` `extra` and in `/settle` `extra.channelState`. `settlement_pending` is returned with the Hedera transaction id when a submitted transaction's record cannot be retrieved.

### Fee-payer isolation

The facilitator's account only pays gas and is never the source of value: deposits move tokens from the payer via the payer's allowance and signature, claims only update accounting, settle transfers escrowed funds to the receiver, refunds return escrow to the payer. Gas is bounded by explicit per-call gas limits.

---

## Error Codes

The EVM error table applies with the `invalid_batch_settlement_hedera_` prefix, minus the ERC-3009 / Permit2 / EIP-2612 / ERC-20-approval / ERC-6492 entries, plus:

| Error Code | Description |
| --- | --- |
| `invalid_batch_settlement_hedera_allowance_authorization_required` | Deposit payload is missing or has a malformed `hederaAllowanceAuthorization` |
| `invalid_batch_settlement_hedera_allowance_signature_invalid` | Deposit authorization signature does not verify for the payer's key |
| `invalid_batch_settlement_hedera_allowance_deadline_expired` | Deposit authorization `deadline` has passed |
| `invalid_batch_settlement_hedera_allowance_nonce_used` | Deposit authorization nonce was already consumed |
| `invalid_batch_settlement_hedera_allowance_insufficient` | Payer's HTS allowance to the collector is below the deposit amount |
| `invalid_batch_settlement_hedera_payer_account_not_found` | Signer account does not exist on the network |
| `invalid_batch_settlement_hedera_unsupported_account_key` | Signer account key is not a single ED25519 / ECDSA key |
| `invalid_batch_settlement_hedera_token_not_associated` | Escrow, receiver or payer cannot hold the token |
| `invalid_batch_settlement_hedera_amount_exceeds_int64` | Amount exceeds the HTS `int64` range |
| `invalid_batch_settlement_hedera_unsupported_asset_transfer_method` | `extra.assetTransferMethod` is not `hts-allowance` |
| `settlement_pending` | Submitted but confirmation could not be established; carries the transaction id |

---

## Security and Trust

The EVM binding's considerations apply. Additionally:

1. **Allowance scope.** The payer's HTS allowance is granted to the collector only; the collector pulls funds solely into the escrow and solely for a channel id the payer signed, so neither the facilitator nor a third party can redirect an allowance.
2. **Deposit replay.** Each deposit authorization carries a payer nonce consumed onchain and a deadline; the digest binds the collector address and chain id.
3. **Key types.** Signature verification is delegated to the Hedera Account Service, so a signature is valid iff the account's current key produced it; key rotation on the account invalidates future signatures by the old key.
4. **Mirror Node lag.** Facilitators read state from the Mirror Node, which lags consensus by seconds; post-write reads poll until the confirmed effect is visible, and clients recover from state loss through corrective 402s as in the EVM binding.

---

## Reference Implementation

Contracts: `contracts/evm/src/hedera/x402BatchSettlementHedera.sol` (escrow) and `contracts/evm/src/hedera/HederaAllowanceDepositCollector.sol` (collector), deployed per network with the Hiero SDK (no CREATE2). Deployed addresses are recorded in `@x402/hedera` (`BATCH_SETTLEMENT_DEPLOYMENTS`).

| Network | x402BatchSettlementHedera | HederaAllowanceDepositCollector |
| --- | --- | --- |
| `hedera:testnet` | `0.0.10463847` ([`0x…9FaA67`](https://hashscan.io/testnet/contract/0.0.10463847), [Sourcify verified](https://sourcify.dev/server/v2/contract/296/0x00000000000000000000000000000000009FaA67)) | `0.0.10463851` ([`0x…9FAA6B`](https://hashscan.io/testnet/contract/0.0.10463851), [Sourcify verified](https://sourcify.dev/server/v2/contract/296/0x00000000000000000000000000000000009FAA6B)) |
| `hedera:mainnet` | _not deployed_ | _not deployed_ |

SDK: `@x402/hedera/batch-settlement/{client,server,facilitator}`.

## Version History

| Version | Date | Changes | Authors |
| --- | --- | --- | --- |
| v1.0 | 2026-09-10 | Initial draft | @oemerfurkan |
