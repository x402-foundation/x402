# Facilitator API Reference: `zk-relay`

## Overview

The `zk-relay` facilitator exposes a standard set of x402 endpoints plus scheme-specific endpoints for Merkle tree state and indexer data. All endpoints are served over HTTPS.

## Standard x402 Endpoints

### `GET /supported`

Returns the schemes and networks supported by this facilitator.

**Response:**

```json
{
  "x402Version": 2,
  "schemes": ["zk-relay"],
  "networks": ["eip155:8453"]
}
```

### `POST /verify`

Validates a proof and its public inputs without submitting on-chain. Use this to check proof validity before committing to settlement.

**Request Body:**

```json
{
  "proof": "0x1a2b3c...",
  "nullifierHash": "0x4d5e6f...",
  "amount": "1000000000000000",
  "assetId": 0,
  "recipient": "0x6Bf5713D59066A4a55CdAD90f7E007d5209aDaE7",
  "root": "0x7a8b9c..."
}
```

**Response (valid):**

```json
{
  "valid": true
}
```

**Response (invalid):**

```json
{
  "valid": false,
  "error": "Nullifier already spent"
}
```

### `POST /settle`

Submits the proof on-chain by calling `unshield()` on the zkWrapper contract. This endpoint is idempotent: if a settlement with the same nullifier is already in progress or completed, the existing transaction hash is returned.

**Request Body:** Same as `/verify`.

**Response (success):**

```json
{
  "success": true,
  "txHash": "0xabc123..."
}
```

**Response (failure):**

```json
{
  "success": false,
  "error": "Proof verification failed on-chain"
}
```

### `GET /status`

Returns the facilitator's operational status.

**Response:**

```json
{
  "status": "active",
  "network": "eip155:8453",
  "contract": "0x278652aA8383cBa29b68165926d0534e52BcD368",
  "relayerAddress": "0x214999174d5925aB5744e176f433e1585705Ad4d",
  "balance": "0.0217",
  "pendingTxCount": 0,
  "circuitBreaker": {
    "paused": false
  },
  "indexer": {
    "enabled": true,
    "lastBlock": 42235100,
    "commitmentCount": 12,
    "merkleRoot": "0x..."
  }
}
```

## Scheme-Specific Endpoints

### `GET /api/ceaser/merkle-root`

Returns the current Merkle tree root. Prefers the locally indexed root (instant) with an on-chain fallback.

**Response:**

```json
{
  "root": "0x7a8b9c...",
  "source": "indexer"
}
```

### `GET /api/ceaser/indexer/status`

Returns the indexer synchronization state.

**Response:**

```json
{
  "enabled": true,
  "synced": true,
  "lastBlock": 42235100,
  "commitmentCount": 12,
  "merkleRoot": "0x..."
}
```

### `GET /api/ceaser/indexer/commitments`

Returns all commitments known to the indexer, enabling the client to reconstruct the Merkle tree locally for proof generation.

**Response:**

```json
{
  "commitments": [
    "0xaaa...",
    "0xbbb...",
    "0xccc..."
  ],
  "count": 3,
  "merkleRoot": "0x..."
}
```

### `GET /api/ceaser/indexer/commitment/:index`

Returns a single commitment by its leaf index.

**Response:**

```json
{
  "index": 0,
  "commitment": "0xaaa...",
  "blockNumber": 42230490
}
```

## Error Codes

| HTTP Status | Error                    | Description                                      |
|-------------|--------------------------|--------------------------------------------------|
| 400         | `INVALID_PROOF_FORMAT`   | Proof bytes are malformed or wrong length         |
| 400         | `INVALID_AMOUNT`         | Amount is not a valid fixed denomination          |
| 400         | `INVALID_RECIPIENT`      | Recipient address is zero or malformed            |
| 409         | `NULLIFIER_ALREADY_SPENT`| The nullifier has been used in a prior withdrawal |
| 409         | `ROOT_NOT_RECOGNIZED`    | The Merkle root is not in the contract's history  |
| 429         | `RATE_LIMITED`           | Per-address or global rate limit exceeded         |
| 503         | `FACILITATOR_PAUSED`     | Circuit breaker is active due to failures or low balance |
