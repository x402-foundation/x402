# Scheme: `batch-settlement` on `Cardano`

Status: **draft**, v0.6 (2026-09-25). Reference implementation and preprod measurements:
[loveaihq/subbit-x402](https://github.com/loveaihq/subbit-x402) (`src/x402/`, [`RESULTS.md`](https://github.com/loveaihq/subbit-x402/blob/main/RESULTS.md)).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.

## Summary

`batch-settlement` on Cardano is **capital-backed**: the client locks funds in a unidirectional
payment channel on the Cardano ledger and pays for each request with a signed, cumulative IOU.
The resource server checks each IOU off-chain and serves at once; it redeems what it has charged
later, in batches, with one transaction covering many channels. Unused funds go back to the client
through a cooperative close, or through the channel's own timed exit when either party stops
cooperating.

The channels are [Subbit](https://github.com/kompact-io/subbit-xyz) channels, an Aiken validator
(Apache-2.0). This binding is written against commit `66648db`, validator
`subbit.subbit.spend`, script hash `62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a`.

Compared with the EVM binding:

- Every transaction is built and signed by the party it concerns, which also pays its fee, as in
  Cardano `exact`: the client opens, tops up and cooperatively closes; the server redeems. The
  facilitator holds **no key and no funds**; it verifies against the chain and broadcasts
  transactions other parties signed.
- A redemption moves value to the server in the same transaction, so there is no separate sweep.
- A redemption can take less than the IOU it presents: pricing can be dynamic, as on EVM.
- Channels are UTxOs, so a channel's position (`channelRef`) moves with every redemption; its
  identity (`channelId`) does not.

## Network identifiers

As Cardano `exact`: `cardano:mainnet`, `cardano:preprod`, `cardano:preview`. Implementations SHOULD
accept the CIP-34 forms (`cip34:1-764824073`, `cip34:0-1`, `cip34:0-2`) and normalise them.

Assets are written as in Cardano `exact`: `lovelace` for ADA, `<policyId>.<assetNameHex>` for a
native token.

## The channel

### Datum

A channel is a UTxO at the validator's address, with this inline datum:

```
Datum     = [ ownHash: ScriptHash, Constants, Stage ]
Constants = [ tag: Bytes, currency: Ada | Asset(policy, name), iouKey: Ed25519 public key (32 B),
              consumer: KeyHash, provider: KeyHash, closePeriod: Int (ms) ]
Stage     = Opened(subbed) | Closed(subbed, elapseAt) | Settled
```

`subbed` is the cumulative amount redeemed so far. Aiken tuples are Plutus lists and enums are
constructors (indices 0, 1, 2 in the order written).

### Steps, and who must sign them

| Step | From → to | Signer | The validator requires |
|---|---|---|---|
| open | (no script runs) | anyone | nothing: every check falls to the server and facilitator |
| `Add` | Opened → Opened | consumer | the currency amount grows; stage unchanged |
| `Sub(owed, sig)` | Opened → Opened | provider | `sig` is the IOU for `owed`; new `subbed` ≤ `owed`; currency taken = new `subbed` − old `subbed` |
| `Close` | Opened → Closed | consumer | `subbed` unchanged; currency amount unchanged or larger; validity upper bound ≤ `elapseAt` − `closePeriod` |
| `Settle(owed, sig)` | Closed → Settled | provider | `sig` is the IOU for `owed`; currency taken ≤ `owed` − `subbed` |
| `End` | Settled → (gone) | consumer | — |
| `Elapse` | Closed → (gone) | consumer | validity lower bound ≥ `elapseAt` |
| `Mutual` | any → (anything) | consumer **and** provider | the channel is the only input at the validator |

Continuing outputs MUST keep the address (including its stake part), the constants, and hold ADA
plus at most the channel's currency; they MUST NOT carry a reference script.

**Batching.** One transaction MAY spend several channels: the lexicographically first channel
input carries `Main([step, …])`, one step per channel in input order; every other channel input
carries `Defer`; continuing outputs appear in the same order. The provider signs once.

### IOUs

An IOU is an Ed25519 signature by `iouKey` over the Plutus `serialiseData([tag, amount])`: the
indefinite-length CBOR list `0x9f ‖ bytes(tag) ‖ uint(amount) ‖ 0xff`. `amount` is cumulative.
Tags longer than 64 bytes are chunked by `serialiseData` and MUST NOT be used. Test vector:

```
private key seed  0707…07 (32 bytes)
public key        ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
tag               1111…11 (32 bytes)
amount            203000
message           9f58201111111111111111111111111111111111111111111111111111111111111111 1a000318f8 ff
signature         d09aac1f109a70db6328acec3e83d01f9d894d6bab248b03e8689ac3818526582426262cbd8c14ec2d763696910748159405ff38ee3d049c1a3954ddfa073a08
```

IOUs carry no expiry.

Each channel has its own IOU key. A client SHOULD derive it from its wallet, so that a client
that has lost its records can make the key again from the chain (*Client verification rules*).
The reference client signs, once, the message below with the wallet's payment key (CIP-8
`signData`), takes the Ed25519 signature out of the resulting COSE_Sign1, and derives

```
root = HKDF-SHA256(ikm = that signature, salt = "x402 batch-settlement cardano", info = "iou root v1", 32 bytes)
seed = HKDF-SHA256(ikm = root, salt = "x402 batch-settlement cardano", info = "iou key v1 <network> <tag hex>", 32 bytes)
```

with `seed` the channel's Ed25519 private key. The message:

```
x402 batch-settlement on Cardano, IOU keys v1. Sign this only for your own x402 client: this signature derives the keys that authorize payments from your channels.
```

Anyone holding that signature can derive the IOU key of every channel the wallet opens, so a
wallet MUST sign this message for its own client only. Ed25519 is deterministic, so the same
wallet software gives the same keys every time; wallet software that encodes the COSE headers
differently gives other keys, and a channel whose key does not derive again can only be left
(*Client verification rules*). The derivation is the client's own business: nothing on chain or
at the server depends on it.

### Identity and position

- `channelId` is the channel's `tag`, 32 bytes, lower-case hex. The client MUST derive it as
  blake2b-256 of the CBOR of one of the inputs its opening transaction spends, and MUST use a
  fresh `iouKey` for every channel: an IOU is bound to `(iouKey, tag)`, so the pair must be unique.
- `channelRef` is the channel's current `txHash#index`. It changes with every `Sub` and `Add`.
  Parties find the current position by following each spending transaction from any earlier one.

## Minimum UTxO value

Every output must hold its min-UTxO in ADA, and a channel output carries a large datum:

- The **reserve** is the min-UTxO of the channel's largest continuing output, the `Closed` stage,
  holding its currency, at current parameters and with every integer at its widest encoding.
  Measured on preprod: 1.73 tADA for an ADA channel, 2.13 tADA for a token channel.
- **Capacity** (x402 `balance`) is how far an IOU may go and still be redeemable without the
  consumer. IOUs are cumulative, so capacity is `subbed` plus what the channel can still pay out.
- **ADA channel.** It can pay out its lovelace minus the reserve. An IOU beyond capacity cannot be
  redeemed without the consumer, because the continuing output would fall below its minimum.
- **Token channel.** It can pay out all its tokens. The validator counts only the
  currency, so the ADA beside the tokens is kept up by min-UTxO alone, and a redemption MAY take
  it down to the continuing output's exact minimum (measured: 2.133450 → 2.042940 tADA). A
  client MUST therefore put in exactly the reserve and no more; the facilitator MUST require at
  least the reserve.
- **Refund payout.** In a cooperative close the server's unredeemed share is an output of its
  own. An ADA share below min-UTxO (about 1 ADA), or any token share, cannot stand alone: the
  server claims it first, and the refund then owes it nothing.

## Channel lifecycle

1. **Open (deposit).** On the first request, the client builds and signs a transaction creating
   the channel output, and sends it with the IOU for this request. The facilitator verifies it
   and, after the handler runs, broadcasts it and waits for the confirmation policy. The response
   carries the new `channelRef`.
2. **Requests.** Each request carries a voucher for `chargedCumulativeAmount + amount`. The server
   checks it, serves, and counts the charge locally. Nothing is broadcast.
3. **Top up (deposit).** When a voucher would pass the capacity, the client builds and signs an
   `Add` on the channel's current position and sends it as a `deposit` naming that position in
   `voucher.channelRef`, with the IOU for this request. It is verified and broadcast as an
   opening is; the channel keeps its id and moves to the top-up's output.
4. **Redeem (claim).** The server builds and signs a `Sub` over one or more channels, taking what
   it charged from each, and sends it to the facilitator to broadcast.
5. **Cooperative close (refund).** The client builds a `Mutual` transaction paying the server its
   unredeemed share and itself the rest, signs it, and sends it with a zero-charge voucher; the
   server checks it and adds its signature; the facilitator broadcasts.
6. **Unilateral exit** (outside x402). The consumer `Close`s; the server MUST `Settle` its latest
   IOU before `elapseAt`; the consumer then `End`s, or `Elapse`s after `elapseAt` if the server
   never settled. The validator gives `Settle` no deadline of its own: after `elapseAt` a late
   settle and an elapse race, so `elapseAt` is the server's deadline in practice. A server finds
   out about a close by watching its channels (*Claim and settlement strategy*).

## 402 response: `PaymentRequirements`

| Field | Value |
|---|---|
| `scheme` | `batch-settlement` |
| `network` | a Cardano network identifier |
| `asset` | `lovelace` or `<policyId>.<assetNameHex>` |
| `amount` | the per-request maximum, in the asset's atomic units |
| `payTo` | the server's bech32 address; redemptions pay out to it |
| `maxTimeoutSeconds` | as in the core specification |
| `extra` | below |

| `extra` field | Type | Req | Meaning |
|---|---|---|---|
| `scriptHash` | hex, 28 B | yes | the validator the server accepts; pins its version and the channel's payment credential |
| `receiverAuthorizer` | hex, 28 B | yes | the key hash that goes into the datum's `provider` field and signs every redemption |
| `withdrawDelay` | integer, seconds | yes | the close period; the datum holds `withdrawDelay × 1000` ms. MUST be within 900 – 2,592,000 and ≥ `maxTimeoutSeconds` |
| `referenceScript` | `txHash#index` | no | an output carrying the validator as a reference script; its script hash MUST equal `scriptHash` |
| `minDeposit` | atomic integer string | no | a capacity hint, ≥ `amount`; the facilitator MUST NOT enforce it |
| `confirmationPolicy` | `{ l1Confirmations }` | no | as in Cardano `exact`: the evidence required before a deposit counts |
| `channelState`, `voucherState` | object | corrective 402 only | see *Server* |

There is no `assetTransferMethod`, and `paymentFlow` is `authorization`.

```json
{
  "scheme": "batch-settlement",
  "network": "cardano:preprod",
  "asset": "lovelace",
  "amount": "1000",
  "payTo": "addr_test1qrxchm0g4la6hqfd9wq6vuuldx7l20az52t7lvgpgujr8pvwmpzru5kuf4mpmvtaf0hlsjtz7t4r2h7tj9v3c02dhljq0wqkef",
  "maxTimeoutSeconds": 300,
  "extra": {
    "scriptHash": "62ce4309e37e09e5c633c96c6ae68061c434f122d32626d6912d7c2a",
    "receiverAuthorizer": "cd8bede8affbab812d2b81a6739f69bdf53fa2a297efb10147243385",
    "withdrawDelay": 900,
    "referenceScript": "544752f68665183e51c8ecb6e0a835543aec64a6ec8e7588d34470ddfd12cdb5#0",
    "minDeposit": "10000"
  }
}
```

## Client: payment construction

```ts
type ChannelConfig = {
  payer: string;              // consumer key hash, hex 28 B
  payerAuthorizer: string;    // iouKey, hex 32 B
  receiver: string;           // == payTo
  receiverAuthorizer: string; // == extra.receiverAuthorizer
  token: string;              // == asset
  withdrawDelay: number;      // == extra.withdrawDelay
};
type Voucher = { channelId: string; maxClaimableAmount: string; signature: string /* hex 64 B */; channelRef?: string };
```

`voucher.channelRef` is the channel's position as the client last saw it. It MUST be present in
`voucher` and `refund` payloads; the facilitator follows the channel from it to its current
position.

### `deposit`

```ts
{ type: "deposit"; channelConfig; voucher; deposit: { amount: string; transaction: string } }
```

`transaction` is the base64 CBOR of a fully signed transaction that creates the channel output:
datum as above at `Opened(0)`, holding exactly `deposit.amount` of the currency and, for a token
channel, exactly the reserve in ADA. `voucher.maxClaimableAmount` is `amount` for a new channel.
The client SHOULD size capacity at least `max(minDeposit, 10 × amount)`.

A **top-up** is a `deposit` whose `voucher.channelRef` is set. Its `transaction` spends the channel
at that position with `Main([Add])`, spends nothing else at the validator, and recreates the
channel at the same address with the same datum and exactly `deposit.amount` more of the currency;
a token channel keeps at least the reserve in ADA. `voucher.maxClaimableAmount` is
`chargedCumulativeAmount + amount`, within the capacity after the top-up. The client SHOULD add at
least `max(minDeposit, 10 × amount)`.

### `voucher`

```ts
{ type: "voucher"; channelConfig; voucher }   // maxClaimableAmount = chargedCumulativeAmount + amount
```

Values from the IOU test vector above; `channelRef` is illustrative.

```json
{
  "type": "voucher",
  "channelConfig": {
    "payer": "00b7847c89d5721592fc0cc8932f50a8f8258b39b93861140a1b99fb",
    "payerAuthorizer": "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c",
    "receiver": "addr_test1qrxchm0g4la6hqfd9wq6vuuldx7l20az52t7lvgpgujr8pvwmpzru5kuf4mpmvtaf0hlsjtz7t4r2h7tj9v3c02dhljq0wqkef",
    "receiverAuthorizer": "cd8bede8affbab812d2b81a6739f69bdf53fa2a297efb10147243385",
    "token": "lovelace",
    "withdrawDelay": 900
  },
  "voucher": {
    "channelId": "1111111111111111111111111111111111111111111111111111111111111111",
    "maxClaimableAmount": "203000",
    "signature": "d09aac1f109a70db6328acec3e83d01f9d894d6bab248b03e8689ac3818526582426262cbd8c14ec2d763696910748159405ff38ee3d049c1a3954ddfa073a08",
    "channelRef": "2222222222222222222222222222222222222222222222222222222222222222#0"
  }
}
```

### `refund`

```ts
{ type: "refund"; channelConfig; voucher /* maxClaimableAmount = chargedCumulativeAmount */; transaction: string; providerWitness?: string }
```

`transaction` is the base64 CBOR of a `Mutual` transaction the consumer has signed: it spends the
channel and nothing else, lists exactly the consumer and the server as required signers, pays the
server its unredeemed share at `payTo` (none, when the server has claimed first), and returns the
rest to the consumer with the fee taken from the channel. Collateral MUST be the consumer's own
ADA-only UTxOs. `providerWitness` is added by the server, never by the client. A refund closes
the channel; reuse means opening a new one.

## Server: state and forwarding

### Per-channel state

`channelId`, `channelConfig`, `channelRef`, `balance` (capacity), `totalClaimed` (`subbed`),
`withdrawRequestedAt` (seconds; `elapseAt − closePeriod` once closed, else 0),
`chargedCumulativeAmount`, `signedMaxClaimable`, `signature`, `onchainSyncedAt`, and a
`pendingRequest` reservation.

### Request processing

1. **Before verify.** The config MUST match the requirements (`receiver`, `receiverAuthorizer`,
   `token`, `withdrawDelay`). A paid voucher MUST equal `chargedCumulativeAmount + amount` (a refund
   voucher: `chargedCumulativeAmount`); otherwise the server answers the **corrective 402**. With
   no record, the base is `maxClaimableAmount − amount`. When the mirrored chain state is fresh
   (within `clamp(withdrawDelay / 3, 30 s, 5 min)`), the server MAY verify a voucher locally with
   the facilitator's rules below and skip `/verify`. A voucher above the recorded balance may
   follow a top-up the server has not seen (one confirmed after its request gave up, or an `Add`
   made outside x402); the server SHOULD then send it to `/verify`, which reads the channel, and
   take the balance from the answer. The reference server does so at most once per 30 s per
   channel and otherwise refuses locally.
2. **After verify.** The server reserves the channel: one request per channel at a time; a second
   is refused `channel_busy`. A refund skips the handler.
3. **Settle.** A voucher is committed locally (`charged += amount`, never above the voucher) with
   no facilitator call. A deposit goes to facilitator `/settle`; its response gives the channel's
   `channelRef`. A refund goes to `/settle` after the server has checked the `Mutual`'s shape
   itself (the same rules as the facilitator's) and added its signature as `providerWitness`.
4. **Failure or cancellation** releases the reservation; a channel that only existed for that
   request is dropped.
5. **Retries.** A voucher equal to the channel's latest committed one, same amount and same
   signature, is a retry of that request, as a client sends it when the response never reached
   it: the server SHOULD answer with the response it gave that request, without running the
   handler or charging again (SVM's rule), and MAY bound how long it keeps it (the reference
   server: 10 minutes, in memory). Only the latest: an earlier voucher is stale and gets the
   corrective 402. A client resyncing after losing its records sends earlier amounts, and would
   otherwise be served old answers instead of the server's count.

The **corrective 402** carries, in the matching `accepts[]` entry's `extra`:
`channelState { channelId, channelRef, balance, totalClaimed, withdrawRequestedAt, chargedCumulativeAmount }`
and `voucherState { signedMaxClaimable, signature }`, with `error` =
`invalid_batch_settlement_cardano_cumulative_amount_mismatch`.

### Payment response

| Case | `transaction` | `amount` | `extra` |
|---|---|---|---|
| voucher | `""` | `""` | `chargedAmount`, `commitmentId`, `channelState` |
| deposit | the opening or top-up transaction's id | the currency amount deposited or added | `chargedAmount`, `commitmentId`, `channelState` |
| refund | the `Mutual` transaction's id | what the consumer nets, in the currency | `channelState` |

`commitmentId` is `"<channelId>:<maxClaimableAmount>"`.

## Facilitator interface

### `POST /verify`

For every payload: `accepted.scheme`, `requirements.scheme` = `batch-settlement`; same network;
`extra.scriptHash` is a validator the facilitator serves; the config matches the requirements.

**Deposit.** The facilitator MUST check that the transaction:

1. decodes, is for the requirement's network, and carries no certificates, withdrawals, minting
   or governance actions;
2. creates exactly one output at `scriptHash`, with no reference script and an inline datum whose
   `ownHash` = `scriptHash`, `tag` = `voucher.channelId`, `currency` ↔ `asset`, `iouKey` =
   `payerAuthorizer`, `consumer` = `payer`, `provider` = `receiverAuthorizer`, `closePeriod` =
   `withdrawDelay × 1000`, stage `Opened(0)`;
3. holds ADA and the currency only, exactly `deposit.amount` of the currency, and for a token
   channel at least the reserve in ADA;
4. spends an input from which `channelId` derives;
5. spends only existing, unspent inputs, each key-locked one carrying its key's witness, and every
   witness is a valid signature over the transaction id;

and that the voucher is positive, at most the capacity, and signed by `payerAuthorizer`.

**Top-up** (a deposit with `voucher.channelRef`). Following the channel from `voucher.channelRef`,
the facilitator MUST find it at stage `Opened`, with the datum bound to the config as for a
deposit, and check that the transaction:

1. decodes, is for the requirement's network, and carries no certificates, withdrawals, minting
   or governance actions;
2. spends the channel at its current position, redeemed with `Main([Add])`, and redeems no other
   input;
3. creates exactly one output at `scriptHash`, at the channel's address, with no reference script
   and an inline datum equal, as Plutus data, to the channel's (another encoder may write the same
   datum with different bytes, and the validator compares values);
4. holds ADA and the currency only, exactly `deposit.amount` more of the currency than the
   channel, and for a token channel at least the reserve in ADA;
5. is signed by `payer`, spends only existing, unspent inputs, each key-locked one carrying its
   key's witness, and every witness is a valid signature over the transaction id;
6. passes the evaluator;

and that the voucher is above `subbed`, at most the capacity after the top-up, and signed by
`payerAuthorizer`. A valid response describes the channel as it was before the top-up. On preprod
the validator itself refused an `Add` whose datum recorded a different `subbed`; rule 3 does not
rely on that.

**Voucher.** Following the channel from `voucher.channelRef`, the facilitator MUST find it at
stage `Opened`, with the datum bound to the config as for a deposit, and check `maxClaimableAmount`
≤ capacity, `maxClaimableAmount` > `subbed`, and the signature.

**Refund.** As a voucher, with `maxClaimableAmount` ≥ `subbed`, and the `Mutual` transaction MUST:
spend exactly the channel at its current position; carry the `Mutual` redeemer; list exactly the
consumer and the server as required signers; carry the consumer's witness; carry no certificates,
withdrawals, minting or governance actions; leave nothing at the validator; use collateral that is
not locked by the server's key; and pay `payTo` at least `maxClaimableAmount − subbed` of the
currency.

A valid response carries `extra` = `{ channelId, channelRef, balance, totalClaimed, withdrawRequestedAt }`.

### `POST /settle`

| `payload.type` | From | Action |
|---|---|---|
| `deposit` | client | re-verify, broadcast the exact bytes received, wait for the confirmation policy |
| `refund` | server (client-originated) | add `providerWitness`, re-verify, broadcast, wait |
| `claim` | server | check every channel input is redeemed through `Main`/`Defer` and not `Mutual`, and that `claims` lists them all; evaluate; broadcast; wait. Covers `Sub` and `Settle` alike. Without `transaction`: build and sign it with a delegated key (*Delegating the provider key*) |
| `voucher` | — | refused: vouchers settle on the server |

```ts
type ClaimPayload = { type: "claim"; transaction: string /* base64, provider-signed Sub and/or Settle */; claims: { channelId: string; totalClaimed: string }[] };
```

Claims use synthetic requirements (`amount: "0"`, `maxTimeoutSeconds: 0`, `extra: {}`).

The facilitator MUST broadcast the bytes it received, never a re-encoding, and MUST identify a
transaction by the hash of its body bytes as received. When it cannot establish confirmation
within its budget (slow blocks, a lagging index), it MUST answer `settlement_pending` with the
transaction id, and on the core's retry it MUST wait on the same transaction rather than broadcast
again. On preprod one deposit confirmed 2.5 minutes after submission.

### `GET /supported`

`kinds: [{ x402Version: 2, scheme: "batch-settlement", network }]` with no `extra`. `signers` lists
the provider keys the facilitator holds for servers (*Delegating the provider key*), and is empty
when it holds none.

### Delegating the provider key

A server MAY run without the provider key: a facilitator holds it, one key per server, registered
with that server's `payTo` and a secret the two share, and the server gives that key as
`receiverAuthorizer`, so its channels name it as `provider`. The validator does not restrict where
a redemption pays, so this is custody, not an authorisation: the server trusts the facilitator
with its revenue. (EVM's contract pays the receiver whoever authorises the claim; SVM's draft does
not delegate.)

- **Claims.** The server sends a `claim` without `transaction`; each entry adds the channel's
  `channelRef` and the `voucher` to redeem (`maxClaimableAmount`, `signature`). The facilitator
  MUST check `delegationMac`, then for each channel: that its `provider` is the key held for this
  `payTo`, its stage is not `Settled`, the voucher verifies under its `iouKey`, and
  `subbed < totalClaimed ≤ maxClaimableAmount`. It builds the claim (`Sub`, or `Settle` for a
  closed channel) with its own wallet paying fee and collateral, pays everything redeemed to
  `payTo` in one output, signs and broadcasts it. That output is subject to min-UTxO (about 0.97
  tADA, or a token's min-UTxO): a server SHOULD claim at least that much, and below it the
  facilitator's wallet tops the output up (on preprod a 0.5 tADA claim paid 0.969750). A token
  payout always needs its own ADA, which the facilitator's wallet puts up: 1.176630 tADA per
  tUSDM claim on preprod.
- **Refunds.** The server passes the `refund` on without `providerWitness`, with a
  `delegationMac`; the facilitator checks the `Mutual` as above and co-signs it.
- **`delegationMac`** = HMAC-SHA256(secret, canonical JSON of `{ payTo, payload }`), with
  `payload` the payload without this field and canonical JSON sorting every object's keys. The
  facilitator signs for a server only what carries it. Without it a consumer could have a closed
  channel settled with an early, smaller voucher (a channel settles once), or a refund co-signed
  that pays the server less than it charged.
- **Audit.** A server SHOULD check each claim on chain: that its outputs at `payTo` hold at least
  what it redeemed. The reference manager does, and fails the claim otherwise.

## Claim and settlement strategy

The server SHOULD redeem in batches, by interval or once unredeemed charges pass a threshold, and
MUST settle a closed channel before its `elapseAt`. Nothing tells the server that a consumer has
closed: it MUST watch its channels, often enough that a settle lands well inside the close
period. On seeing a close it SHOULD stop accepting the channel's vouchers (set
`withdrawRequestedAt`) and settle with the latest voucher: `Settle` in place of `Sub`, in the same
batched claim, leaving the channel `Settled` for the consumer to `End`. The reference server polls
every 15–30 s and drops a channel's record only once the channel is settled, or after two
consecutive reads find no channel, since one missing read may be a lagging index and the record
holds the only copy of the latest voucher. With many channels a server SHOULD follow the
validator's address rather than read each channel: the reference server can read every channel
once and then only the address's new transactions, and the outputs of those that spend its
channels (on preprod, 1 request a quiet pass against 20 for ten channels polled, and 3 to find a
close among them). What the server records MUST survive a rollback: its record of a channel holds
the only copy of the latest voucher. The reference server keeps, for each channel, a position at
least 3 blocks deep and reads from there forward, so a rolled-back claim leaves the charges
claimable and a rolled-back close reopens the channel; it drops a record only once the transaction
that ended the channel is that deep, and, following, acts on a transaction only once it is. On preprod, with a 15 s poll and the 900 s minimum
close period, the close was seen within 12 s and the settle landed 30–62 s after it, over 18
minutes before `elapseAt`. A settle costs what a `Sub` does.

A claim over N channels cost, on preprod:

| Channels | ADA channels (tADA) | Token channels (tADA) |
|---:|---:|---:|
| 1 | 0.256727 | 0.267227 |
| 10 | 0.571358 | 0.632372 |
| per extra channel | 0.034959 | ~0.0406 |

Size binds first: about 45 ADA channels, or 36 token channels, per transaction (extrapolated from the measured claims, not measured).

Redeemed tokens SHOULD go to `payTo` in an output of their own so the server's change stays
ADA-only, which Cardano collateral requires, and SHOULD fold earlier such outputs into it: each
holds a min-UTxO of ADA, and with one new output per claim the reference server ran out of
ADA-only UTxOs large enough for collateral, so it could build neither a claim nor a settle. A server SHOULD keep the inputs of the claims it has built out of coin selection
until its chain view drops them. A client SHOULD do the same in the transactions it builds alone:
an opening or top-up takes its tokens from UTxOs holding ADA and the currency only, folds older
ones in, and pays the rest to itself in one output, with ADA and the fee from ADA-only UTxOs; an
end folds older token outputs into the one taking the channel's tokens back. A refund cannot fold
(it spends the channel alone), so it returns one UTxO of tokens and reserve for the client's next
transaction to fold.

## Client verification rules

**Steady state.** The client moves its count only by the response's `chargedAmount`, only when
that is ≤ `amount`, and only when `channelState.chargedCumulativeAmount`, if present, equals its
previous count plus `chargedAmount`. It MAY take `channelRef` from `channelState`.

**Corrective 402.** The client adopts the server's `chargedCumulativeAmount` only when
`voucherState.signature` is its own IOU for `signedMaxClaimable`, the count is ≤
`signedMaxClaimable`, and it is ≥ `totalClaimed`.

**Top-ups.** After a successful top-up the client adds `deposit.amount` to its capacity and takes
the new `channelRef`. Before building a top-up it reads the channel: if an earlier top-up has
landed after all, it uses that capacity instead of adding more.

**Pending openings.** A client whose deposit got no confirmation MUST NOT open another channel
until it knows the first cannot land: it adopts the channel if the opening is on chain (counting
from `subbed`, as the server never counted the request), and gives it up only when one of the
opening's inputs has been spent by a different transaction.

**Recovery after state loss.** A client that has lost its records finds its channels at the
validator's address by the datum's `consumer` = its `payer` key hash, and follows each to its
current position (an address index can trail the chain). For each it derives the IOU key again;
where that matches the datum's `iouKey`, the channel is usable: the datum gives every config
field but `receiver`, which the next 402 on the channel's terms (`receiverAuthorizer`, asset,
close period, script, network) supplies, and the client binds the channel to that server. Its
count starts from `subbed`, the most the chain proves; the server's answer to the first voucher is
a corrective 402, and the client adopts the server's count only as the rules above allow, that is
only when the server holds a voucher of this very key for at least that much. A channel whose key
does not derive again can only be left: `Close`, then `End` once the server has settled, or
`Elapse` from `elapseAt` on without it. A server that has lost its records has lost what it
charged and did not redeem; the client's next voucher, being cumulative, restores its count from
there.

## Network requirements

| Requirement (generic spec) | Where |
|---|---|
| Commitment format | *IOUs*; *Client: payment construction* |
| Verification rules | *Facilitator interface*; *Server: request processing* |
| Storage behaviour | *Server: per-channel state*; the commitment identifier is `channelId:maxClaimableAmount` |
| Double-spend prevention | on chain, `subbed` only grows and no redemption passes the IOU presented; off chain, one request per channel and exact cumulative equality |
| Commitment expiry | IOUs carry none; once the consumer has closed, IOUs the server did not settle by the time the consumer's `Elapse` lands are void |
| Redemption | *Claim and settlement strategy* |
| Trust model | *Security and trust* |

## Error codes

Prefix `invalid_batch_settlement_cardano_`: `payload_type`, `payload`, `network_mismatch`,
`scheme`, `extra`, `channel_config`, `receiver_mismatch`, `receiver_authorizer_mismatch`,
`token_mismatch`, `withdraw_delay_mismatch`, `withdraw_delay_out_of_range`, `channel_not_found`,
`channel_id_mismatch`, `channel_state`, `channel_closed`, `channel_busy`, `missing_channel`,
`voucher_signature`, `cumulative_amount_mismatch` (corrective 402), `cumulative_below_claimed`,
`cumulative_exceeds_balance`, `charge_exceeds_signed_cumulative`, `deposit_transaction`,
`deposit_below_min_deposit` (a server MAY enforce `minDeposit`), `refund_transaction`,
`claim_transaction`, `transaction_failed`, `verification_state_unavailable`. And the core's
non-terminal `settlement_pending`.

## Security and trust

- **Capital-backed.** The consumer's funds are in the channel before any request is paid for.
  The response to a channel's first request waits for its deposit to confirm, so what a server
  risks is the work of handling a request whose deposit then fails; later requests need the
  channel on chain.
- **The consumer** can be charged at most the latest IOU it signed: the validator never lets a
  redemption pass it. It can always recover everything not redeemed without the server, through
  `Close` and `Elapse`.
- **The server** can redeem any IOU it holds while the channel is open, and for at least the
  close period after the consumer closes; it MUST settle before `elapseAt`.
- **The facilitator** holds no key and no funds unless a server delegates its provider key to
  it: then it holds that server's revenue in trust (*Delegating the provider key*). Otherwise it
  can broadcast only what the parties signed.
- **The server's signature** covers a whole transaction, so the server co-signs only a refund of
  exactly the shape in *Facilitator interface*, checked by itself.
- **A token channel's ADA** is protected only down to its exact min-UTxO, a margin of about 0.09
  tADA when the client deposits exactly the reserve.
- **Channel identity.** A tag derived from a spent input, with a key per channel, keeps an IOU
  from being redeemable against any channel but its own.
- **Derived IOU keys** are as secret as the wallet's signature of the root message; a client MUST
  NOT sign that message for any other party.


## Reference implementation

[loveaihq/subbit-x402](https://github.com/loveaihq/subbit-x402): `src/x402/` implements the client, resource-server and
facilitator schemes for `@x402/core` 2.27.0 and the server's channel manager, on
`@evolution-sdk/evolution` 0.5.13 and Blockfrost, with 28 chain-free tests.
[`RESULTS.md`](https://github.com/loveaihq/subbit-x402/blob/main/RESULTS.md) records every preprod transaction: steps 1–3 exercise the validator,
step 4 the ADA binding end to end, step 5 a token binding, step 6 top-ups and the automatic
settle after a consumer's close, step 7 a client that folds its token UTxOs, step 8 recovery
after state loss, step 9 retries answered from the kept response and a server whose provider key
the facilitator holds, step 10 the binding in Moneta's preprod tUSDM, step 11 the watcher
following the chain, and `elapse` and delegation on token channels, step 12 a watcher that
survives rollbacks.

## Version history

| Version | Date | Changes |
|---|---|---|
| 0.1 | 2026-09-24 | First draft, from the reference implementation and preprod runs |
| 0.2 | 2026-09-24 | Top-ups (`Add`) and their verification; the server watches its channels and settles a closed one; a voucher above the recorded balance is checked against the chain; token outputs are folded, by the server and the client |
| 0.3 | 2026-09-24 | IOU keys derived from the wallet; recovery after state loss, for the client and the server |
| 0.4 | 2026-09-25 | Retries of the latest voucher answered from the kept response; delegating the provider key to the facilitator |
| 0.5 | 2026-09-25 | Following the validator's address instead of polling each channel; token-channel exits and delegation measured |
| 0.6 | 2026-09-25 | The server's channel records survive rollbacks: a deep anchor per channel, records dropped only when their end is deep |
