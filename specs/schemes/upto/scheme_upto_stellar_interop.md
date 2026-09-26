# Stellar `upto` Scheme: Convergence and Interoperability Requirements

> **What this document is.** A convergence document derived from
> cross-implementation analysis of deployed Stellar `upto` implementations. It
> does **not** introduce a new contract design. The requirements below are
> derived from agreement across existing implementations; the open questions in
> §7 are where those implementations currently diverge.
>
> **Relationship to existing proposals.** Two Stellar `upto` specs are open at
> the time of writing — [#3134](https://github.com/x402-foundation/x402/pull/3134)
> (stateless `UptoSettlement`) and [#3098](https://github.com/x402-foundation/x402/pull/3098)
> (stateful, Periplo). This document is **additive to both**, not a competing
> third design. Where they agree, that agreement is written here as a
> requirement. Where they diverge, §7 names the divergence rather than picking a
> winner. If the TSC adopts either proposal, the requirements here should fold
> into it rather than stand alone.

## 1. Purpose

The `upto` scheme on Stellar lets a client authorize a **ceiling** on a
[SEP-41](https://stellar.org/protocol/sep-41) token transfer before the final
charge is known, and lets a facilitator settle the **actual** metered amount
afterwards, in one transaction, without the client having signed that amount.
Soroban's authorization model checks a signed invocation's arguments exactly, so
the amount cannot simply be left blank in a pre-signed `transfer`; every
implementation surveyed instead authorizes a custom argument tuple via
`require_auth_for_args` that omits the metered amount and binds everything else.
This document specifies the requirements common to those implementations, in the
terms of the five core properties defined in [`scheme_upto.md`](./scheme_upto.md).

### 1.1 Implementations surveyed

Requirements here are grounded in source read in full, not summaries. Where a
requirement rests on a single implementation, that is stated at the requirement.

| Implementation | Design | Basis for inclusion |
|---|---|---|
| [rail402](https://github.com/tolgayayci/rail402) | Stateful — nonce in `temporary()` storage | Source read at pinned commit `ff504b8`; previously deployed and settled against by the authors (see §8.1) |
| [#3134](https://github.com/x402-foundation/x402/pull/3134) (`Iam0TI`) | Stateless — SEP-41 `approve`/`transfer_from`, Soroban auth-entry nonce | Spec read in full |
| [#3098](https://github.com/x402-foundation/x402/pull/3098) (Periplo, `Eras256`) | Stateful — client-supplied `nonce: BytesN<32>` in `temporary()` with TTL | Spec and thread read in full |
| [Rialto](https://github.com/0d1026/Rialto) | Stateful, with `auto_revoke` | Source read |
| openx402 | Versioned settlement hook (`on_settled_v1`) | Source read |
| LumenGate | Escrow-and-refund | Source read; published cost benchmark (§7.4) |

## 2. Mapping the five core requirements to Stellar

| Requirement ([`scheme_upto.md`](./scheme_upto.md)) | Stellar mechanism |
|---|---|
| **Single-use authorization** | Two compliant approaches, both deployed. **Stateful:** a client-chosen `nonce` recorded in `temporary()` ledger storage and checked before any transfer. **Stateless:** the nonce Soroban itself assigns to every `SorobanAuthorizationEntry`, consumed on first successful use. Both satisfy the MUST; see §5. |
| **Time-bound validity** | An `expiration_ledger` (or `deadline`) inside the signed tuple, checked on-ledger. Stellar's own transaction `timeBounds` are **not** sufficient: they bind the envelope, not the authorization, and a facilitator chooses the envelope. |
| **Recipient binding** | The recipient (`to` / `payTo`) is inside the `require_auth_for_args` tuple. Without it a signed entry is transferable to any recipient by whoever relays it. |
| **Maximum amount enforcement** | `max_amount` is inside the signed tuple; the metered `actual_amount` is deliberately outside it and constrained on-ledger by `0 <= actual <= max` before any transfer. |
| **Phase-dependent `amount` semantics** | At verification the `PaymentRequirements.amount` is the **ceiling** and the facilitator MUST simulate against it. At settlement it is the **actual** charge. The facilitator MUST re-verify the client's signature against the signed ceiling, never against the settlement-time amount. |

Restating the base spec's rule in Stellar terms, because it is the one that is
easy to get wrong: **the facilitator MUST verify against the client-signed
ceiling, never against the settlement-time `amount`.** The settlement-time amount
is server-supplied; the ceiling is the only value the client actually signed.

## 3. Authorization requirements (MUST)

### 3.1 The signed tuple

`require_auth_for_args` MUST cover at minimum:

```
(to, asset, max_amount, expiration_ledger)
```

Every implementation surveyed binds at least these four, plus a nonce or salt.
The rationale is per-field and each omission is a distinct, real failure:

- **`to`** — without it, a signed authorization is *transferable*: anyone who
  relays it can redirect the funds to a recipient the client never agreed to.
- **`asset`** — without it, an entry signed for one SEP-41 token could authorize
  a different one. The client signed an amount, not a value.
- **`max_amount`** — without it the ceiling is unenforceable on-ledger, and
  `upto` degrades to an unbounded allowance.
- **`expiration_ledger`** — without it the authorization never expires, leaving
  standing authority the client cannot withdraw.

### 3.2 `actual_amount` MUST be excluded from the signed tuple

The metered amount MUST NOT appear in the signed tuple — that exclusion is what
makes the scheme possible at all — and MUST be bounded on-ledger by
`0 <= actual_amount <= max_amount`, checked **before** any token movement and
before any nonce is consumed, so that a rejected authorization is not silently
burned.

### 3.3 Off-chain observers MUST read the settled amount from the token's own `transfer` event

This requirement is about **indexers, explorers and any off-chain consumer**
reporting what an `upto` settlement moved. It is *not* a constraint on the
settlement contract, which necessarily receives `actual_amount` as a call
argument and enforces the ceiling against it on-ledger.

An `upto` settlement invokes `settle(...)` on a settlement contract; the token
movement happens as a **nested sub-invocation**, not as a top-level `transfer` on
the token contract. An observer whose heuristic recognizes only the top-level
`transfer(from, to, amount)` shape — the `exact`-scheme shape — will not see an
`upto` settlement at all. An observer that instead reads the amount from the
envelope's call arguments is reading a facilitator-supplied value.

Neither the signed ceiling nor the facilitator-supplied argument is ground truth
for what the chain actually moved. **The token's own emitted `transfer` event
is.** This was found by root-causing a real classifier gap in a deployed
explorer, which was reporting `upto` settlements as unattributed; the fix was to
recognize the settlement-contract invocation by shape and read the amount from
the emitted event. The settlements in §8 and §8.1 postdate that fix and are its
verification.

## 4. Hook failure isolation (SHOULD)

Several implementations support an optional settlement hook — a contract the
settlement calls after transfer so a seller can reconcile. rail402 takes it as an
optional 8th argument, deliberately outside the signed tuple; openx402 defines a
versioned `on_settled_v1` entry point gated by invoker authorization plus
inclusion of the hook address in the client's signed payload.

Leaving the hook outside the signed tuple is defensible: a misdirected hook can
only fail to reconcile, never overcharge, because the transfer's bounds are
enforced independently. That reasoning covers misdirection. It does not cover
**failure**.

Soroban cross-contract calls fail synchronously by default. If `settle()` invokes
a hook without isolating it, a hook address that traps — pointing at a broken,
adversarial, or merely upgraded-and-now-incompatible contract — propagates that
trap through the entire transaction. The settlement itself fails. Because the
hook is not signed, the address may be chosen by a party other than the client,
which makes this a denial-of-service surface on settlement rather than a
reconciliation nuisance.

Implementations **SHOULD** isolate hook invocation (try-call or equivalent) so a
failing hook degrades to *unreconciled* rather than *settlement failed*.

> **Confidence: inferred, not reproduced.** This follows from Soroban's
> documented trap-propagation behaviour. It has **not** been reproduced against
> any referenced implementation, including our own deployment. It is recorded as
> SHOULD rather than MUST for exactly that reason. An implementer who reproduces
> or refutes it should report it — refutation is as useful here as confirmation,
> and this requirement should be revisited either way.

## 5. Replay protection

Both approaches below are deployed and both satisfy the single-use MUST. This
document does not rank them.

### 5.1 Stateful — nonce in temporary storage

A client-chosen nonce is recorded in `temporary()` ledger storage and checked
before any transfer. Because a temporary entry expires, the record must outlive
the authorization that created it, or the single-use guarantee lapses silently:
an authorization signed for longer than the nonce record's lifetime could be
replayed after the record expired.

Implementations taking this approach MUST bound the authorization to the record's
lifetime. Concretely, with a nonce TTL of `NONCE_TTL_LEDGERS`:

```
expiration_ledger <= current_ledger + NONCE_TTL_LEDGERS
```

rail402 sets `NONCE_TTL_LEDGERS = 17_280` (~24h at 5s ledgers) and rejects any
`expiration_ledger` beyond that window. Periplo (#3098) derives its nonce
lifetime from `deadline_ledger` to prevent the same class structurally rather
than by a fixed ceiling. Both are compliant; the failure they prevent is the same
one.

### 5.2 Stateless — Soroban auth-entry nonce

Every `SorobanAuthorizationEntry` carries a nonce assigned at signing time and
consumed on first successful use. An implementation may rely on this
protocol-level behaviour and store nothing itself (#3134). Note that Stellar
permits exactly one `invokeHostFunction` operation per transaction, so a signed
authorization can be consumed by exactly one `settle` call.

### 5.3 Requirement

Implementations MUST implement one of these and **MUST document which**. A client
or facilitator cannot infer the replay model from the wire format, and the
operational consequences differ: the stateful approach imposes a maximum
authorization lifetime, the stateless one does not.

## 6. Auto-revoke interoperability

When `actual_amount < max_amount`, an allowance-based implementation leaves a
residual allowance. Implementations diverge on what happens to it:

| Behaviour | Implementations | Consequence |
|---|---|---|
| Revoke automatically after settlement | Rialto (`auto_revoke`), #3134 with `autoRevoke = true` | No residual authority survives the settlement |
| Leave the residual until expiry | rail402 (residual "deliberately NOT reset"), #3134 with `autoRevoke = false` | Residual persists until `expiration_ledger`; not drawable without a new valid authorization, but visible on-chain as standing authority |

Both are defensible. The interoperability gap is not the behaviour, it is that
**the client cannot tell which one it is dealing with**. A wallet UI that assumes
auto-revoke will show a pending authorization as cancelled when it is not, and a
client that assumes no revocation may re-derive an allowance that no longer
exists.

Implementations MUST document their auto-revoke behaviour. Where the behaviour is
client-selectable, the selection MUST be inside the signed tuple — a
facilitator-chosen revocation flag is a facilitator-chosen change to the client's
residual authority.

A future revision SHOULD standardize this; see §7.1.

## 7. Open questions for the TSC

These are genuine divergences, not editorial gaps. This document does not resolve
them.

### 7.1 Should auto-revoke be normative?

Standardizing removes the §6 interop gap. Against: revocation costs an extra
sub-invocation, and the residual is not drawable without a fresh authorization,
so the argument for mandating it is UI legibility rather than fund safety.

### 7.2 Which replay-protection approach should be normative, if either?

Stateless is cheaper and simpler. Stateful supports capabilities the stateless
design cannot — `cancel` and `is_settled` require a stored record. Mandating
either forecloses something real.

### 7.3 Should hook failure isolation be MUST rather than SHOULD?

It is SHOULD here only because the trap-propagation DoS in §4 is inferred rather
than reproduced. If an implementer reproduces it, MUST is the right level. This
question should not be resolved by argument.

### 7.4 What is the correct custody-window cost model for fee estimation?

The community consensus is custody-avoidance — a settlement contract should not
hold funds it does not need to. The only two measurements the authors are aware
of both cut against the assumption that this is also the cheaper choice:

- **LumenGate** benchmarked allowance-based against escrow-and-refund via
  `simulateTransaction` on two deployed testnet contracts at a fixed scenario
  (max 1,000,000 / actual 400,000 / feeBps 500): **234,098 stroops** for
  allowance-based versus **160,366** for escrow — escrow **31.5% cheaper**. Their
  own write-up discloses the trade: escrow's advantage comes partly from not
  persisting a nonce record, which gives up `cancel`/`is_settled`.
- A reviewer on **#3134** settled real transactions from both that PR's stateless
  design and #3098's stateful design and compared `fee_charged` against Horizon:
  **32,731 / 30,585** stroops versus **42,872** — the stateless design 25–30%
  cheaper.

Different axes — custody, and statefulness — landing on a similar shape: the
design the community leans toward on trust and simplicity grounds is not the
cheapest one measured so far. **Both measurements are other teams' work and are
cited here, not claimed.** Neither has been independently reproduced. Two data
points from two teams is signal, not a cost model. The question for the TSC is
whether the spec should say anything about fee expectations at all, and if so, on
what evidence.

### 7.5 Profile disambiguation

Raised by @HeylmStoned and developed by @Eras256 on 2026-08-26 in the #3134
thread: once both stateless (#3134) and stateful (#3098) Stellar `upto` profiles
exist, `scheme: "upto"` alone in `/supported` does not distinguish which profile
a facilitator implements. A client that supports only one profile cannot know
whether to attempt payment without additional signaling.

**The gap.** No stable profile identifier exists in the `extra` object of
`/supported` that would let a client select between profiles.

**Proposed resolution, not yet standardized.** Each profile declares a stable
`profile` field in `extra`, for example `"profile": "stateless-v1"` or
`"profile": "stateful-v1"`, reflected in `/supported` alongside
`areFeesSponsored` and `uptoContract`. Clients filter payment options by
supported profile before attempting settlement.

This is arguably the most consequential open question here for interoperability,
because it is the one that fails *silently*. A client attempting a stateless
payment against a stateful facilitator, or the reverse, may receive a cryptic
error rather than a clear rejection, and neither side learns that a profile
mismatch was the cause. Every other divergence in this section produces a
difference in behaviour that an implementer can observe and reason about; this
one produces an error that misdirects.

@Eras256 notes it is tracked in Periplo's own `DEFERRED.md`, so at least one
implementation has already recorded it as unresolved.

*Credit: @HeylmStoned identified the gap; @Eras256 developed the analysis. This
section was added after our own comment on #3134 acknowledged its absence from
an earlier draft.*

## 8. Deployed reference

The authors operate a deployed `upto` settlement contract on Stellar testnet.
It is their own implementation, MIT licensed, written from the `upto` scheme
description and from the requirements in this document. The design brief was
committed at **2026-09-09T12:30Z**, before the first line of implementation at
**13:02Z**, so the ordering is checkable in that repository's history rather
than asserted.

Source: [`contracts/upto-vellar/`](https://github.com/Vellar-Wallet/vellar-facilitator/tree/main/contracts/upto-vellar)
in `Vellar-Wallet/vellar-facilitator`.

| | |
|---|---|
| Network | `stellar:testnet` |
| Contract ID | `CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN` |
| Wasm hash | `92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8` |
| Licence | MIT |
| Toolchain | rustc/cargo 1.96.0, `stellar` CLI 26.1.0, target `wasm32v1-none`, soroban-sdk 23 |

The on-chain wasm hash is the sha256 of the wasm, so the chain is verifiable by
anyone. All three of the build artifact, the fetched artifact and the hash above
MUST agree. (Reproducing the hash requires the same toolchain versions; a
different rustc can produce a byte-different, still-correct wasm.)

```bash
# 1. Build from source
cd contracts/upto-vellar
stellar contract build
shasum -a 256 target/wasm32v1-none/release/x402_upto_vellar.wasm
# expect 92365d9e5effe046a1db5b959bd2357672aef3f4b2137653c8095a0764d1f6c8

# 2. Verify against the deployed bytes
stellar contract fetch \
  --id CCZL7CTRS6GWEYXDYD54DZM3OUHQW2S2A4KSU75SH275P3SFZLL4YQAN \
  --network testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015" \
  --out-file fetched.wasm
shasum -a 256 fetched.wasm
# must match the hash above

# 3. Verify the first settlement
curl -s "https://horizon-testnet.stellar.org/transactions/be33bb71b0a2c74c465bf0243c45e081bc7c5b66a337e2d8a5c0bbb82f54ede6" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('successful:', d['successful']); print('ledger:', d['ledger'])"
# successful: True
# ledger: 4587956
```

First settlement, Horizon-confirmed, settling strictly below its authorized
ceiling:

| Tx | Ledger | Ceiling → actual (USDC) |
|---|---|---|
| [`be33bb71…ede6`](https://stellar.expert/explorer/testnet/tx/be33bb71b0a2c74c465bf0243c45e081bc7c5b66a337e2d8a5c0bbb82f54ede6) | 4587956 | 0.05 → 0.01 |

The transfer moved exactly the metered actual and not the ceiling, which is the
property `upto` exists for and the one §3.3 says an observer must read from the
token's own emitted event rather than from the envelope arguments.

### 8.1 The previous deployed reference

An earlier revision of this document cited a different deployed contract,
`CDHPA64M73TUTEM4MMHIWIXINBQXH7JJXFGZMGH22VJWFJFROMR6QV2S`, and four settlements
through it (`72c816a6…`, `be728773…`, `f558307e…`, `12f0fa5c…`). The authors had
deployed their own build of an existing Apache-2.0 implementation — the same one
cited at §1.1, §5.1 and §6 — and what they contributed was verification of it,
not its design.

Those four transactions remain valid and inspectable on the public ledger. **The
reproducible-build steps for them no longer work**, because that contract's
source is not present in any repository the authors control. They are therefore
no longer offered here as verifiable evidence; §8 above is. The requirements in
§5.1 and §6 that cite that implementation's specific parameters were derived
from reading its source and are unaffected.

## 9. Known limitations of the reference deployment

Stated because a spec whose reference deployment has unstated limits is worth
less than one that names them.

- **Concurrent `upto` settlements can fail with `txBadSeq`.** The reference
  facilitator routes `exact`-scheme settlements through a pool of channel
  accounts so concurrent settlements do not contend for one sequence number.
  `upto` settlement does **not** use that pool — it uses the sponsor account's
  sequence directly. Concurrent `upto` settlements therefore contend, and can
  fail with `txBadSeq`. This is an integration limitation of that facilitator,
  not of the scheme or the contract, and it means the reference deployment should
  not be treated as evidence for `upto` throughput under concurrency.
- **The wire format is not settled.** This document specifies authorization and
  interop requirements, not a wire format. #3134 and #3098 both propose one and
  they differ. Nothing here should be read as endorsing either.
- **Testnet only.** No pubnet deployment exists, and no pubnet settlement is
  claimed.

## 10. Out of scope

As in [`scheme_upto.md`](./scheme_upto.md): multi-settlement and streaming,
recurring payments, and open-ended allowances are not supported by `upto` and
would require different schemes. This document additionally does not specify a
wire format (§9), does not propose a contract design, and does not resolve the
questions in §7.
