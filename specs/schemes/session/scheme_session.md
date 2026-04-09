# Scheme: `session`

## Summary

`session` is a scheme that establishes a **streaming payment channel** between a client and a resource server. The client deposits funds into an on-chain escrow contract and signs cumulative off-chain vouchers authorizing increasing payment amounts. The server settles periodically or at session close, enabling high-frequency, low-cost payments by batching many off-chain voucher signatures into periodic on-chain settlements.

This scheme is ideal for metered services where the total cost is not known in advance and grows with consumption over multiple requests or streaming responses.

## Example Use Cases

- Paying for LLM token generation over a streaming SSE response (charge per token generated)
- Multiple paid API calls over a persistent session (charge per request)
- Bandwidth or data transfer metering across a series of requests (charge per byte transferred)
- Long-running compute jobs with periodic billing (charge based on time or resources consumed)

## Core Properties (MUST)

The `session` scheme MUST enforce the following properties across ALL network implementations:

### 1. Escrow-Based Fund Locking

Client deposits MUST be held in an on-chain escrow contract. Funds are locked and can only be released through:

- **Server settlement**: Using a valid voucher signature from the client
- **Cooperative close**: Client requests close with a final voucher, server calls close on-chain, settling and refunding remainder
- **Forced close**: Client-initiated close request followed by a grace period and withdrawal

- Rationale: Provides trustless fund safety. Neither party can unilaterally seize funds beyond what is authorized. Unlike allowance-based schemes, escrow guarantees funds availability throughout the session.
- Implementation: On EVM, a dedicated escrow contract holds deposits and enforces voucher-based withdrawals. Other networks MUST implement equivalent escrow semantics.

### 2. Cumulative Voucher Authorization

Each voucher specifies a **cumulative total** authorized, not an incremental delta. Vouchers MUST be monotonically increasing in amount.

- Voucher #1: `cumulativeAmount = 100` (authorizes 100 total)
- Voucher #2: `cumulativeAmount = 250` (authorizes 250 total, supersedes #1)
- Voucher #3: `cumulativeAmount = 400` (authorizes 400 total, supersedes #1 and #2)

- Rationale: Cumulative semantics prevent rollback attacks (old vouchers are automatically superseded), simplify server accounting (always track the highest), and enable idempotent voucher submission.
- Implementation: On EVM, vouchers are EIP-712 signed typed data containing `channelId` and `cumulativeAmount`. The escrow contract computes settlement delta as `cumulativeAmount - settled`. Other networks MUST implement equivalent cumulative, signed authorization.

### 3. Multi-Settlement Support

The server MAY settle against the escrow multiple times during a session using the latest voucher, without closing the channel. Each settlement advances the on-chain `settled` counter.

- Rationale: Allows the server to periodically claim earned revenue without ending the session, reducing counterparty risk for long-running sessions.
- Implementation: On EVM, the escrow contract's `settle()` function allows the payee to withdraw `cumulativeAmount - settled` at any time. Other networks MUST implement equivalent partial settlement.

### 4. Deposit-Capped Authorization

The cumulative voucher amount MUST NOT exceed the on-chain deposit. The escrow contract enforces this as a hard cap.

- `cumulativeAmount <= channel.deposit` at all times
- The client controls exposure by choosing the deposit amount
- Additional funds can be added via top-up without closing the channel

- Rationale: Provides budget control enforced by the contract, not by trust. The client can never be charged more than deposited.
- Implementation: On EVM, the escrow contract reverts if settlement exceeds deposit. Other networks MUST implement equivalent deposit cap enforcement.

### 5. Stateful Server Accounting

The server MUST maintain per-session accounting state tracking:

- `acceptedCumulative`: Highest valid voucher amount accepted
- `spent`: Cumulative amount charged for delivered service
- `settledOnChain`: Last cumulative amount settled on-chain
- Available balance: `available = acceptedCumulative - spent`

- Rationale: Enables mid-stream balance checks, crash recovery (server can settle from persisted state), and accurate per-request billing.
- Implementation: Servers MUST persist state updates (especially `spent` increments) BEFORE delivering service to ensure crash safety.

### 6. Channel Lifecycle

Each session follows a defined lifecycle:

1. **Open**: Client deposits funds, channel created with unique ID
2. **Active**: Client signs vouchers, server provides service, server may periodically settle, client may top-up deposit
3. **Close**: Cooperative (server calls close with final voucher) or forced (client requests close, grace period, then withdrawal)

- Rationale: Clear lifecycle enables deterministic fund recovery for both parties under all scenarios (normal operation, crash, disappearance).

### 7. Mid-Stream Balance Signaling

When the server's available balance is exhausted during a streaming response, the server MUST signal the client to submit a new voucher before continuing service delivery.

- Rationale: Enables pay-as-you-go streaming without pre-committing the entire session cost upfront.
- Implementation: On HTTP with SSE, servers emit a `payment-need-voucher` event. Other transports MUST implement equivalent signaling.

## Cross-Cutting Concerns

### Payer Identification

Network implementations MUST provide a mechanism to identify the payer (depositor) in the `payload` field. This is necessary for server-side verification of on-chain transactions and accounting. On EVM, the `from` field carries the payer's address (consistent with `exact` and `upto` scheme conventions). Other networks MUST implement equivalent payer identity binding.

## Out of Scope

The following patterns are NOT supported by `session` and would require different schemes:

- **Fixed-price single payments**: Use the `exact` scheme for predetermined amounts
- **Variable single-request payments**: Use the `upto` scheme for single-request usage-based billing
- **Cross-chain sessions**: Each session channel is bound to a single chain
- **Multi-currency sessions**: Each channel uses a single token; multi-token billing requires multiple channels

## Relationship to Other Schemes

| Scheme | Scope | Settlement | Trust Model | State |
| :--- | :--- | :--- | :--- | :--- |
| `exact` | Single request, fixed amount | 1 on-chain tx | Facilitator broadcasts | Stateless |
| `upto` | Single request, variable amount | 1 on-chain tx | Client trusts server with max | Stateless |
| **`session`** | **Multi-request / streaming** | **2+ on-chain txs (open + close)** | **Escrow contract enforces** | **Stateful** |

The `session` scheme fills the gap explicitly carved out by `upto`:

> From `scheme_upto.md` Out of Scope:
> - **Multi-settlement / streaming**: Settling the same authorization multiple times (e.g., pay-per-chunk streaming)
> - **Recurring payments**: Automatic periodic charges without new authorizations
> - **Open-ended allowances**: Authorizations without time bounds or single-use constraints

## Network-Specific Implementation

Network-specific rules and implementation details are defined in the per-network scheme documents:

- EVM chains: See [`scheme_session_evm.md`](./scheme_session_evm.md)
