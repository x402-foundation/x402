# Scheme: `zk-relay`

## Summary

`zk-relay` is a scheme for privacy-preserving asset transfers on EVM-compatible networks. A client generates a zero-knowledge proof off-chain, and the facilitator relays the transaction on-chain so that the client never reveals their address or pays gas directly. The facilitator settles the proof and deducts a protocol fee from the withdrawn amount.

Unlike `exact`, where the client signs a transfer of a known amount to a known recipient, `zk-relay` operates on shielded notes. The client destroys a private note by proving knowledge of its secret and nullifier inside a ZK circuit, and the facilitator submits the resulting proof to a smart contract that verifies the proof, nullifies the note, and sends funds to the specified recipient minus fees.

## Use Cases

- Private withdrawal of shielded ETH or ERC-20 tokens without revealing the depositor's address
- Gasless unshielding where the recipient wallet has zero ETH balance
- Relayed transactions that break the on-chain link between deposit and withdrawal
- Privacy-preserving payments where sender and receiver cannot be correlated

## Flow

```
Client                        Facilitator                    Smart Contract
  |                                |                              |
  |-- POST /verify ------------->  |                              |
  |   { proof, nullifier,          |                              |
  |     amount, recipient, root }  |                              |
  |                                |-- Validate proof format      |
  |                                |-- Check nullifier unused     |
  |                                |-- Check root is known        |
  |  <-- 200 { valid: true } ----- |                              |
  |                                |                              |
  |-- POST /settle ------------->  |                              |
  |   { proof, nullifier,          |                              |
  |     amount, recipient, root }  |                              |
  |                                |-- unshield(proof, ...)   --> |
  |                                |                              |-- Verify ZK proof
  |                                |                              |-- Check nullifier
  |                                |                              |-- Send funds - fee
  |                                |                              |-- Emit event
  |  <-- 200 { txHash } ---------  |                              |
```

## Proof System

The scheme is proof-system agnostic but the reference implementation uses:

- **Circuits**: Noir 1.0.0-beta.18
- **Proof system**: UltraHonk (no trusted setup required)
- **Hashing**: Poseidon over the BN254 curve
- **Commitment scheme**: `commitment = Poseidon(secret, nullifier, amount, assetId)`
- **Nullifier scheme**: `nullifierHash = Poseidon(nullifier, leafIndex)`
- **Merkle tree**: 24-level Poseidon hash tree

## Security Requirements

### Facilitator

- MUST verify the proof format and public inputs before submitting on-chain.
- MUST check that the Merkle root is recognized by the contract.
- MUST check that the nullifier has not been spent.
- MUST NOT submit proofs that would revert, to avoid wasting gas.
- MUST enforce rate limiting to prevent abuse.
- SHOULD implement a circuit breaker that pauses settlement on repeated failures or low balance.

### Smart Contract

- MUST verify the ZK proof on-chain before transferring funds.
- MUST reject previously-used nullifiers (double-spend prevention).
- MUST verify the Merkle root against its root history.
- MUST deduct the protocol fee and send the remainder to the recipient.
- MUST emit events for all state changes (deposits, withdrawals, transfers).

## Security Considerations

### Replay Attack Prevention

- Each shielded note can only be spent once. The `nullifierHash` is derived from the note's secret nullifier and its leaf index in the Merkle tree. Once a nullifier is marked as spent on-chain, any subsequent proof using the same nullifier will be rejected.
- The facilitator MUST check nullifier uniqueness before submitting to avoid wasting gas on reverted transactions.

### Privacy Guarantees

- The ZK proof reveals no information about the depositor's address or the original deposit transaction.
- The proof only reveals the withdrawal amount, recipient, and that the sender knows a valid note in the tree.
- Fixed denominations prevent amount-based correlation between deposits and withdrawals.
- The facilitator relays the transaction, so the recipient address does not need to have prior on-chain activity or gas balance.

### Authorization Scope

- The facilitator (relayer) can only call `unshield()` -- it cannot modify the recipient, amount, or any other parameter embedded in the ZK proof.
- The smart contract enforces that public inputs match the proof's public outputs. Any mismatch causes proof verification to fail.

### Settlement Atomicity

- Settlement is atomic: the smart contract either verifies the proof, nullifies the note, and sends funds in a single transaction, or the entire transaction reverts.
- There is no intermediate state where funds could be locked or the nullifier spent without the recipient receiving funds.

### Root Freshness

- The contract maintains a permanent history of all Merkle roots (`isKnownRoot` mapping). A proof generated against any historical root remains valid, preventing front-running attacks where a new deposit would invalidate an in-progress withdrawal.

### Trust Model

- The client does not trust the facilitator with their privacy. The facilitator only sees the proof, nullifier hash, amount, and recipient -- none of which reveal the depositor.
- The facilitator does not trust the client. It verifies all inputs before spending gas to submit the proof on-chain.
- Neither party trusts the other. The smart contract acts as the arbiter, verifying the ZK proof and enforcing all rules.

## Network Support

| Network | Chain ID | Status |
|---------|----------|--------|
| Base    | eip155:8453 | Live |

## Comparison with `exact`

| Property               | `exact`                            | `zk-relay`                              |
|------------------------|------------------------------------|-----------------------------------------|
| Privacy                | None (on-chain transfer visible)   | Full (deposit/withdrawal unlinkable)    |
| Client signature       | EIP-712 / EIP-3009                 | ZK proof (UltraHonk)                    |
| Trusted setup          | N/A                                | None required (UltraHonk)              |
| Gas payer              | Facilitator                        | Facilitator                             |
| Supported assets       | EIP-3009 tokens, ERC-20 via Permit2| Native ETH, ERC-20 (via assetId)       |
| Amount flexibility     | Arbitrary amounts                  | Fixed denominations only                |
| Proof generation       | Wallet signature (instant)         | Client-side WASM (~3-8 seconds)        |
| On-chain verification  | Signature recovery                 | ZK proof verification (~380k gas)       |
| Client requirements    | Wallet with signing capability     | Browser with WASM support               |

## Appendix

### Reference Implementation

- **Protocol**: [Ceaser Privacy Protocol](https://ceaser.org)
- **Source**: [github.com/Zyra-V21/ceaaser-privacy](https://github.com/Zyra-V21/ceaaser-privacy)
- **Contract**: `0x278652aA8383cBa29b68165926d0534e52BcD368` (Base mainnet)
- **Facilitator**: `https://ceaser.org` (endpoints: `/supported`, `/verify`, `/settle`, `/status`)

### Fee Structure

- Protocol fee: 0.25% of withdrawn amount (0.24% treasury, 0.01% relayer)
- Gas: paid by the facilitator, not the client

### Fixed Denominations

The protocol uses fixed denominations to preserve amount privacy:

| Denomination | Unit |
|-------------|------|
| 0.001       | ETH  |
| 0.01        | ETH  |
| 0.1         | ETH  |
| 1           | ETH  |
| 10          | ETH  |
