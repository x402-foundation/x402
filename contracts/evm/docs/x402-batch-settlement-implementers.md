# x402BatchSettlement — implementer notes

Operational and edge-case details for integrators (wallets, indexers, relayers, and services using the batch-settlement EVM contract). This is not a full protocol spec; see the [EVM contracts README](../README.md) for deployment addresses and build tooling, and the repository `specs/` tree for other x402 scheme documents.

## Role of the contract

`x402BatchSettlement` is a **stateless** unidirectional channel: channel identity is `channelId = getChannelId(channelConfig)`, where `channelConfig` is an immutable `ChannelConfig`. The contract is intended to deploy at the **same address on every chain** via CREATE2 (see `README.md` vanity prefixes and deploy scripts).

## On-chain vs off-chain state

The contract persists:

| Storage | Meaning |
|--------|---------|
| `channels[channelId]` | Per-channel `balance` (escrow) and cumulative `totalClaimed` (receiver-attributed obligation against that escrow). |
| `pendingWithdrawals[channelId]` | Timed payer withdrawal in progress (`amount`, `initiatedAt`). |
| `refundNonce[channelId]` | Monotonic nonce per channel for EIP-712 `Refund` digests; also advanced by direct `refund` (see below). |
| `receivers[receiver][token]` | Per-receiver, per-token aggregates for settlement sweeps (`totalClaimed`, `totalSettled`). |

**Payer-signed vouchers exist off-chain** until the receiver side submits `claim` or `claimWithSignature`. Until then, `totalClaimed` does not reflect entitlement implied by those vouchers.

## Timed withdrawal vs claims (liveness)

`initiateWithdraw` / `finalizeWithdraw` (payer side) and `claim` / `claimWithSignature` (receiver side) are **independent entry points**. Available liquidity for withdrawal uses:

`available = ch.balance - ch.totalClaimed`

only **`totalClaimed` already recorded on-chain**. There is **no** on-chain reservation for vouchers that have been signed but not yet claimed.

**Race:** If the payer opens the timed withdrawal window and later `finalizeWithdraw` executes **before** the receiver’s `claim` is included, escrow `balance` can drop so that a subsequent `claim` reverts with `ClaimExceedsBalance`. Causes include RPC outages, censored or reordered transactions, or relay failure—the same class of **liveness** risks as any competing txs.

**Mitigations (integrator policy, not enforced on-chain):**

- Submit `claim` **early**, especially after the payer should no longer be assumed cooperative.
- Use **relayers** / resilient infra for claim inclusion during the withdrawal delay.
- Choose **`withdrawDelay`** well above `MIN_WITHDRAW_DELAY` for high-value channels so receiver-side transactions have time to land (hours or days if appropriate).

**Future patterns:** A hypothetical `commitVoucher`-style primitive (cheap on-chain reservation without full claim) is **not** part of this contract; integrators should not assume it exists.

## ChannelConfig

- **`receiverAuthorizer`**: Must be non-zero at deposit time; used for batch authorization (`claimWithSignature`), refund signatures, etc.
- **`payerAuthorizer`**: May be **zero**. When zero, voucher signatures are checked against **`payer`** via EIP-1271 / ECDSA as implemented in `_processVoucherClaim`; when non-zero, ECDSA recover must match `payerAuthorizer`.

## Deposits

Deposits use pluggable **[`IDepositCollector`](../src/interfaces/IDepositCollector.sol)** implementations. The settlement contract calls `collect(payer, token, amount, channelId, collectorData)`; collectors **must** transfer tokens to `msg.sender` (the settlement contract). After `collect`, settlement verifies token **balance increased by `amount`** (guards fee-on-transfer shortfalls and failed pulls).

Reference collectors in this repo: `DepositCollector` base, `ERC3009DepositCollector`, `Permit2DepositCollector`.

## Claims and EIP-712

- **`claim`**: Caller must be `receiver` or `receiverAuthorizer` per channel row.
- **`claimWithSignature`**: Anyone may submit; `receiverAuthorizer` signs `getClaimBatchDigest(voucherClaims)` over the batch.

**Empty batches:** `claim` / `claimWithSignature` revert with `EmptyBatch()`. The view `getClaimBatchDigest` still defines a digest for `voucherClaims.length == 0` so off-chain tooling can match EIP-712 encoding; mutating paths never call it with an empty array.

## Refunds vs payer withdrawal

| Path | Who drives | Notes |
|------|------------|--------|
| `refund` / `refundWithSignature` | Receiver side | Cooperative return of unclaimed escrow to payer; capped to available liquidity. |
| `initiateWithdraw` / `finalizeWithdraw` | Payer / `payerAuthorizer` | Timed reclaim of unclaimed escrow after `withdrawDelay`. |

Trust and UX differ: refunds require receiver cooperation or `receiverAuthorizer` signatures; timed withdrawal is payer-controlled once liquidity is unclaimed on-chain.

### `refundNonce` and mixing `refund` with `refundWithSignature`

Both `refund` and `refundWithSignature` call the same internal refund path. **`refundNonce[channelId]` is incremented at the start of that path**, before the contract applies the cap `min(requested, balance - totalClaimed)` and before any token transfer.

Implications for integrators:

1. **Nonce advances even on “no token moved”**: If `amount > 0` but available unclaimed escrow is zero, there is no `Refunded` event and no transfer, yet the nonce still increases (same for either entry point). This matches on-chain tests; do not assume “no-op” means “nonce unchanged.”
2. **Direct `refund` invalidates queued signatures**: A `receiver` / `receiverAuthorizer` calling plain `refund` advances the nonce. Any EIP-712 `Refund` digest that `receiverAuthorizer` had pre-signed for the **previous** nonce will revert with `InvalidRefundNonce` until a fresh signature is produced at the new nonce. This is receiver-side coordination (or relayer vs hot-wallet racing), not a cross-party exploit, but it is easy to miss operationally.
3. **Signing and relaying**: Before signing `getRefundDigest(channelId, nonce, amount)`, read the live `refundNonce(channelId)`. If direct refunds and relayed `refundWithSignature` can interleave, serialize them in your product or expect re-signing.

The contract intentionally keeps one counter for both paths so signed-refund replay protection stays aligned with any cooperative refund that reaches `_executeRefund`.

## Settlement

`settle(receiver, token)` transfers **claimed but not yet settled** balances for that `(receiver, token)` pair (permissionless). It moves ERC-20 from escrow aggregates to `receiver` and updates `totalSettled`.

## Events

- **`ChannelCreated`**: Emitted when a channel first receives escrow (`balance` reflects first deposit path and `totalClaimed == 0`), after successful collection.
- **`ChannelClosed`**: Emitted when unclaimed escrow returns to zero **and** `totalClaimed == 0` (e.g. full cooperative refund or timed withdrawal with no claims).
- **`Deposited`**, **`Claimed`**, **`Settled`**, **`Refunded`**, **`WithdrawInitiated`**, **`WithdrawFinalized`**: See NatSpec on the contract.

The same `channelId` may see **`ChannelCreated` more than once** if the channel is emptied and later funded again; pair with `ChannelClosed` for lifecycle indexing.

## Deployment and environment

- **`ReentrancyGuardTransient` (EIP-1153):** Deploy only on chains where transient storage is supported.
- **Tokens:** Fee-on-transfer and rebasing tokens are discouraged; behavior is not guaranteed to match the balance checks used for deposits.
