# Scheme: `batch-settlement`

## Summary

`batch-settlement` is a payment scheme in which the client provides a cryptographic payment commitment at request time, but the transfer of value is not executed synchronously during that request. The commitment is accepted, access is granted immediately, and financial settlement occurs later through a process defined by the network binding.

Per-request onchain settlement may not be ideal for some real-world use cases. `batch-settlement` exists to serve situations where gas fees exceed the value of individual requests, block confirmation time is incompatible with HTTP response latency, request volume requires batched settlement, or settlement happens through infrastructure that operates asynchronously from HTTP (payment channels, fiat billing systems, stablecoin invoices).

The model of how a commitment is formed, what backs it, and how it is eventually redeemed,is defined entirely by the network binding.

The `batch-settlement` scheme supports **dynamic pricing**: the client commits up to the maximum per-request price (`PaymentRequirements.amount`), but the server may charge a lower actual price after executing the request. The actual charge is communicated via the `PAYMENT-RESPONSE`.

## Protocol behavior

For `exact` and `upto`, verification and settlement happen in a single pass: the commitment is validated, a transaction is broadcast, and value has moved. The settlement result contains an onchain transaction hash.

For `batch-settlement`, verification confirms the commitment is valid, but settlement stores it rather than executing a transfer. The settlement result contains a commitment identifier, but value moves later, through the network binding's redemption process.

### Commitment identifier

The settlement result MUST include a non-empty commitment identifier on success. This identifier is meaningful to the network binding; a token, a voucher ID, channel receipt hash, account ledger reference, or equivalent.

## Commitment models

Network bindings may choose one of two trust models for backing the client's commitment.

### Capital-backed

The client's commitment is backed by onchain capital committed before or during the session such as pre-funded escrow, a payment channel, or a delegated authorization against a wallet balance. The trust anchor is the client's own funds. No network intermediary is required to underwrite access.

### Credit-backed

The client's commitment is backed by a verified identity associated with a billing account managed by a trusted network intermediary. No onchain capital is required from the client. The network authenticates the identity, underwrites the access obligation, and settles with the resource server through off-chain infrastructure on a defined schedule.

## Use cases

**Escrow-backed micropayments.** An AI agent pre-funds an onchain escrow at session start. Each sub-cent API call produces a signed voucher drawn against that balance. The provider accumulates vouchers and redeems them in a single onchain transaction at session end, keeping per-request gas cost to zero.

**Payment channel streaming.** A client and provider open a payment channel once. Each request increments a signed running total (a receipt). The provider closes the channel periodically, collecting accumulated value in one settlement regardless of how many individual requests were made.

**Delegated authorization.** A client delegates spending authority to an operator against their wallet balance. The operator signs commitments per request on the client's behalf. The provider collects authorizations and settles them through the delegation contract.

**Credit-backed content licensing.** A content publisher monetizes AI crawler access. Crawlers authenticate via a network-registered identity backed by a billing account. The network verifies each request, accumulates usage, and invoices the crawler operator on a billing cycle with no wallet or onchain interaction required from the client.

## Settlement lifecycle

All `batch-settlement` network bindings share this abstract lifecycle. The network binding defines the specifics of each phase.

1. **Commit.** The client produces a cryptographic payment commitment and attaches it to the request. The commitment is validated and stored. The resource is served immediately.

2. **Accumulate.** The network retains the commitment in a voucher store, channel state, account ledger, or billing system. The network binding defines who stores commitments, where, and for how long.

3. **Redeem.** Value is transferred out of band through an onchain contract call, a channel close, a fiat batch invoice, or any rail the network defines. The trigger, timing, and mechanism are network-defined.

## Appendix

### Network requirements

Every `batch-settlement` network binding MUST specify:

1. **Commitment format** — the structure and encoding of the payment payload, including all fields required for verification and redemption.
2. **Verification rules** — how the commitment is validated: signature scheme, balance or credit check, replay prevention, expiry.
3. **Storage behavior** — what constitutes a stored commitment for this network, and what the commitment identifier contains on success.
4. **Double-spend prevention** — how the network ensures the same commitment cannot be accepted or redeemed more than once.
5. **Commitment expiry** — when commitments become invalid and what happens to unaccepted commitments after expiry.
6. **Redemption** — who triggers redemption, when, and through what rail.
7. **Trust model** — whether the trust anchor is the client's onchain capital (capital-backed) or a network intermediary (credit-backed), and what guarantee the seller has of eventual settlement.

### Extensions

Network bindings may use optional extensions to communicate additional requirements in the `PaymentRequired` response. See the [extensions directory](../../extensions/) for available specifications.

### Related schemes

[`exact`](../exact/scheme_exact.md) — value is transferred immediately per request.

[`upto`](../upto/scheme_upto.md) — value is transferred immediately, variable amount up to a client-authorized maximum.