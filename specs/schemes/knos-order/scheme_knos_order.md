# Scheme: `knos-order`

## Summary

`knos-order` is a scheme in which the client's payment is held by an on-chain escrow and released to the resource server only when an agreed acceptance is signed by a third party. If no acceptance arrives before a deadline, the full amount returns to the client.

Where `exact` pays before the resource is served and `auth-capture` lets the resource server decide how much of a hold to capture, `knos-order` gives the decision to neither side: the terms of acceptance are fixed when the payment is funded, and the party that signs the acceptance is named in those terms. The facilitator holds no key to the funds and cannot move them.

It is meant for resources that are work rather than a response: the result is judged after the HTTP exchange is over.

## Use Cases

- An agent sells a code change and is paid when the pull request is merged with the buyer's named checks passing.
- A build or data job is paid when a signed run of a pinned CI workflow shows that the output met the agreed checks.
- Any delivery where the buyer should not pay first and the seller should not deliver against a promise.

## Payment Flow

| Step | What happens | Who moves funds |
| ---- | ------------ | --------------- |
| 1 | The resource server answers `402` with the order to fund: amount, asset, terms of acceptance, the judge, the work time. | nobody |
| 2 | The client funds the order on chain. The amount (and the escrow's fee, if any) leaves the client. | client, into escrow |
| 3 | The client retries with the order's address as its payment proof. | nobody |
| 4 | `/verify`: the facilitator reads the order from the chain and checks it against the requirements. | nobody |
| 5 | The resource server delivers. `/settle` confirms the escrow again and returns a `SettlementResponse` whose extension says `escrowed`. | nobody |
| 6 | Later, the judge named in the terms signs the acceptance; the escrow pays `payTo`. Or the deadline passes and the escrow refunds the client. | the escrow program |

Step 6 is outside the HTTP exchange. A `SettlementResponse` with `success: true` in this scheme means "the funds are locked for this resource under these terms", not "the resource server has been paid".

## Core Properties (MUST)

### 1. Funds are locked before the resource is served

The facilitator MUST verify, from chain state, that an escrow exists for at least `amount` of `asset` before it reports the payment valid. A transaction signature alone is not proof.

### 2. Terms are bound at funding time

The escrow MUST store a commitment to the acceptance terms and to the judge. The facilitator MUST compare both with the `PaymentRequirements`. Neither the client nor the resource server can change them afterwards without the other.

### 3. Neither party, nor the facilitator, can release the funds alone

Release to `payTo` MUST require the judge's signed acceptance, verified on chain. The facilitator MUST NOT hold any authority over the escrow.

### 4. Time-bound, with a full refund

The escrow MUST carry a deadline. After it, an unpaid escrow MUST be refundable in full to the client by a permissionless instruction.

### 5. One escrow, one resource

An escrow MUST be bound to one resource (the scope named in the requirements) and MUST NOT be accepted as payment for a second delivery.

## What the scheme does not provide

- **Atomic delivery.** The resource server delivers against locked funds and carries the risk that acceptance never comes; the client carries the risk that the delivery is not accepted and waits for the deadline to be refunded.
- **A judgement of quality.** The judge signs that the agreed checks passed. The scheme says nothing more about the work.
- **Partial settlement.** The escrow pays the amount whole or refunds it whole.

## Network-Specific Implementation

- Solana: see [`scheme_knos_order_svm.md`](./scheme_knos_order_svm.md). The escrow is the open-source `knos_pay` program and the acceptance is a GitHub Actions OIDC token verified on chain by `knos-oidc`. Both are deployed on Solana **devnet only**.

## Appendix

### Relation to other schemes

| | `exact` | `auth-capture` (`escrow` flow) | `knos-order` |
| --- | --- | --- | --- |
| Who decides that funds are released | the client, by paying | the resource server, by capturing | a third party named in the terms |
| When | before the resource | after the resource, at the server's choice | when the acceptance is signed |
| Client recourse | none | `void`, `refund`, `reclaim` after the deadline | refund after the deadline |
| Facilitator authority over funds | submits the transfer | relays lifecycle operations | none |

### Naming

The scheme is named after the escrow instrument of its first network binding (a Knos work order). The properties above do not depend on that program; a binding on another network needs an escrow with the same five properties. The name is open to change in review.
