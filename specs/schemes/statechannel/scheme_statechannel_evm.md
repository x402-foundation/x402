# Scheme: `statechannel` on `EVM`

## Summary

The `statechannel` scheme on EVM uses a state channel smart contract (`X402StateChannel`) as an on-chain adjudicator. Payments are signed off-chain as EIP-712 typed data; only channel lifecycle events (open, deposit, dispute, close) require on-chain transactions.

The route mode is declared in the `extensions.statechannel.info.route` field:

| Route | Payment Proof | Settlement |
|-------|--------------|------------|
| `hub` | Hub-issued ticket + channel proof | Hub routes funds to payee off-chain; settles on-chain via close or rebalance |
| `direct` | Signed channel state update | Payee holds latest state; settles on-chain via cooperative or unilateral close |

In both cases, the Facilitator (hub) or Payee cannot move funds beyond the balance authorized in the latest co-signed state.

---

## 1. PaymentRequired Response

### Hub Route (`route: "hub"`)

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://payee.example/v1/data",
    "description": "Premium endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "statechannel",
      "network": "eip155:8453",
      "amount": "1000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "pay.eth",
      "maxTimeoutSeconds": 60,
      "extra": {}
    }
  ],
  "extensions": {
    "statechannel": {
      "info": {
        "route": "hub",
        "hubEndpoint": "https://pay.eth/.well-known/x402",
        "mode": "proxy_hold",
        "feeModel": {
          "base": "10",
          "bps": 30
        },
        "quoteExpiry": 1770000000
      },
      "schema": {
        "type": "object"
      }
    }
  }
}
```

### Direct Route (`route: "direct"`)

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "https://payee.example/v1/data",
    "description": "Premium endpoint",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "statechannel",
      "network": "eip155:8453",
      "amount": "1000000",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "payTo": "0x2222222222222222222222222222222222222222",
      "maxTimeoutSeconds": 60,
      "extra": {}
    }
  ],
  "extensions": {
    "statechannel": {
      "info": {
        "route": "direct",
        "payeeAddress": "0x2222222222222222222222222222222222222222",
        "challengePeriodSec": 3600
      },
      "schema": {
        "type": "object"
      }
    }
  }
}
```

---

## 2. EIP-712 State Signing

All off-chain state updates are signed using EIP-712 typed data.

### 2.1 Domain Separator

```
EIP712Domain(
  string name = "X402StateChannel",
  string version = "1",
  uint256 chainId,
  address verifyingContract
)
```

### 2.2 ChannelState Type

```
ChannelState(
  bytes32 channelId,
  uint64 stateNonce,
  uint256 balA,
  uint256 balB,
  bytes32 locksRoot,
  uint64 stateExpiry,
  bytes32 contextHash
)
```

| Field | Type | Description |
|-------|------|-------------|
| `channelId` | `bytes32` | Deterministic channel identifier (see §5) |
| `stateNonce` | `uint64` | Strictly monotonic sequence number. Higher nonce supersedes lower. |
| `balA` | `uint256` | Participant A balance in atomic token units |
| `balB` | `uint256` | Participant B balance in atomic token units |
| `locksRoot` | `bytes32` | Reserved for conditional claims (`0x00...00` in v1) |
| `stateExpiry` | `uint64` | Unix timestamp after which this state is invalid (0 = no expiry) |
| `contextHash` | `bytes32` | Commitment to payment context (payee, resource, invoiceId, paymentId) |

**Constraint:** `balA + balB` MUST equal the channel's on-chain `totalBalance`. The contract rejects states that violate this.

### 2.3 Digest Computation

```
structHash = keccak256(abi.encode(
    STATE_TYPEHASH,
    channelId, stateNonce, balA, balB,
    locksRoot, stateExpiry, contextHash
))

digest = keccak256("\x19\x01" || DOMAIN_SEPARATOR || structHash)
```

The signer signs this digest with `signDigest` (raw ECDSA, not `eth_sign` — the `\x19\x01` prefix is already included).

### 2.4 Signature Format

All signatures MUST be 65 bytes: `r (32) || s (32) || v (1)`. The `s` value MUST be in the lower half of the secp256k1 curve order per EIP-2. `v` MUST be 27 or 28.

---

## 3. `PAYMENT-SIGNATURE` Header Payload

### 3.1 Hub Route

The client sends a hub-issued ticket plus a channel proof linking the ticket to the signed state:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "statechannel",
    "network": "eip155:8453",
    "amount": "1000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "pay.eth",
    "maxTimeoutSeconds": 60
  },
  "payload": {
    "route": "hub",
    "paymentId": "pay_01JY0R8J6M2W2M5F5J35B5XW2A",
    "invoiceId": "inv_01JY0R8H8GY6Q9B5CZ7GRDCCJ8",
    "ticket": {
      "ticketId": "tkt_01JY0R8P2Q9MM1E3FC0S53X8GX",
      "hub": "0xHubAddress...",
      "payee": "0x2222222222222222222222222222222222222222",
      "invoiceId": "inv_01JY0R8H8GY6Q9B5CZ7GRDCCJ8",
      "paymentId": "pay_01JY0R8J6M2W2M5F5J35B5XW2A",
      "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      "amount": "1000000",
      "feeCharged": "3010",
      "totalDebit": "1003010",
      "expiry": 1770000300,
      "policyHash": "0x7f2c4ac6...",
      "sig": "0x..."
    },
    "channelProof": {
      "channelId": "0x7a0de7b4...",
      "stateNonce": 42,
      "stateHash": "0x7607fdbf...",
      "sigA": "0x..."
    }
  }
}
```

**Ticket fields:**

| Field | Type | Description |
|-------|------|-------------|
| `ticketId` | string | Unique ticket identifier |
| `hub` | EVM address | Hub signer address |
| `payee` | EVM address | Intended recipient |
| `invoiceId` | string | Payee quote binding |
| `paymentId` | string | Idempotency key |
| `asset` | EVM address | Payment token contract |
| `amount` | uint string | Payment amount to payee (atomic units) |
| `feeCharged` | uint string | Fee retained by hub |
| `totalDebit` | uint string | Total deducted from payer's channel balance (`amount + feeCharged`) |
| `expiry` | unix timestamp | Ticket validity deadline |
| `policyHash` | bytes32 hex | Hash of the fee policy applied |
| `sig` | hex bytes | Hub's `eth_sign` signature over the canonicalized ticket JSON |

**Channel proof fields:**

| Field | Type | Description |
|-------|------|-------------|
| `channelId` | bytes32 hex | The payer↔hub channel |
| `stateNonce` | uint64 | Nonce of the signed state backing this payment |
| `stateHash` | bytes32 hex | Hash of the signed channel state |
| `sigA` | hex bytes | Payer's EIP-712 signature over the channel state |

**Ticket signing:** The hub signs tickets using `eth_sign` over `keccak256(canonicalJson)`, where `canonicalJson` is the ticket object (without `sig`) with all keys recursively sorted alphabetically, then `JSON.stringify`'d.

### 3.2 Direct Route

The client sends the signed channel state directly to the payee:

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "statechannel",
    "network": "eip155:8453",
    "amount": "1000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x2222222222222222222222222222222222222222",
    "maxTimeoutSeconds": 60
  },
  "payload": {
    "route": "direct",
    "paymentId": "pay_01JY0R8J6M2W2M5F5J35B5XW2A",
    "channelState": {
      "channelId": "0x7a0de7b4...",
      "stateNonce": 101,
      "balA": "9000000",
      "balB": "1000000",
      "locksRoot": "0x0000000000000000000000000000000000000000000000000000000000000000",
      "stateExpiry": 1770000320,
      "contextHash": "0x5f4cf45e..."
    },
    "sigA": "0x...",
    "payer": "0x1111111111111111111111111111111111111111",
    "payee": "0x2222222222222222222222222222222222222222",
    "amount": "1000000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  }
}
```

---

## 4. Verification Logic

### 4.1 Hub Route

The **payee** MUST validate the following in order:

1. **Parse** — Base64-decode the `PAYMENT-SIGNATURE` header, then parse the result as JSON (per the [HTTP transport spec](../../transports-v2/http.md)). For compatibility with existing SCP reference deployments, implementations MAY fall back to parsing raw JSON directly if base64 decoding fails.
2. **Scheme check** — `accepted.scheme` MUST be `"statechannel"`. `payload.route` MUST be `"hub"`.
3. **Ticket signature** — Recover signer from `ticket.sig` using `eth_sign` over the canonicalized ticket hash. Recovered address MUST match `ticket.hub`, which MUST be a known hub address.
4. **State-hash binding** — If `channelProof.channelState` is present, `channelProof.stateHash` MUST equal `hash(channelProof.channelState)`. If `ticket.stateHash` is present, it MUST equal `channelProof.stateHash`.
5. **Ticket expiry** — `ticket.expiry` MUST be in the future.
6. **Payee match** — `ticket.payee` MUST match the verifying payee's own address.
7. **Amount match** — `ticket.amount` MUST be ≥ the required payment amount for this resource.
8. **Asset match** — `ticket.asset` MUST match the resource's required asset.
9. **Invoice binding** — `ticket.invoiceId` MUST match the invoice issued for this request.
10. **Idempotency** — `paymentId` MUST NOT have been previously consumed (replay protection).
11. **Optional: Hub confirmation** — Payee MAY call `GET /v1/payments/{paymentId}` on the hub to confirm ticket status.

### 4.2 Direct Route

The **payee** MUST validate the following in order:

1. **Parse** — Base64-decode the `PAYMENT-SIGNATURE` header, then parse the result as JSON (per the [HTTP transport spec](../../transports-v2/http.md)). For compatibility with existing SCP reference deployments, implementations MAY fall back to parsing raw JSON directly if base64 decoding fails.
2. **Scheme check** — `accepted.scheme` MUST be `"statechannel"`. `payload.route` MUST be `"direct"`.
3. **Signer recovery** — Recover signer from `sigA` via EIP-712 typed data recovery over `channelState`. Recovered address MUST match `payer` and MUST be `participantA` in the channel.
4. **Nonce ordering** — `channelState.stateNonce` MUST be strictly greater than the last accepted nonce for this channel.
5. **Balance conservation** — `channelState.balA + channelState.balB` MUST equal the channel's on-chain `totalBalance`.
6. **Debit sufficiency** — `previousState.balA - channelState.balA` MUST be ≥ the required payment amount.
7. **State expiry** — If `channelState.stateExpiry > 0`, it MUST be in the future.
8. **Asset and network match** — `accepted.asset` and `accepted.network` (or their direct-envelope equivalents) MUST match the channel's on-chain parameters.
9. **Idempotency** — `paymentId` MUST NOT have been previously consumed.

### 4.3 Hub Internal Validation

When the hub receives a signed state from the agent during ticket issuance (`POST /v1/tickets/issue`), the hub MUST validate:

1. **Signer recovery** — Recovered signer matches `participantA` of the channel.
2. **Nonce ordering** — `stateNonce` strictly greater than last accepted.
3. **Balance conservation** — `balA + balB == totalBalance`.
4. **Debit correctness** — `previous.balA - current.balA == quote.totalDebit` (amount + fee).
5. **Fee bounds** — `feeCharged <= agent's maxFee` from the quote request.
6. **State expiry** — Not expired.
7. **Context binding** — `contextHash` commits to `{payee, resource, invoiceId, paymentId, amount, asset}`.

---

## 5. Smart Contract Interface

### 5.1 Channel ID Derivation

```solidity
channelId = keccak256(abi.encode(
    block.chainid,
    address(this),    // contract address
    msg.sender,       // participantA
    participantB,
    asset,
    salt
))
```

Channel IDs are permanently consumed — the same parameters with the same salt cannot reopen a channel after closure.

### 5.2 Core Functions

```solidity
function openChannel(
    address participantB,
    address asset,
    uint256 amount,
    uint64 challengePeriodSec,
    uint64 channelExpiry,
    bytes32 salt,
    uint8 hubFlags
) external payable returns (bytes32 channelId);

function deposit(bytes32 channelId, uint256 amount) external payable;

function cooperativeClose(
    ChannelState calldata st,
    bytes calldata sigA,
    bytes calldata sigB
) external;

function startClose(
    ChannelState calldata st,
    bytes calldata sigFromCounterparty
) external;

function challenge(
    ChannelState calldata newer,
    bytes calldata sigFromCounterparty
) external;

function finalizeClose(bytes32 channelId) external;

function rebalance(
    ChannelState calldata state,
    bytes32 toChannelId,
    uint256 amount,
    bytes calldata sigCounterparty
) external;
```

### 5.3 Hub Flags

The `hubFlags` field controls which participant(s) may call `rebalance()`:

| Value | Meaning | Rebalance permitted by |
|-------|---------|------------------------|
| `0` | No hub | Nobody (rebalance blocked) |
| `1` | A is hub | A only |
| `2` | B is hub | B only |
| `3` | Both | Either |

For agent↔hub channels, use `hubFlags=2` (B is hub). For hub↔payee channels, use `hubFlags=1` (A is hub).

### 5.4 Contract Validation Rules

1. `balA + balB` MUST equal `totalBalance`.
2. `stateNonce` MUST be strictly greater than `latestNonce` for cooperative close, challenge, and rebalance. `startClose` permits equal nonce.
3. States with `stateExpiry > 0 && block.timestamp > stateExpiry` are rejected.
4. `challenge()` is only callable during the challenge window (`block.timestamp <= closeDeadline`).
5. `finalizeClose()` is only callable after the challenge window.
6. `cooperativeClose()` is blocked if the channel is already closing.
7. Failed ETH/ERC-20 transfers during payout are deferred to a pull-based `withdrawPayout()` rather than reverting.
8. `openChannel` requires: `participantB != address(0)`, `challengePeriodSec > 0`, `channelExpiry > block.timestamp`, `amount > 0`, `hubFlags <= 3`.
9. Only channel participants may call `deposit`, `startClose`, and `challenge`.
10. `rebalance()` requires: caller is a hub participant (per `hubFlags`), caller is a participant in the destination channel, same asset on both channels, destination not closing or expired, and `amount <= hub's balance` in the signed state.

---

## 6. Settlement Logic

### 6.1 Cooperative Close (Preferred)

Both parties sign the final state. Either submits:

```
cooperativeClose(finalState, sigA, sigB)
```

The contract verifies both EIP-712 signatures, then transfers `balA` to A and `balB` to B in a single transaction. No challenge period.

### 6.2 Unilateral Close + Challenge

If one party is unresponsive:

1. **Start close** — Submit the latest state with the counterparty's signature:
   ```
   startClose(state, sigCounterparty)
   ```
   Sets `closeDeadline = block.timestamp + challengePeriodSec`.

2. **Challenge** — During the challenge period, the counterparty MAY submit a higher-nonce state:
   ```
   challenge(newerState, sigCounterparty)
   ```
   Updates the close state and resets the deadline.

3. **Finalize** — After the deadline expires:
   ```
   finalizeClose(channelId)
   ```
   Pays out `closeBalA` to A, `closeBalB` to B. Failed transfers are deferred to `withdrawPayout()`.

### 6.3 Hub Rebalancing

The hub routes payments between channels. When an agent pays the hub on channel X, the hub credits the payee on channel Y. To keep on-chain accounting accurate, the hub calls:

```
rebalance(fromState, toChannelId, amount, sigCounterparty)
```

This atomically:
- Verifies the counterparty signature on `fromState`, proving the hub has earned `amount`
- Deducts `amount` from the source channel's `totalBalance`
- Credits `amount` to the destination channel's `totalBalance`
- Updates funded balance tracking on both channels
- Records the signed state on the source channel

The hub MUST have `hubFlags` set on both channels. Both channels MUST use the same asset. The destination MUST NOT be closing or expired.

**Example:**
```
Channel 1 (agent↔hub): total=5, state{balA=4, balB=1}
Channel 2 (hub↔payee): total=0

Hub calls rebalance(state, ch2, 1, agentSig)
→ Channel 1: total=4
→ Channel 2: total=1
```

---

## 7. Hub Payment Flow (Discovery → Quote → Issue → Pay)

The hub route follows a four-step flow that integrates with standard x402 semantics:

**Step 1 — Discovery:**
1. Client requests a protected resource.
2. Server returns HTTP `402` with `accepts[]` containing a `statechannel` offer where `extensions.statechannel.info.route` is `"hub"`.

**Step 2 — Quote:**
1. Client sends `POST /v1/tickets/quote` to the hub with `{invoiceId, paymentId, channelId, payee, asset, amount, maxFee}`.
2. Hub returns `{fee, feeBreakdown, totalDebit, ticketDraft, expiry}`.
3. Client verifies `fee <= maxFee`.

**Step 3 — Issue:**
1. Client creates the next channel state: `stateNonce += 1`, `balA -= totalDebit`, `balB += totalDebit`.
2. Client signs the state via EIP-712.
3. Client submits `POST /v1/tickets/issue` with `{quote, channelState, sigA}`.
4. Hub validates (see §4.3) and returns a signed ticket.

**Step 4 — Pay:**
1. Client retries the original request with the `PAYMENT-SIGNATURE` header containing the ticket and channel proof.
2. Payee verifies (see §4.1) and returns the resource.

---

## 8. Streaming Extension

SCP supports interval-based payment streaming via the `stream` field in the extension metadata:

```json
{
  "extensions": {
    "statechannel": {
      "info": {
        "route": "hub",
        "stream": {
          "amount": "100000000000",
          "t": 5
        },
        "hubEndpoint": "https://pay.eth/.well-known/x402"
      },
      "schema": { "type": "object" }
    }
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `stream.amount` | uint string | Amount debited per tick (atomic units) |
| `stream.t` | number | Tick cadence in seconds |

The client signs a new state update every `t` seconds, debiting `stream.amount`. The server returns stream metadata with each response:

```json
{
  "stream": {
    "amount": "100000000000",
    "t": 5,
    "nextCursor": 10,
    "hasMore": true
  }
}
```

The client MUST wait `t` seconds before the next tick. The client SHOULD stop when `hasMore` is `false`.

---

## 9. Fee Model

Hub route implementations use:

```
fee = base + floor(amount × bps / 10000) + gasSurcharge
```

| Parameter | Description |
|-----------|-------------|
| `base` | Flat fee per payment (atomic units) |
| `bps` | Variable fee in basis points (30 bps = 0.3%) |
| `gasSurcharge` | Pass-through for on-chain gas costs |

The agent MUST set `maxFee` in the quote request. The hub MUST reject if the computed fee exceeds `maxFee`. The agent MUST verify the fee before signing the channel state.

---

## 10. Security Considerations

### 10.1 Replay Prevention

Each state includes: `channelId` (unique per chain + contract + participants + salt), `stateNonce` (monotonically increasing), and `chainId` (via EIP-712 domain). This prevents cross-channel, same-channel, and cross-chain replay.

### 10.2 Authorization Scope

A signed state authorizes a specific balance split on a specific channel. The signature covers `channelId`, `balA`, `balB`, and `contextHash`. The hub or payee cannot claim more than the signed amount, and cannot redirect funds to a different recipient (bound by `contextHash`).

### 10.3 Settlement Atomicity

- Cooperative close settles in one transaction.
- Unilateral close has a challenge period to prevent stale-state fraud.
- Rebalance is atomic — both channel balances update in the same transaction.
- Failed transfers are deferred (not reverted) to prevent griefing.

### 10.4 Fund Safety

The hub cannot move funds without a co-signed state. This aligns with x402's trust-minimizing principle: the facilitator routes payments but never has unilateral custody.

### 10.5 Context Binding

`contextHash` SHOULD commit to: `{payee, resourceUri, httpMethod, invoiceId, paymentId, amount, asset, quoteExpiry}`. This binds each payment to a specific request context, preventing the hub from redirecting ticket proceeds.

---

## Appendix

### A. Canonical Contract Deployment

| Parameter | Value |
|-----------|-------|
| CREATE2 Factory | `0x4e59b44847b379578588920ca78fbf26c0b4956c` |
| CREATE2 Salt | `x402s:X402StateChannel:v1` |
| Canonical Address | `0x07ECA6701062Db12eDD04bEa391eD226C95aaD4b` |

Same factory + bytecode + salt = same address on any EVM chain.

### B. Supported Networks

| Network | Chain ID | CAIP-2 |
|---------|----------|--------|
| Ethereum Mainnet | 1 | `eip155:1` |
| Base | 8453 | `eip155:8453` |
| Sepolia (testnet) | 11155111 | `eip155:11155111` |
| Base Sepolia (testnet) | 84532 | `eip155:84532` |

### C. Reference Implementation

- Contract: [`contracts/X402StateChannel.sol`](https://github.com/Keychain-Inc/x402s/blob/main/contracts/X402StateChannel.sol)
- Hub: [`node/scp-hub/server.js`](https://github.com/Keychain-Inc/x402s/blob/main/node/scp-hub/server.js)
- Agent: [`node/scp-agent/agent-client.js`](https://github.com/Keychain-Inc/x402s/blob/main/node/scp-agent/agent-client.js)
- Payee: [`node/scp-demo/payee-server.js`](https://github.com/Keychain-Inc/x402s/blob/main/node/scp-demo/payee-server.js)
- Full specification: [`docs/X402S_SPEC_V2.md`](https://github.com/Keychain-Inc/x402s/blob/main/docs/X402S_SPEC_V2.md)
