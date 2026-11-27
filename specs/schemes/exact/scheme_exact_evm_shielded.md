# Scheme: `exact` on `EVM` — AssetTransferMethod: `shielded`

## Summary

The `shielded` asset transfer method enables privacy-preserving payments on EVM chains via on-chain privacy pools. The client withdraws ("unshields") tokens from a privacy pool directly to the resource server's `payTo` address. The facilitator verifies the payment by checking the ERC-20 `Transfer` event emitted during the unshield — no viewing keys, trial decryption, or off-chain state is required.

This is the first fully private payment option for x402 on EVM. Unlike existing EVM methods (EIP-3009, Permit2, ERC-7710) where the payer's address is publicly visible on-chain, shielded payments hide the sender's identity behind a zero-knowledge proof verified by the privacy pool contract.

### Key Properties

| Property | Value |
|:---------|:------|
| Settlement | Client-driven (client unshields on-chain before verification) |
| Verification | ERC-20 `Transfer` event from registered privacy pool contract |
| Privacy | Sender hidden (ZK proof); amount visible to facilitator |
| Gas/Fees | Client pays, or gasless via ERC-4337 account abstraction |
| Facilitator role | Verify-only (no settlement, no custody) |
| Token | Any ERC-20 supported by the privacy pool (USDC, USDT, DAI, WETH) |

### Key Differences from Other EVM Methods

| Aspect | EIP-3009 | Permit2 | ERC-7710 | **Shielded** |
|--------|----------|---------|----------|-------------|
| Authorization | Off-chain signature | Off-chain signature | Delegation | On-chain ZK proof |
| Settlement | Facilitator submits | Facilitator submits | Facilitator submits | **Client sends directly** |
| Verification | Signature recovery | Signature recovery | Delegation check | **Transfer event inspection** |
| Sender privacy | None (public) | None (public) | None (public) | **Full (ZK hidden)** |
| Gas | Facilitator sponsors | Facilitator sponsors | Facilitator sponsors | Client pays (or ERC-4337) |
| Setup | None | One-time approve | One-time delegation | One-time shield |

---

## Protocol Flow

1. **Client** requests a resource from the **Resource Server**.
2. **Resource Server** responds with `402 Payment Required`. The `accepts` array includes a shielded payment option with `extra.assetTransferMethod: "shielded"`.
3. **Client** unshields tokens from a privacy pool on-chain, sending them directly to the `payTo` address.
4. **Client** waits for the transaction to confirm (typically 2–15 seconds depending on chain).
5. **Client** retries the request with the `PAYMENT-SIGNATURE` header containing the base64-encoded `PaymentPayload` with the unshield transaction hash.
6. **Resource Server** forwards the payload to the **Facilitator's** `/verify` endpoint.
7. **Facilitator** fetches the transaction receipt and verifies the ERC-20 `Transfer` event.
8. **Facilitator** returns a `VerifyResponse`.
9. **Resource Server** grants access.

```
Client                    Resource Server              Facilitator
  │                            │                              │
  │  GET /api/data             │                              │
  │───────────────────────────>│                              │
  │                            │                              │
  │  402 Payment Required      │                              │
  │  PAYMENT-REQUIRED: base64  │                              │
  │  (assetTransferMethod:     │                              │
  │   "shielded")              │                              │
  │<───────────────────────────│                              │
  │                            │                              │
  │  (unshields tokens from    │                              │
  │   privacy pool on-chain    │                              │
  │   to payTo address)        │                              │
  │                            │                              │
  │  GET /api/data             │                              │
  │  PAYMENT-SIGNATURE: base64 │                              │
  │───────────────────────────>│                              │
  │                            │  POST /verify                │
  │                            │  { payload, requirements }   │
  │                            │─────────────────────────────>│
  │                            │                              │
  │                            │  { isValid: true }           │
  │                            │<─────────────────────────────│
  │                            │                              │
  │  200 OK                    │                              │
  │  PAYMENT-RESPONSE: base64  │                              │
  │<───────────────────────────│                              │
```

---

## `PaymentRequirements`

```json
{
  "scheme": "exact",
  "network": "eip155:8453",
  "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "amount": "1000000",
  "payTo": "0xMerchantAddress...",
  "maxTimeoutSeconds": 120,
  "extra": {
    "assetTransferMethod": "shielded",
    "poolContracts": [
      "0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85"
    ]
  }
}
```

| Field | Description |
|:------|:------------|
| `scheme` | MUST be `"exact"`. |
| `network` | MUST be a CAIP-2 EVM network identifier (e.g., `"eip155:8453"` for Base). |
| `asset` | MUST be the ERC-20 token contract address. |
| `amount` | Payment amount in the token's smallest denomination (e.g., `"1000000"` = 1 USDC). |
| `payTo` | Recipient address that MUST receive the unshielded tokens. |
| `maxTimeoutSeconds` | Maximum time to wait for verification. |
| `extra.assetTransferMethod` | MUST be `"shielded"`. |
| `extra.poolContracts` | List of privacy pool contract addresses accepted by this resource server. If omitted, the facilitator uses its own allowlist. |

---

## `PAYMENT-SIGNATURE` Header Payload

The `payload` field of the `PaymentPayload` contains:

```json
{
  "txHash": "0x4712f6ad727eb4f72a59bf6e23edeb23589da66edc0166a2223252a5be9459c7",
  "nullifiers": ["0xabc123..."]
}
```

| Field | Description |
|:------|:------------|
| `txHash` | The transaction hash of the on-chain unshield operation. MUST be a valid 32-byte hex string. |
| `nullifiers` | OPTIONAL. Array of nullifier hashes from the ZK proof. Provides protocol-level double-spend prevention beyond txHash replay protection. |

Full `PaymentPayload` example:

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
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "amount": "1000000",
    "payTo": "0xMerchantAddress...",
    "maxTimeoutSeconds": 120,
    "extra": {
      "assetTransferMethod": "shielded",
      "poolContracts": ["0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85"]
    }
  },
  "payload": {
    "txHash": "0x4712f6ad727eb4f72a59bf6e23edeb23589da66edc0166a2223252a5be9459c7",
    "nullifiers": []
  }
}
```

---

## Verification

Verification happens in two layers: the privacy pool contract handles ZK proof verification and double-spend prevention on-chain, while the facilitator confirms the resulting transfer matches the payment requirements.

### On-chain layer (handled by the privacy pool contract)

Before the facilitator is involved, the following has already happened on-chain:

1. The client generated a groth16 ZK proof proving ownership of a UTXO in the pool's shielded Merkle tree.
2. The proof includes **nullifiers** — deterministic hashes derived from the UTXO being spent. Each UTXO produces a unique nullifier.
3. The client submitted the proof to the pool contract.
4. The pool contract verified the ZK proof, checked that the nullifiers are not in its on-chain spent set (preventing double-spend), added the nullifiers to the spent set, and executed the ERC-20 transfer.
5. If the transaction was not reverted, all of the above succeeded.

The facilitator does not need to verify the ZK proof or check nullifiers against the pool's on-chain state — the pool contract already did this. A non-reverted transaction is sufficient proof.

### Facilitator layer

The facilitator MUST enforce all of the following:

#### 1. Transaction Existence

The `txHash` MUST reference a non-reverted transaction on the target chain. A reverted transaction means the pool contract rejected the ZK proof or the nullifiers were already spent. Facilitators MAY accept mempool transactions for low-value payments, but SHOULD require at least 1 confirmation for amounts exceeding a configurable threshold.

#### 2. Transfer Event Inspection

The transaction receipt MUST contain an ERC-20 `Transfer(address indexed from, address indexed to, uint256 value)` event for the required `asset` token, where:

- `from` MUST be one of the registered privacy pool contract addresses.
- `to` MUST match the `payTo` address from `PaymentRequirements`.
- `value` MUST be greater than or equal to the required `amount`.

#### 3. Pool Contract Validation

The `from` address in the Transfer event MUST be a recognized privacy pool contract. The facilitator MUST maintain an allowlist of accepted pool contracts, either:

- From the `extra.poolContracts` array in `PaymentRequirements`, OR
- From the facilitator's own configuration.

The facilitator MUST NOT accept transfers from arbitrary addresses — only from registered privacy pool contracts.

#### 4. Application-Level Replay Protection

The on-chain nullifiers prevent the same UTXO from being spent twice at the protocol level. However, the facilitator MUST also prevent the same **payment transaction** from being used to access multiple resources (application-level replay).

The facilitator MUST track used `txHash` values. A `txHash` that has already been used for a successful verification MUST be rejected.

If `nullifiers` are provided in the payload, the facilitator MAY additionally track nullifiers for defense-in-depth.

#### 5. Timeout Enforcement

If the facilitator cannot retrieve and verify the transaction within the `maxTimeoutSeconds` window, verification MUST fail.

---

## Settlement

Settlement for shielded payments is **client-driven**:

1. The client unshields tokens from the privacy pool **before** sending the `PaymentPayload`.
2. The facilitator does **not** submit, co-sign, or broadcast any transaction.
3. The facilitator exposes only a `/verify` endpoint.

This means:
- The facilitator never holds or moves funds.
- The client pays the gas for the unshield transaction (or uses ERC-4337 for gasless execution).
- Transaction finality is determined by the underlying chain.

### `SettleResponse`

Since settlement is client-driven, the response confirms verification rather than settlement:

```json
{
  "success": true,
  "transaction": "0x4712f6ad727eb4f72a59bf6e23edeb23589da66edc0166a2223252a5be9459c7",
  "network": "eip155:8453",
  "payer": "0x26111e2379E5fC0A7Cd8728fe52c7b84CA4fbE85"
}
```

The `payer` field contains the privacy pool contract address (the `from` in the Transfer event), not the client's actual address — which is hidden by the ZK proof.

---

## Appendix

### Privacy Guarantees

Shielded EVM payments provide the following privacy properties not available with other x402 EVM methods:

- **Sender privacy**: The payer's wallet address is not visible in the Transfer event. The `from` field shows the privacy pool contract, not the individual.
- **Unlinkability**: Multiple payments from the same sender cannot be linked by an on-chain observer.
- **Pattern privacy**: An observer cannot determine which API was paid for or correlate payment timing with API usage.

**Not hidden:**
- **Amount**: The transfer amount is visible in the Transfer event.
- **Recipient**: The `payTo` address is visible (the resource server's address is public).

### Supported Privacy Pools

This specification is designed to work with any EVM privacy pool that emits standard ERC-20 `Transfer` events when tokens are withdrawn. Known compatible implementations:

| Protocol | Chains | Contract Addresses |
|:---------|:-------|:-------------------|
| Railgun | Base, Ethereum, BSC, Polygon, Arbitrum | [railgun.org/contracts](https://railgun.org) |

Additional privacy pool implementations MAY be added by registering their contract addresses with the facilitator.

### Security Considerations

1. **Pool contract allowlist**: The facilitator MUST only accept transfers from known privacy pool contracts. Accepting transfers from arbitrary addresses would allow non-private payments to masquerade as shielded ones.

2. **Transaction confirmation depth**: For high-value payments, facilitators SHOULD require multiple block confirmations to mitigate reorg risk. For micropayments (< $1), single confirmation is typically sufficient.

3. **Nullifier verification**: When nullifiers are provided, facilitators SHOULD verify them against the privacy pool's on-chain state or a trusted indexer. This prevents a class of double-spend attacks where the same ZK proof is submitted in multiple transactions.

4. **No viewing keys required**: Verification does not require viewing keys or trial decryption. The ERC-20 Transfer event is a public log entry — verification is purely based on event inspection. This simplifies facilitator implementation and eliminates key management concerns.

5. **Client-side proof generation**: The ZK proof is generated entirely on the client side. The privacy pool contract verifies the proof on-chain. The facilitator does not need to understand or verify the ZK proof — it only needs to confirm that the privacy pool contract accepted the transaction (i.e., the transaction was not reverted).

### One-Time Setup: Shielding

Before making shielded payments, the client must deposit ("shield") tokens into the privacy pool. This is a one-time setup:

1. Client approves the privacy pool contract to spend their ERC-20 tokens.
2. Client calls the pool's shield function, which moves tokens into the shielded pool.
3. After shielding, the client can make any number of shielded payments (unshields) from the pool.

Shielding breaks the on-chain link between the client's public address and their shielded balance.
