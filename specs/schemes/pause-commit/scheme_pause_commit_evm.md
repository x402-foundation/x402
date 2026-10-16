# Scheme: `pause-commit` on `EVM`

## Summary

The `pause-commit` scheme on EVM uses the PAUSECommit smart contract for two-phase payment settlement. Clients sign off-chain EIP-712 payment intents at zero gas cost. Recipients claim payments atomically on-chain. Clients can revoke unclaimed intents.

This document describes the deployed contract interface, EIP-712 signing format, validation requirements, and integration patterns.

## Smart Contract

**Contract**: PAUSECommit V2
**Ethereum Mainnet**: [`0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4`](https://etherscan.io/address/0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4)
**Verified**: Yes (Etherscan)

### Functions

```solidity
// Settle a payment intent on-chain. Only callable by the recipient (to).
function commit(
    address from,
    address to,
    address token,
    uint256 amount,
    uint256 nonce,
    uint256 expiry,
    uint256 chainId,
    bytes calldata signature
) external;

// Cancel a payment intent. Only callable by the sender (from).
function revoke(
    address from,
    address to,
    address token,
    uint256 amount,
    uint256 nonce,
    uint256 expiry,
    uint256 chainId
) external;

// Check if an intent has been committed
function isIntentUsed(bytes32 intentHash) external view returns (bool);

// Check if an intent has been revoked
function isIntentRevoked(bytes32 intentHash) external view returns (bool);

// Get intent status: "committed", "revoked", or "pending"
function intentStatus(bytes32 intentHash) external view returns (string memory);

// Get the EIP-712 domain separator
function domainSeparator() external view returns (bytes32);
```

### Events

```solidity
event PaymentCommitted(
    bytes32 indexed intentHash,
    address indexed from,
    address indexed to,
    address token,
    uint256 amount
);

event PaymentRevoked(
    bytes32 indexed intentHash,
    address indexed from
);
```

### Access Control

- `commit()` enforces `require(msg.sender == to)` — only the recipient can settle
- `revoke()` enforces `require(msg.sender == from)` — only the sender can cancel

## EIP-712 Signing

### Domain Separator

```json
{
  "name": "PAUSE Protocol",
  "version": "1",
  "chainId": 1,
  "verifyingContract": "0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4"
}
```

The domain is constructed in the contract constructor using `block.chainid`, so it reflects the chain the contract is deployed on.

### PaymentIntent Type

```
PaymentIntent(address from,address to,address token,uint256 amount,uint256 nonce,uint256 expiry,uint256 chainId)
```

| Field | Type | Description |
|-------|------|-------------|
| `from` | `address` | Sender (payer) address |
| `to` | `address` | Recipient (payee) address |
| `token` | `address` | ERC-20 token contract (e.g. USDC) |
| `amount` | `uint256` | Payment amount in token base units |
| `nonce` | `uint256` | Unique value to prevent replay |
| `expiry` | `uint256` | Unix timestamp after which the intent is invalid |
| `chainId` | `uint256` | Target chain ID (must match `block.chainid`) |

### Intent Hash

The contract computes the intent hash as:

```
intentHash = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash))
```

where `structHash = keccak256(abi.encode(TYPE_HASH, from, to, token, amount, nonce, expiry, chainId))`.

## Payment Flow

### 1. Server Returns 402

```http
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded JSON>
```

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://api.example.com/premium-data",
    "description": "Premium market analysis",
    "mimeType": "application/json"
  },
  "accepts": [{
    "scheme": "pause-commit",
    "network": "eip155:1",
    "amount": "5000000",
    "asset": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "payTo": "0x742d35Cc6634C0532925a3b8D951D75aC1FDF3fC",
    "maxTimeoutSeconds": 300,
    "extra": {
      "contractAddress": "0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4",
      "facilitatorUrl": "https://facilitator.pausesecure.com"
    }
  }]
}
```

### 2. Client Screens `payTo` Address

Client calls the PAUSE Risk Engine to score the recipient address:

```http
POST https://api.pausescan.com/api/v1/analyze
Content-Type: application/json

{"address": "0x742d35Cc6634C0532925a3b8D951D75aC1FDF3fC"}
```

Response includes a score from 0-100. Addresses scoring below 40 should be blocked.

### 3. Client Signs EIP-712 PaymentIntent

If risk assessment passes, client signs the intent off-chain (zero gas):

```typescript
const intent = {
  from: clientAddress,
  to: "0x742d35Cc6634C0532925a3b8D951D75aC1FDF3fC",
  token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  amount: "5000000",
  nonce: generateUniqueNonce(),
  expiry: Math.floor(Date.now() / 1000) + 300,
  chainId: 1
};

const signature = await signer._signTypedData(domain, types, intent);
```

### 4. Client Retries with Payment Header

```http
GET /premium-data HTTP/1.1
PAYMENT-SIGNATURE: <base64-encoded JSON>
```

```json
{
  "scheme": "pause-commit",
  "payload": {
    "signature": "0x...",
    "intent": {
      "from": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      "to": "0x742d35Cc6634C0532925a3b8D951D75aC1FDF3fC",
      "token": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      "amount": "5000000",
      "nonce": "1710000001",
      "expiry": "1710000300",
      "chainId": "1"
    },
    "riskScore": 85
  }
}
```

### 5. Server Validates Intent

The server (or facilitator) must verify:

1. Recover signer from EIP-712 signature — must match `intent.from`
2. `intent.to` matches server's own address
3. `intent.amount` >= required payment amount
4. `intent.token` matches required asset
5. `intent.expiry > block.timestamp` (not expired)
6. `intent.chainId == block.chainid` (correct chain)
7. Intent not already used or revoked (call `intentStatus()`)
8. Client has sufficient token balance and has approved the PAUSECommit contract

### 6. Server Commits On-Chain

After delivering the resource, the server calls:

```solidity
PAUSECommit.commit(from, to, token, amount, nonce, expiry, chainId, signature)
```

Gas cost: ~85,000. The server or facilitator pays gas.

The contract verifies the signature, checks expiry and chain ID, confirms the intent hasn't been used or revoked, and executes `transferFrom(from, to, amount)` atomically.

### 7. Cancellation

If the server fails to commit before the expiry, the client can revoke:

```solidity
PAUSECommit.revoke(from, to, token, amount, nonce, expiry, chainId)
```

Requirements:
- Caller must be `from` (the original signer)
- Intent must not be already committed
- Intent must not be already revoked

After revocation, the intent hash is permanently marked as revoked and can never be committed.

## Gas Costs

| Operation | Gas | Paid By |
|-----------|-----|---------|
| EIP-712 signing | 0 | Client (off-chain) |
| `commit()` | ~85,000 | Server or facilitator |
| `revoke()` | ~45,000 | Client |
| `isIntentUsed()` | 0 (view) | — |
| `isIntentRevoked()` | 0 (view) | — |
| `intentStatus()` | 0 (view) | — |

## Facilitator Endpoints

The PAUSE facilitator at `https://facilitator.pausesecure.com` provides:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/verify` | POST | Validate intent signature, check on-chain status |
| `/settle` | POST | Execute `commit()` on-chain, return tx hash |
| `/health` | GET | Service health check |
| `/info` | GET | Supported networks, contract addresses, pricing |

## Token Requirements

- The token must be ERC-20 compatible
- The client must have `balance >= amount`
- The client must have called `token.approve(PAUSECommitAddress, amount)` before the server can commit
- USDC on Ethereum Mainnet: `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`

## Network Deployment

| Network | Chain ID | Contract | Status |
|---------|----------|----------|--------|
| Ethereum Mainnet | 1 | `0x604152D82Fd031cCD8D27F26C5792AC2CD328bF4` | Deployed |
| Base | 8453 | TBD | Planned Q2 2026 |
| Arbitrum | 42161 | TBD | Planned Q2 2026 |

## Reference Implementation

- Risk extension: [`@pausesecure/x402-risk`](https://www.npmjs.com/package/@pausesecure/x402-risk)
- Commit scheme: [`@pausesecure/x402-commit`](https://www.npmjs.com/package/@pausesecure/x402-commit)
- Scanner: [pausescan.com](https://pausescan.com)
- Platform: [pausesecure.com](https://pausesecure.com)
