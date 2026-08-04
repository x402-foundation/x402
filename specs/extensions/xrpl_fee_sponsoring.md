# Extension: `xrplFeeSponsoring`

## Summary

The `xrplFeeSponsoring` extension enables facilitator-sponsored network fees
for the [`scheme_exact_xrpl.md`](../schemes/exact/scheme_exact_xrpl.md) scheme
using XLS-68 (`Sponsor` amendment): the payer signs a `Payment` carrying
`Sponsor` and `SponsorFlags` fields, and the facilitator — not the payer —
pays the XRPL transaction fee.

When this extension is active, `extra.areFeesSponsored` is `true` and the
base scheme's statement that fee sponsorship "would require a different
payment model" is satisfied: XLS-68 is that payment model.

The extension only applies on networks where the `Sponsor` amendment is
enabled (currently Devnet; not Mainnet).

## Prerequisites

- `Sponsor` amendment (`BE1F90581635DBCEBFC4678C4B54FEDDC1A17B50FD02CFE765A4132A342126AC`)
  enabled on the target network. The facilitator MUST verify this against the
  `Amendments` ledger object, not static configuration.
- Two operating modes:
  - `"cosigned"` — the facilitator co-signs each transaction
    (`SponsorSignature`). No ledger setup required.
  - `"prefunded"` — a `Sponsorship` ledger object (sponsor = facilitator's
    account, sponsee = payer) authorizes fee payment with no per-transaction
    facilitator signature. Bounded by the object's `FeeAmount` pool and
    per-transaction `MaxFee`.

## `PaymentRequired`

A facilitator advertises support by including the `xrplFeeSponsoring` key in
the `extensions` object of the `402 Payment Required` response.

```json
{
  "x402Version": 2,
  "accepts": [
    {
      "scheme": "exact",
      "network": "xrpl:2",
      "asset": "524C555344000000000000000000000000000000",
      "payTo": "rN7n3473SaZBCG4dFL83w7a1RXtXtbk2D9",
      "amount": "2.5",
      "maxTimeoutSeconds": 600,
      "extra": {
        "areFeesSponsored": true,
        "issuer": "rMwjYedjc7qqtKYVLiAccJSmCwih4LnE2q"
      }
    }
  ],
  "extensions": {
    "xrplFeeSponsoring": {
      "info": {
        "description": "The facilitator sponsors XRPL network fees via XLS-68.",
        "version": "1",
        "sponsor": "rSponsor1VktvzBz8JF2oJC6qaww6RZ7Lw",
        "mode": "cosigned",
        "maxFee": "1000"
      }
    }
  }
}
```

| Field           | Type   | Required | Description                                        |
| --------------- | ------ | -------- | -------------------------------------------------- |
| `info.sponsor`  | string | Yes      | Classic address that pays the fee                  |
| `info.mode`     | string | Yes      | `"cosigned"` or `"prefunded"`                      |
| `info.maxFee`   | string | Yes      | Maximum sponsored `Fee` in drops, per transaction  |

## `PaymentPayload`

The client builds the full transaction — including `Sponsor = info.sponsor`,
`SponsorFlags = 1` (`spfSponsorFee`), its own `SigningPubKey`, `Fee <=
info.maxFee`, and sequencing per the base scheme — signs it, and sends the
blob as in the base scheme.

- `"prefunded"`: the signed blob is complete and submittable as-is.
- `"cosigned"`: the facilitator computes `SponsorSignature` over the same
  signing payload during settlement and inserts it before submission.
  `SponsorSignature` is a non-signing field, so adding it does not invalidate
  the payer's signature — and the facilitator cannot alter any other field
  without invalidating it.

## Verification Logic

All base-scheme verification rules apply, with these deltas:

- `extra.areFeesSponsored` MUST be `true` (envelope check §1 inverted).
- `tx_json.Sponsor` MUST equal `info.sponsor`.
- `tx_json.SponsorFlags` MUST equal `1` (`spfSponsorFee`). A facilitator MUST
  reject `spfSponsorReserve` unless it has an explicit reserve-sponsorship
  policy: reserve sponsorship locks the sponsor's XRP per created object.
- `tx_json.Fee` MUST be `<= info.maxFee` (tightens safety check §9's "Fee
  above facilitator policy").
- `"prefunded"` mode: the `Sponsorship` ledger object for
  `(info.sponsor, tx_json.Account)` MUST exist with `FeeAmount >= tx_json.Fee`;
  `tx_json.SponsorSignature` MUST be absent.
- `"cosigned"` mode: `tx_json.SponsorSignature` MUST be absent at `/verify`
  (the facilitator adds it); the facilitator MUST co-sign only transactions
  that passed every verification rule — the sponsor signature is an
  endorsement of exactly these payment terms.
- The `Sponsor` amendment MUST be enabled on the target network.
- Simulation (§11) MUST account for the fee being charged to the sponsor:
  the payer needs no XRP balance for the fee.

## Settlement Logic

Base-scheme settlement applies unchanged, plus:

- A rejection of `terNO_PERMISSION` for a `"prefunded"` payment whose
  `Sponsorship` object does not yet exist is **pending, not dead**: `ter`
  results are retriable, and the transaction applies automatically once the
  sponsorship is funded. A facilitator MUST NOT create or fund a
  `Sponsorship` object while such a transaction may still be live (its
  `LastLedgerSequence` has not passed) unless it intends that payment to
  settle.
- The settlement response SHOULD include `feeSponsored: true` and the sponsor
  address, so clients can attribute network costs.

## Security Considerations

- **Mutual binding.** Sponsor and payer sign the identical
  `STX\0`-prefixed signing payload (XLS-68; rippled `STTx::checkSingleSign`).
  Neither party can alter amount, destination, fee, or sequence after the
  other signs; sponsor signatures cannot be replayed on other transactions
  because `Account` and `Sequence` are signed.
- **Fee drain is the abuse model.** Per-transaction exposure is bounded by
  `info.maxFee` (and on-ledger by `Sponsorship.MaxFee` in prefunded mode);
  total prefunded exposure is bounded by `FeeAmount`. Cosigned mode is
  bounded by facilitator policy. Facilitators SHOULD rate-limit sponsorship
  per payer account.
- **Account-creation sponsorship is out of scope** for this extension.
  `tfSponsorCreatedAccount` onboarding (1 XRP reserve per account) is
  unbounded sponsor cost and MUST be gated separately if offered.

## Reference Implementation

End-to-end Devnet proof (all modes; negative controls including
tamper-after-sign, sponsor-signature replay, and MaxFee fee-drain rejection),
with a validated-run evidence file:
https://github.com/whawk46/xls68-x402-fee-sponsoring

## Implementation-vs-draft note (for the XLS-68 author)

Observed on Devnet (rippled `3.3.0-rc5`), diverging from the XLS-68 draft
text: `SponsorshipSet` is transaction type 91 and accepts additive
`FeeAmountDelta` rather than absolute `FeeAmount`/`ReserveCount` (which are
rejected by the transaction template); creating a budget-less `Sponsorship`
fails with `tecNO_PERMISSION`. Implementers should code against
`server_definitions` of the target network, not the draft field tables.
