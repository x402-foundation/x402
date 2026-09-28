# Scheme: `exact` on Bitcoin Cash

## Summary

This scheme transfers an exact amount of native Bitcoin Cash (BCH) from a
client-controlled UTXO set to the `payTo` P2PKH output. The client constructs
and signs the complete transaction; the facilitator only verifies and relays
that transaction. The initial version supports x402 v2 and the `upfront`
payment flow only.

This document defines the wire and validation contract shared by the
TypeScript and Rust BCH mechanisms. CashTokens, CashScript, PSBT, sponsorship,
non-P2PKH scripts, batch settlement, and alternate address encodings are
outside this scheme.

## Networks and requirements

The supported network identifiers are:

- `bch:bitcoincash` for BCH mainnet
- `bch:bchtest` for BCH Chipnet

`payTo` MUST be a fully prefixed, lowercase CashAddr P2PKH address whose
prefix matches `network`. `asset` MUST be `BCH`. `amount` MUST be a canonical
unsigned decimal string representing satoshis: `0` or a non-zero digit
followed by digits, with no sign, decimal point, exponent, or leading zeroes.
The value MUST fit an unsigned 64-bit integer and MUST satisfy the configured
dust policy.

The BCH requirements MUST include:

```json
{
  "scheme": "exact",
  "network": "bch:bitcoincash",
  "amount": "1000",
  "asset": "BCH",
  "payTo": "bitcoincash:...",
  "maxTimeoutSeconds": 300,
  "extra": {
    "assetTransferMethod": "native",
    "paymentFlow": "upfront"
  }
}
```

`maxTimeoutSeconds` is an off-chain request acceptance window. It is not a
BCH transaction expiry and MUST NOT be interpreted as one.

## Payment payload

`payload.transaction` MUST be standard padded RFC 4648 Base64 containing the
complete legacy BCH transaction serialization. The transaction MUST use:

- version 1 or 2;
- at least one and at most the configured number of inputs;
- locktime `0`;
- standard P2PKH inputs with valid ECDSA signatures;
- BCH sighash type `0x41` (`SIGHASH_ALL | SIGHASH_FORKID`);
- exactly one output paying `payTo` for exactly `amount`; and
- zero or one additional non-dust standard P2PKH change output.

Every input's authoritative source output MUST be resolved by the facilitator.
Client-provided source values and scripts MUST NOT be trusted. Every input
must belong to the same payer public-key hash. The transaction MUST conserve
BCH value, and its fee MUST meet the configured minimum fee rate based on the
complete serialized transaction size.

CashToken-bearing source outputs, inputs, or outputs MUST be rejected.

## Verification and settlement

For `upfront`, the resource server MUST establish settlement before invoking
the protected resource handler. The facilitator MUST verify the requirements,
decode and validate the transaction, resolve authoritative source outputs,
verify every signature, and verify the exact merchant output before broadcast.

The facilitator MUST claim the transaction ID atomically against a stable
request binding formed from the accepted requirements and payment resource.
A transaction already claimed for a different binding MUST be rejected. A
retry for the same binding MUST reconcile the existing transaction by TXID and
MUST NOT broadcast it again. The claim MUST remain until settlement is
accepted or the transaction is known to be terminally rejected.

Settlement acceptance is policy-driven:

- `confirmations(n)` requires at least `n` confirmations;
- `mempool` accepts mempool or confirmed status; or
- `noDoubleSpendProof` accepts mempool status only while no verified BCH
  double-spend proof exists.

The default MUST be `confirmations(1)`. A reachable but not-yet-accepted
transaction MUST return `settlement_pending:<txid>` and MUST not be treated as
successful payment. Provider transport errors MUST remain indeterminate and
MUST NOT be interpreted as either spendability or successful settlement.

## Provider boundary

Client providers supply UTXO discovery and signer-side source data. Facilitator
providers supply authoritative source outputs, spend/conflict status, raw
broadcast, transaction status, tip height, and double-spend-proof evidence.
Availability failover does not prove chain consistency; deployments SHOULD
compare independent chain-tip/header observations and use authenticated or
otherwise reviewed transports.
