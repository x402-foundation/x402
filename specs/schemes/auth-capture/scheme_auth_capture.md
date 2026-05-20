# Scheme: `auth-capture`

## Summary

`auth-capture` is a payment scheme where funds can be held and settled later. The client authorizes a maximum amount, and the server or facilitator submits it — either locking funds in escrow for later settlement (two-phase) or sending them directly to the receiver with refund capability (single-shot).

The **captureAuthorizer** is provided by the server and is the entity authorized to authorize, capture, void, refund, or charge a payment. In a facilitator-submits flow, that's either the facilitator itself or any smart contract that ends up calling the underlying escrow.

Unlike `exact`, which has no built-in mechanism for returning funds, `auth-capture` supports returning funds to the client through void, refund, and reclaim.

## Example Use Cases

- Refundable payments with buyer protection
- Delayed delivery where the client needs recourse if the service is unsatisfactory
- Subscription or session billing with periodic captures against a single authorization

## Settlement Paths

The scheme supports two settlement paths, selected by the operation `type` passed to the facilitator:

| `type`      | Behavior                                                                                                                     |
| :---------- | :--------------------------------------------------------------------------------------------------------------------------- |
| `authorize` | Two-phase. Funds held in escrow. CaptureAuthorizer can capture, void, refund. Client can reclaim if capture deadline passes. |
| `charge`    | Single-shot. Funds sent directly to receiver. CaptureAuthorizer can refund post-settlement.                                  |

### Two-phase (`type: "authorize"`)

```
AUTHORIZE → RESOURCE DELIVERED → CAPTURE / VOID → (REFUND)
```

1. **Authorize**: Client authorization is submitted — funds locked in escrow.
2. **Resource delivered**: Server returns the resource (HTTP 200).
3. **Capture or void**: The captureAuthorizer can capture (finalize funds to the receiver) or void (release escrowed funds back to client).
4. **Reclaim**: If the capture deadline passes without action, the client can reclaim directly.
5. **Refund**: After capture, the captureAuthorizer can refund within the refund window.

### Single-shot (`type: "charge"`)

```
CHARGE → RESOURCE DELIVERED → (REFUND)
```

1. **Charge**: Client authorization is submitted — funds sent directly to receiver.
2. **Resource delivered**: Server returns the resource (HTTP 200).
3. **Refund**: The captureAuthorizer can refund within the refund window.

No capture, void, or reclaim — funds are never held in escrow.

## Server Operations

Facilitators MUST provide a mechanism for servers to perform `authorize`, `charge`, `capture`, `void`, and `refund` operations. Servers select the operation by passing a `type` field to the facilitator's `verify` and `settle` endpoints. Network bindings define the payload fields required for each operation.

Facilitators MAY require proof that the server controls the signed authorization's `payTo` address before performing server-initiated operations. Facilitators that require this proof MUST signal it with `extra.serverAuthorizationRequired` in the payment requirements. Network bindings may define a `serverAuthorization` field for this purpose.

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

## Appendix

Network-specific implementation details include contracts, signature formats, and verification logic in per-network documents.

### References

- [Escrow Scheme Proposal — Agentokratia (Issue #834)](https://github.com/coinbase/x402/issues/834)
- [Escrow Scheme Proposal — x402r (Issue #1011)](https://github.com/coinbase/x402/issues/1011)
