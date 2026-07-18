# Scheme: `auth-capture`

## Summary

`auth-capture` is a payment scheme where funds can be held and settled later. The client authorizes a maximum amount, and the facilitator submits it — either locking funds in escrow for later settlement (two-phase) or sending them directly to the receiver with refund capability (single-shot).

The **captureAuthorizer** is the entity authorized to authorize, capture, void, refund, or charge a payment. In a facilitator-submits flow, that's either the facilitator itself or any smart contract that ends up calling the underlying escrow.

Unlike `exact`, which has no built-in mechanism for returning funds, `auth-capture` supports returning funds to the client through void, refund, and reclaim.

## Example Use Cases

- Refundable payments with buyer protection
- Delayed delivery where the client needs recourse if the service is unsatisfactory
- Subscription or session billing with periodic captures against a single authorization

## Settlement Paths

The scheme supports two settlement paths, selected via `extra.autoCapture`:

| `autoCapture`     | Behavior                                                                                                                     |
| :---------------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `false` (default) | Two-phase. Funds held in escrow. CaptureAuthorizer can capture, void, refund. Client can reclaim if capture deadline passes. |
| `true`            | Single-shot. Funds sent directly to receiver. CaptureAuthorizer can refund post-settlement.                                  |

### Two-phase (`autoCapture: false`, default)

```
AUTHORIZE → RESOURCE DELIVERED → CAPTURE / VOID → (REFUND)
```

1. **Authorize**: Client authorization is submitted — funds locked in escrow.
2. **Resource delivered**: Server returns the resource (HTTP 200).
3. **Capture or void**: The captureAuthorizer can capture (finalize funds to the receiver) or void (release escrowed funds back to client).
4. **Reclaim**: If the capture deadline passes without action, the client can reclaim directly.
5. **Refund**: After capture, the captureAuthorizer can refund within the refund window.

### Single-shot (`autoCapture: true`)

```
CHARGE → RESOURCE DELIVERED → (REFUND)
```

1. **Charge**: Client authorization is submitted — funds sent directly to receiver.
2. **Resource delivered**: Server returns the resource (HTTP 200).
3. **Refund**: The captureAuthorizer can refund within the refund window.

No capture, void, or reclaim — funds are never held in escrow.

## Core Properties

### Fund Safety

- Cannot overcharge — settlement amount is capped by the client-signed maximum.
- Two-phase path: client can reclaim escrowed funds after the capture deadline if no action is taken.
- Fee bounds are client-signed and enforced at settlement.

### Replay Prevention

- Each payment has a unique nonce derived from the payment parameters and a fresh client-generated salt.
- Nonce is consumed on-chain at settlement, preventing double-spend.

### Expiry Enforcement

Two absolute-timestamp deadlines govern the payment lifecycle (network-specific implementations may add a derived pre-approval expiry from `maxTimeoutSeconds`):

- **Capture deadline** (`captureDeadline`): Last moment to capture escrowed funds (two-phase); after this, the client can reclaim.
- **Refund deadline** (`refundDeadline`): Last moment to issue a refund on captured or charged payments.

## Relationship to `exact`

| Aspect     | `exact`            | `auth-capture`                                                        |
| :--------- | :----------------- | :-------------------------------------------------------------------- |
| Settlement | Immediate transfer | Via escrow (two-phase) or direct with refund capability (single-shot) |
| Refundable | No                 | Yes (both paths)                                                      |
| Fee system | None               | Configurable (min/max bounds, client-signed)                          |

## Security Considerations

1. **Capture margin before `captureDeadline`**: In the two-phase path, reclaim becomes available to the client the moment `captureDeadline` passes, so a capture initiated near the deadline races both the client's reclaim and its own transaction latency — a capture that lands after the deadline reverts and the escrow returns to the client even though the resource was already delivered. CaptureAuthorizers should treat `captureDeadline − margin` as the effective deadline, with the margin sized to cover capture-transaction latency, any batching cadence, and clock skew. This matters most for the periodic-capture use case, where the final capture naturally drifts toward the end of the window.

2. **CaptureAuthorizer liveness is settlement liveness**: Funds reach the receiver only if the captureAuthorizer acts inside the capture window. If it is unavailable for the remainder of the window, the client reclaims and the receiver bears the loss for resources already delivered; in the single-shot path the same outage instead blocks refunds, shifting the risk to the client. `captureDeadline` should be sized with authorizer downtime in mind, and receivers should capture promptly after delivery rather than deferring to the end of the window.

3. **CaptureAuthorizer compromise and settlement finality**: The captureAuthorizer can void before capture and refund after it, until `refundDeadline`. A compromised authorizer — or one colluding with a payer — can therefore return already-settled funds to the client after the resource was delivered. Receivers should treat `refundDeadline`, not capture, as the moment of settlement finality and price that exposure window accordingly; using a contract (arbiter, multisig) rather than an EOA as the captureAuthorizer reduces single-key risk. Fee parameters are a second lever: with `feeRecipient` unset, a compromised authorizer may direct up to `maxFeeBps` of every capture to an address of its choice, so clients should keep `maxFeeBps` tight and pin `feeRecipient` where the fee model allows.

4. **Delivery before on-chain authorization re-opens the serve/settle race**: Escrow protects the receiver against the payer invalidating funds after delivery — but only once `authorize()` (or `charge()`) is confirmed on-chain. A server that delivers the resource on successful verification alone (signature check + simulation) is exposed to the same race as `exact`'s verify-then-settle flow: balances or allowances can move between simulation and settlement so that collection fails after the resource is gone. Servers wanting escrow-grade safety should deliver only after settlement confirmation.

5. **Operation-level idempotency**: The payment nonce is consumed on-chain, so a duplicate authorization is rejected — but capture, void, and refund are separately triggered operations, and their transport-level retries are not covered by that nonce. Facilitator APIs exposing these operations should define an idempotency key per operation and replay the original outcome for repeats, rather than surfacing a revert that tempts callers into blind retries. This matters most for partial-capture billing, where several captures legitimately share one authorization.

## Appendix

Network-specific implementation details (contracts, signature formats, verification logic) are in per-network documents: `scheme_auth_capture_evm.md` (EVM).

### References

- [Escrow Scheme Proposal — Agentokratia (Issue #834)](https://github.com/coinbase/x402/issues/834)
- [Escrow Scheme Proposal — x402r (Issue #1011)](https://github.com/coinbase/x402/issues/1011)
