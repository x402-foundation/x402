# Scheme: `exact` `bip122`

## Summary

`exact` on chains of unspent transaction outputs of the Bitcoin kind, named in CAIP-2 with the CAIP-4 namespace
`bip122`. The client pays a fixed amount of the chain's own coin to `payTo` with an ordinary signed transaction.
The facilitator checks the transaction, hands it to its own node and reports success once the transaction is in
as many blocks as the resource server asked for.

Such chains have no authorization that the payee executes later (as EIP-3009 is for EVM chains), and a node built
on Bitcoin Core 28 or later replaces a transaction that waits for a block with one that spends the same coins for
a higher fee. A resource server that gives anything of value therefore waits for a block. A waiting transaction is
public, so the payload carries a `claim`: a secret the client chooses, which binds what was paid for to whoever
made the payment.

Use cases:

- an API or a page that asks automated clients for a small payment instead of a proof of work or a sign-up;
- a timestamping service that writes a hash into the chain and is paid in the same chain's coin;
- agents that pay one another in a coin they can mine themselves, with no account and no issuer.

Network identifiers: `bip122:` followed by the first 32 hexadecimal characters of the hash of the chain's first
block, for example `bip122:000000000019d6689c085ae165831e93` (Bitcoin) or `bip122:470c8b8ae824c06575cfae0851282c49`
(TrueNorth, the chain this was first built for).

## Payment header payload

`PaymentRequirements` (see [`x402-specification-v2.md`](../../x402-specification-v2.md)) for this scheme:

```json
{
  "scheme": "exact",
  "network": "bip122:470c8b8ae824c06575cfae0851282c49",
  "amount": "1020440",
  "asset": "NORTH",
  "payTo": "north1z6l4xyfv0detpymktgwm8juds6qh0efsjt7rzh3z4w7xn0j5zcfmqzn4rnj",
  "maxTimeoutSeconds": 60,
  "extra": {"confirmations": 1}
}
```

- `amount` MUST be in the chain's smallest unit (10^-8 of a coin on Bitcoin and its descendants), as a decimal string.
- `asset` names the chain's own coin (see Appendix, open question 1).
- `payTo` MUST be an address of that chain in the form its software prints.
- `extra.confirmations` is the number of blocks the transaction MUST be in before the resource is given. `0` means
  as soon as the facilitator's node accepts the transaction. When absent, the facilitator's own setting applies
  (`1` in the reference implementation). A facilitator MAY require more blocks than the resource server asks for,
  never fewer.

The `payload` of the `PaymentPayload`:

```json
{
  "x402Version": 2,
  "accepted": { "...": "the PaymentRequirements above, unchanged" },
  "payload": {
    "transaction": "0200000000010112ab...",
    "claim": "5f0c9b3e8a7d41f2b6c0e1d2a3b4c5d6"
  }
}
```

- `transaction` MUST be a fully signed transaction in hexadecimal, ready for the network. It MUST have exactly one
  output to `payTo`, of at least `amount`. Other outputs (change) are the client's.
- `claim` MUST be 32 to 128 lowercase hexadecimal characters chosen at random for this payment, and the client
  MUST NOT disclose it to anyone but the resource server. It is REQUIRED when `extra.confirmations` is above 0.
- The client SHOULD use a fresh change address for each payment and SHOULD NOT broadcast the transaction itself;
  the facilitator does.

## Verification

The facilitator MUST reject the payload, with the reason given, when:

1. `x402Version` is not 2 (`invalid_x402_version`);
2. `accepted` differs from the requirements in `scheme`, `network`, `amount`, `asset` or `payTo`
   (`invalid_payment_requirements`);
3. `transaction` is not hexadecimal, is longer than the facilitator allows, or does not decode (`invalid_payload`,
   `invalid_transaction`);
4. no output pays `payTo`, or the one that does pays less than `amount` (`insufficient_funds`), or more than one
   output pays `payTo` (`invalid_payload`);
5. `claim` is absent while `extra.confirmations` is above 0 (`claim_required`), or is not of the stated form
   (`invalid_payload`);
6. its node would not accept the transaction into its mempool, also when the node has it already, waiting or in a
   block: whoever presents a transaction that is already out need not be who paid (`transaction_refused_by_node`);
7. the transaction was settled or is being settled, and the payload's `claim` is not the one it was first shown
   with (`transaction_already_used`), or the `resource` of the `PaymentPayload` is not the one it was first shown
   for (`invalid_payment_requirements`): one payment buys one resource.

Example of `/verify` for a payment copied from the mempool by someone else:

```json
{"isValid": false, "invalidReason": "transaction_already_used", "payer": null}
```

## Settlement

1. The first time a transaction passes verification, the facilitator MUST durably record its id, a hash of its
   `claim`, the output that pays, the requirements and the `resource` of the payload, and only then hand the
   transaction to its node. The resource server MUST check that the payload's `resource` is the one requested.
2. While the paying output is in fewer blocks than `extra.confirmations`, `/settle` answers:

   ```json
   {"success": false, "errorReason": "awaiting_confirmation", "transaction": "9c4e...", "network": "bip122:470c8b8ae824c06575cfae0851282c49",
    "payer": null, "confirmations": 0, "required": 1}
   ```

   and the resource server answers the client `202 Accepted` with `Retry-After` and `PAYMENT-RESPONSE`.
3. The client sends the same `PAYMENT-SIGNATURE` again. It MUST still match the requirements recorded at step 1, and
   those MUST cover what the resource server asks now: the same `scheme`, `network`, `asset` and `payTo`, and a
   recorded `amount` at least the current one (`invalid_payment_requirements` otherwise). A resource server whose
   price moves SHOULD keep accepting the prices it quoted for a while, so that a payment that waits for its block
   is not refused because the price rose meanwhile.
4. Once the output is deep enough, `/settle` answers `success: true` with `transaction` set to the transaction id,
   records that it was given, and the resource server answers `200` with the resource.
5. When the node no longer knows the paying output, the facilitator SHOULD hand the transaction to it once more; if
   the output is still unknown, it answers `payment_not_found` (the coins were spent by another transaction).
6. The same transaction with the same `claim` MAY be settled again for a short time after step 4 (600 seconds in
   the reference implementation), so that a response lost on the way can be fetched; after that,
   `transaction_already_used`.
7. When the facilitator itself fails (its node is away, a timeout), the resource server answers `503` with
   `Retry-After`, not `402`: the payment may already be recorded and broadcast, and the client MUST keep it and its
   `claim` and send them again.

## Security considerations

- **Replay.** A transaction is settled once: the record of step 1 is written before the transaction leaves the
  facilitator and survives a restart. Showing it again only fetches what it already paid for, and only with its
  `claim`.
- **Authorization scope.** The client signs a transaction that pays `payTo` and its own change, nothing else. The
  facilitator holds no coins, signs nothing and can only broadcast the transaction it was given or not.
- **Settlement atomicity.** Payment and delivery cannot be one step on these chains. With `confirmations` above 0
  the resource is given only after the payment is in the chain; the client bears the wait, not the risk. With
  `confirmations: 0` the resource server bears the risk that the transaction is replaced before a block; it is
  meant for prices that only keep automated callers away.
- **Front-running a waiting payment.** A copy of the transaction from the mempool has no `claim` and buys nothing.
- **Reorganization.** One block is the default; a resource server selling something dear SHOULD ask for more.
- **Privacy.** The facilitator learns the client's change output.

## Appendix

Implementation: a working one exists outside the x402 SDKs (Python, standard library only, tried on a regression
test chain). A reference implementation in the Python SDK would follow once this specification is accepted.

Open questions for the maintainers:

1. `asset` for a chain's own coin: its ticker, as here, or a fixed word such as `native`.
2. `202 Accepted` and `awaiting_confirmation` are not in `transports-v2/http.md`. Should payments that wait for a
   block be described there, or should this be a scheme of its own rather than `exact`?
3. `claim` as a field of this payload, or as an extension shared with other schemes that settle later.
