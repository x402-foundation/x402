# Scheme: `auth-capture`

## Summary

`auth-capture` is a payment scheme in which the client authorizes a maximum amount, and the payment then has a lifecycle: it can be held before it is finalized, finalized for less than the maximum, cancelled outright, or returned after the fact. Where `exact` moves a fixed amount once and offers no way to give it back, `auth-capture` is for payments whose final amount is not known when the client authorizes, or which may later need to be undone.

## Example use cases

- Refundable payments with buyer protection.
- Delayed delivery, where the client needs recourse if the service turns out to be unsatisfactory.
- Metered work priced only once it completes: hold the ceiling, capture the actual cost.
- Subscription or session billing with periodic captures against one authorization.

## Lifecycle operations


| Operation   | Effect                                                          | Repeatable                                            |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------- |
| `authorize` | Reserves the client's funds, where they are held.               | No — once per payment.                                |
| `charge`    | Collects and distributes the funds in one step, with no hold.   | No — once per payment.                                |
| `capture`   | Pays held funds out to the receiver.                            | Yes — up to the held total.                           |
| `void`      | Releases the remaining hold back to the client.                 | No — only while a hold remains.                       |
| `refund`    | Returns captured funds to the client.                           | Yes — up to the amount captured and not yet refunded. |
| `reclaim`   | Client recovers its own hold after the capture deadline passes. | No.                                                   |


`reclaim` is the client's unilateral escape hatch and is never relayed through the facilitator. Every other operation is initiated by the resource server and relayed by the facilitator, except where a network binding runs later lifecycle operations out of band.

## Payment flows

Which operations a payment can undergo follows from its payment flow:


| `extra.paymentFlow` | Ordering                   | Lifecycle                                                                                                                                                                                              |
| ------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `escrow`            | settle → resource → settle | `authorize` places the hold before the resource runs, then `capture` or `void` afterwards, and `refund` later still. If the capture deadline passes with the hold untouched, the client can `reclaim`. |
| `authorization`     | verify → resource → settle | `charge` after the resource runs, and `refund` later. No hold, therefore no `capture`, `void`, or `reclaim`.                                                                                           |


The scheme default is `escrow`. 

## Lifecycle operations are `/settle` calls

Because a payment can settle more than once, the facilitator must be able to tell the settlements apart. The payment flow already fixes whether the client's authorization is settled as `authorize` or as `charge`, so the client names no operation. Later operations are named on the settle payload (for example `payload.type` of `"capture"`, `"void"`, or `"refund"`). No new facilitator endpoint is involved.

Those later lifecycle settles are outside the `escrow` ordering above. The flow's post-resource settle is the in-request finalize; further `capture`, `void`, and `refund` calls are scheme lifecycle, not a rewrite of that ordering. `refund` is always after the fact.

For `escrow`, that post-resource `capture` (or `void`) MAY complete synchronously during the request, or asynchronously after it returns. Asynchronous finalize requires the resource server to retain durable state for the payment. Sync versus async is a server choice; the wire format does not name a mode.

A network binding MAY relay only the collect settle (`authorize` or `charge`) and leave later lifecycle operations out of band.

## Core properties

**Fund safety.** The amount settled is capped by the client-authorized maximum, and any fee is bounded by client-authorized limits. Held funds remain recoverable once the capture deadline passes, so a resource server that abandons a payment cannot strand it forever.

**Payment identity.** Each payment has a unique identity. A collected authorization cannot be collected again.

**Expiry enforcement.** Two absolute timestamps govern the lifecycle. The capture deadline (`extra.captureDeadline`) is the last moment held funds can be captured, and the moment `reclaim` becomes available. The refund deadline (`extra.refundDeadline`) is the last moment a refund can be issued. A network binding MAY derive further deadlines, such as a pre-approval expiry from `maxTimeoutSeconds`.

**Server consent.** `charge` (the settled amount), `capture`, `void`, and `refund` are not client-authorized. A network binding MUST authenticate that facilitator-relayed operations of those kinds are consented to by the resource server (or run them out of band under the operator's own rules). `authorize` is client-authorized.

**Replay protection.** `capture` and `refund` are repeatable up to remaining balances; each consent for them MUST be single-use. Who enforces that — facilitator or settlement layer — is binding-defined.

## Relationship to `exact`


| Aspect     | `exact`                                 | `auth-capture`                                                       |
| ---------- | --------------------------------------- | -------------------------------------------------------------------- |
| Amount     | Fixed, known when the client authorizes | Up to a client-authorized maximum, finalized later                   |
| Settlement | One transfer                            | Hold then capture (`escrow`), or direct (`authorization`)            |
| Reversible | No                                      | Yes — `void` before capture, `refund` after, `reclaim` by the client |
| Fees       | None                                    | Client-bounded, taken at capture or charge                           |


## Security Considerations

1. **Capture margin before `captureDeadline`**: In the two-phase path, reclaim becomes available to the client the moment `captureDeadline` passes, so a capture initiated near the deadline races both the client's reclaim and its own transaction latency — a capture that lands after the deadline reverts and the escrow returns to the client even though the resource was already delivered. CaptureAuthorizers should treat `captureDeadline − margin` as the effective deadline, with the margin sized to cover capture-transaction latency, any batching cadence, and clock skew. This matters most for the periodic-capture use case, where the final capture naturally drifts toward the end of the window.

2. **CaptureAuthorizer liveness is settlement liveness**: Funds reach the receiver only if the captureAuthorizer acts inside the capture window. If it is unavailable for the remainder of the window, the client reclaims and the receiver bears the loss for resources already delivered; in the single-shot path the same outage instead blocks refunds, shifting the risk to the client. `captureDeadline` should be sized with authorizer downtime in mind, and receivers should capture promptly after delivery rather than deferring to the end of the window.

3. **CaptureAuthorizer compromise and settlement finality**: The captureAuthorizer can void before capture and refund after it, until `refundDeadline`. A compromised authorizer — or one colluding with a payer — can therefore return already-settled funds to the client after the resource was delivered. Receivers should treat `refundDeadline`, not capture, as the moment of settlement finality and price that exposure window accordingly; using a contract (arbiter, multisig) rather than an EOA as the captureAuthorizer reduces single-key risk. Fee parameters are a second lever: with `feeRecipient` unset, a compromised authorizer may direct up to `maxFeeBps` of every capture to an address of its choice, so clients should keep `maxFeeBps` tight and pin `feeRecipient` where the fee model allows.

4. **Delivery before on-chain authorization re-opens the serve/settle race**: Escrow protects the receiver against the payer invalidating funds after delivery — but only once `authorize()` (or `charge()`) is confirmed on-chain. A server that delivers the resource on successful verification alone (signature check + simulation) is exposed to the same race as `exact`'s verify-then-settle flow: balances or allowances can move between simulation and settlement so that collection fails after the resource is gone. Servers wanting escrow-grade safety should deliver only after settlement confirmation.

5. **Operation-level idempotency**: The payment nonce is consumed on-chain, so a duplicate authorization is rejected — but capture, void, and refund are separately triggered operations, and their transport-level retries are not covered by that nonce. Facilitator APIs exposing these operations should define an idempotency key per operation and replay the original outcome for repeats, rather than surfacing a revert that tempts callers into blind retries. This matters most for partial-capture billing, where several captures legitimately share one authorization.

## Appendix

### Network requirements

Every `auth-capture` network binding MUST specify:

1. **Hold / settlement mechanism** — how funds are reserved, captured, voided, and refunded, and how deadlines are enforced.
2. **Client authorization format** — the payload the client produces, and how the payment's identity derives from it.
3. **Operator model** — who may drive each lifecycle operation, and which operations the facilitator relays.
4. **Server consent** — how facilitator-relayed lifecycle operations are authenticated as originating from the resource server.
5. **Replay protection** — how repeatable operations (`capture`, `refund`) are made single-use per consent.
6. **Per-operation verification and settlement** — the checks a facilitator runs for each operation, and the call it makes.
7. **Refund funding** — who supplies refund liquidity, given that a facilitator must not be an unexpected source of value.
8. **Sync capture-and-void** — how a single `/settle` can finalize a partial capture and release any remainder when lifecycle is facilitator-relayed.

### Network bindings

- [`scheme_auth_capture_evm.md`](./scheme_auth_capture_evm.md) — EVM.

## Version History


| Version | Date       | Changes                                    | Authors   |
| ------- | ---------- | ------------------------------------------ | --------- |
| v1.1    | 2026-08-18 | Payment flow lifecycles and operator types | @phdargen |
| v1.0    | 2026-05-13 | Initial draft                              | @A1igator |


