# Scheme: `zk-relay` (EVM)

## Summary

EVM-specific implementation details for the `zk-relay` scheme. This document covers the smart contract interface, proof encoding, and on-chain verification requirements for EVM-compatible networks.

## Smart Contract Interface

### Shield (Deposit)

```solidity
function shieldETH(
    bytes calldata proof,
    bytes32 commitment,
    uint256 amount,
    uint256 assetId
) external payable;
```

The client deposits a fixed denomination of ETH and provides a commitment that encodes the note's secret, nullifier, amount, and asset identifier. The contract inserts the commitment into a 24-level Poseidon Merkle tree and emits a `Deposit` event.

### Unshield (Withdrawal via Facilitator)

```solidity
function unshield(
    bytes calldata proof,
    bytes32 nullifierHash,
    uint256 amount,
    uint256 assetId,
    address recipient,
    bytes32 root
) external;
```

Only callable by a whitelisted relayer address. The contract verifies the ZK proof on-chain using a Solidity verifier generated from the same proof system (UltraHonk). If verification passes, the contract:

1. Marks the nullifier as spent
2. Calculates the protocol fee (configurable basis points)
3. Sends `amount - fee` to the recipient
4. Sends the fee to the treasury address
5. Emits an `Unshield` event

### Access Control

- `relayers`: mapping of authorized facilitator addresses
- `owner`: can add/remove relayers, pause the contract, update fee parameters
- `treasury`: receives protocol fees

## Proof Encoding

The proof is encoded as a single `bytes` blob in the UltraHonk format:

- Generated client-side using `@aztec/bb.js` (WASM)
- Serialized as a flat byte array of field elements (32 bytes each)
- Passed directly to the Solidity verifier's `verify()` function
- The verifier is generated from `bb.js` (not the `bb` CLI) to ensure version alignment

## Public Inputs

The circuit exposes the following public inputs for on-chain verification:

| Index | Field           | Description                            |
|-------|-----------------|----------------------------------------|
| 0     | root            | Merkle tree root at time of proof      |
| 1     | nullifierHash   | Hash of (nullifier, leafIndex)         |
| 2     | amount          | Withdrawal amount in wei               |
| 3     | assetId         | Asset identifier (0 for native ETH)    |
| 4     | recipient       | Recipient address as uint256           |

## Gas Costs

| Operation       | Gas (approx) |
|-----------------|-------------|
| shieldETH       | ~320,000    |
| unshield        | ~380,000    |
| privateTransfer | ~400,000    |

## Rate Limiting

The contract enforces two tiers of rate limiting:

- **Per-address**: 50 ETH per hour for both shield and unshield operations
- **Global per-block**: configurable maximum to prevent block stuffing

## Events

```solidity
event Deposit(bytes32 indexed commitment, uint256 leafIndex, uint256 amount, uint256 assetId, uint256 timestamp);
event Unshield(bytes32 indexed nullifierHash, address indexed recipient, uint256 amount, uint256 assetId, uint256 fee);
event PrivateTransfer(bytes32 indexed nullifierHash, bytes32 indexed newCommitment, uint256 timestamp);
```

## `PaymentRequirements` Structure

When a resource server requires payment via `zk-relay`, it returns a `402 Payment Required` response with the following `PaymentRequirements`:

```json
{
  "scheme": "zk-relay",
  "network": "eip155:8453",
  "amount": "1000000000000000",
  "asset": "0x0000000000000000000000000000000000000000",
  "payTo": "0x6Bf5713D59066A4a55CdAD90f7E007d5209aDaE7",
  "maxTimeoutSeconds": 120,
  "extra": {
    "contract": "0x278652aA8383cBa29b68165926d0534e52BcD368",
    "facilitatorUrl": "https://ceaser.org",
    "denominations": ["1000000000000000", "10000000000000000", "100000000000000000", "1000000000000000000", "10000000000000000000"],
    "proofSystem": "ultrahonk",
    "merkleTreeDepth": 24,
    "assetId": 0
  }
}
```

Field descriptions for `extra`:

| Field             | Type       | Description                                         |
|-------------------|------------|-----------------------------------------------------|
| `contract`        | `address`  | Address of the zkWrapper smart contract              |
| `facilitatorUrl`  | `string`   | Base URL of the facilitator that will relay the proof |
| `denominations`   | `string[]` | Accepted note denominations in wei                   |
| `proofSystem`     | `string`   | Proof system identifier (`ultrahonk`)                |
| `merkleTreeDepth` | `number`   | Depth of the Poseidon Merkle tree (24)               |
| `assetId`         | `number`   | Asset identifier (0 for native ETH)                  |

## `PaymentPayload` Structure

The client generates a ZK proof off-chain and sends it to the facilitator:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "zk-relay",
    "network": "eip155:8453",
    "amount": "1000000000000000",
    "asset": "0x0000000000000000000000000000000000000000",
    "payTo": "0x6Bf5713D59066A4a55CdAD90f7E007d5209aDaE7",
    "maxTimeoutSeconds": 120,
    "extra": {
      "contract": "0x278652aA8383cBa29b68165926d0534e52BcD368",
      "facilitatorUrl": "https://ceaser.org"
    }
  },
  "payload": {
    "proof": "0x1a2b3c...",
    "nullifierHash": "0x4d5e6f...",
    "amount": "1000000000000000",
    "assetId": 0,
    "recipient": "0x6Bf5713D59066A4a55CdAD90f7E007d5209aDaE7",
    "root": "0x7a8b9c..."
  }
}
```

Field descriptions for `payload`:

| Field           | Type      | Description                                    |
|-----------------|-----------|------------------------------------------------|
| `proof`         | `bytes`   | UltraHonk proof as 0x-prefixed hex string       |
| `nullifierHash` | `bytes32` | Poseidon hash of (nullifier, leafIndex)          |
| `amount`        | `string`  | Withdrawal amount in wei                         |
| `assetId`       | `number`  | Asset identifier (0 for native ETH)              |
| `recipient`     | `address` | Destination address for withdrawn funds          |
| `root`          | `bytes32` | Merkle tree root the proof was generated against |

## Verification Logic

The facilitator MUST verify the following before submitting the proof on-chain:

1. **Proof format**: The `proof` field MUST be a valid hex-encoded byte string with length consistent with an UltraHonk proof.
2. **Root recognition**: The `root` MUST be recognized by the smart contract. The facilitator SHOULD query the contract's `isKnownRoot(root)` function or check against its local indexed Merkle tree.
3. **Nullifier uniqueness**: The `nullifierHash` MUST NOT have been previously spent. The facilitator SHOULD query the contract's `nullifierHashes(nullifierHash)` mapping.
4. **Amount validity**: The `amount` MUST correspond to a valid fixed denomination accepted by the contract.
5. **Recipient address**: The `recipient` MUST be a valid Ethereum address (non-zero, checksummed).
6. **Rate limit check**: The facilitator SHOULD verify the withdrawal does not exceed per-address rate limits (50 ETH/hour).
7. **Gas simulation**: The facilitator SHOULD simulate the `unshield()` call via `eth_call` to confirm it would not revert before broadcasting.

If any check fails, the facilitator MUST return an error and MUST NOT submit the transaction on-chain.

## Settlement Logic

Settlement is performed by the facilitator calling the `unshield()` function on the zkWrapper contract:

1. The facilitator constructs a transaction calling `unshield(proof, nullifierHash, amount, assetId, recipient, root)` on the contract.
2. The facilitator signs and broadcasts the transaction using its whitelisted relayer address.
3. The contract verifies the ZK proof on-chain via the UltraHonk Solidity verifier.
4. If verification passes, the contract marks the nullifier as spent, calculates the protocol fee (25 basis points), sends `amount - fee` to the recipient, and sends the fee to the treasury.
5. The facilitator returns the transaction hash to the client.

**Settlement Response:**

```json
{
  "success": true,
  "transaction": "0xabc123...",
  "network": "eip155:8453"
}
```

If settlement fails (proof invalid, nullifier already spent, insufficient contract balance), the facilitator MUST NOT retry with the same parameters. The facilitator SHOULD return a descriptive error.

## Network Deployment

| Network | Contract Address                             | Deploy Block |
|---------|----------------------------------------------|-------------|
| Base    | `0x278652aA8383cBa29b68165926d0534e52BcD368` | 42230487    |
