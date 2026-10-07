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

## Compatibility boundary and known functional gaps

This mechanism is intentionally not an account-model translation. The x402
core contract describes a payment requirement and a settlement result, while
BCH settlement is a UTXO state transition with different operational
invariants:

- A payer does not have a balance to debit. The client selects specific UTXOs,
  and the facilitator must resolve each outpoint's authoritative value and
  locking script before accepting the payment.
- A valid signed transaction is not proof that it was accepted by the network.
  The facilitator must distinguish build, signature verification, broadcast,
  mempool observation, confirmation, and finality. A lost broadcast response
  is indeterminate and requires TXID reconciliation.
- Idempotency is transaction-based. The TXID claim and request binding prevent
  duplicate broadcast and prevent the same transaction from being reused for a
  different resource or price requirement. A process-local settlement store is
  suitable only for a single process; multi-process deployments need a shared
  atomic store.
- BCH fee and change selection are client responsibilities. A facilitator
  cannot infer a missing fee from an account balance, and a change output is a
  separate UTXO subject to dust and payer-ownership rules.
- Confirmation depth, mempool policy, double-spend-proof availability, chain
  reorganizations, and provider tip consistency have no direct equivalent in
  the usual account-model adapter. They remain provider and deployment policy,
  not x402 core semantics.
- The initial package does not cover CashTokens, covenant/CashScript payments,
  multisig, PSBT transport, sponsored transactions, non-P2PKH scripts,
  batch payments, or debit/streaming settlement. Adding any of these requires
  a separate wire contract and validation model rather than widening this
  P2PKH exact scheme implicitly.

The package uses `@bitauth/libauth` for BCH transaction encoding/decoding,
CashAddr validation, hashing, BCH signing serialization, and secp256k1
operations. The x402-specific layer remains responsible for requirements,
source-output policy, payer consistency, fee/change policy, provider evidence,
and settlement idempotency.

### x402 field and flow mapping

| x402 concept | BCH binding | Compatibility consequence |
| --- | --- | --- |
| `network` | `bch:bitcoincash` or `bch:bchtest` | These are the only supported networks; address prefixes and provider endpoints must agree with the selected value. |
| `asset` | `BCH` | Native BCH only; there is no token-contract or token-account interpretation. |
| `amount` | Canonical decimal satoshis | The amount is exact and integer-valued. Human BCH decimals require conversion before producing x402 requirements. |
| `payTo` | Fully prefixed CashAddr P2PKH | The address becomes a locking script. The facilitator must compare the script, not a display-form address. |
| `payload` | Complete signed raw transaction in Base64 | The client authorizes a transaction state transition, not a reusable allowance or signature over an abstract transfer. |
| `extra.paymentFlow` | `upfront` only | Settlement must be established before the protected resource executes. The default x402 `authorization` flow is not supported by this mechanism. |
| `extra.assetTransferMethod` | `native` only | No ERC-20-style transfer method, token account, or facilitator signer is involved. |
| `verify` | Read-only transaction/source validation | Verification checks current outpoint state and may become stale before broadcast. It is not a reservation. |
| `settle` | Claim TXID, broadcast, observe evidence | The facilitator may submit a client-signed transaction but cannot repair, top up, or replace it without a new client authorization. |
| `transaction` in `SettleResponse` | BCH TXID | A successful response identifies the transaction; a pending response must be reconciled rather than blindly retried. |
| `payer` | P2PKH CashAddr derived from the signing public key | A single transaction with inputs from multiple payer keys is rejected. |

### Functional support matrix

| Capability | Status | Current behavior / gap |
| --- | --- | --- |
| x402 v2 HTTP/core payloads | Supported | Uses `PaymentPayload`, `PaymentRequirements`, `VerifyResponse`, and `SettleResponse`. |
| x402 v1 | Unsupported | No v1 `X-PAYMENT`/`maxAmount` compatibility layer is implemented. |
| `exact` scheme | Supported, BCH-specific | Exact native BCH amount is paid in one transaction. |
| `upto` | Unsupported | There is no BCH allowance, ceiling authorization, or later amount selection. |
| `batch-settlement` | Unsupported | Each payment is a separate transaction; there is no batch proof or batch facilitator state. |
| `authorization` flow | Unsupported | BCH exact is `upfront`; the resource must not run merely because a transaction signature verifies. |
| `upfront` flow | Supported | Facilitator settlement runs before resource execution. Confirmation policy determines when it returns success. |
| `escrow` flow | Unsupported | No deposit, post-resource final charge, refund, or escrow successor state exists. |
| Native BCH | Supported | `asset: BCH`, satoshi amounts, P2PKH outputs. |
| CashTokens | Unsupported | Token prefixes are rejected by the P2PKH-only policy; token category/amount/capability semantics are not in the wire contract. |
| P2PKH | Supported | Client and facilitator validate BCH `SIGHASH_ALL | SIGHASH_FORKID` ECDSA spends. |
| P2SH, P2WSH, CashScript/covenants, multisig | Unsupported | No script template, signer set, covenant successor, or script VM policy is defined. |
| PSBT or partially signed transport | Unsupported | The payload must contain a complete legacy raw transaction. |
| Fee sponsorship | Unsupported | The payer supplies all inputs and pays the fee; there is no facilitator fee input or sponsor authorization. |
| Multiple inputs | Supported with restrictions | Inputs are allowed up to policy limits, but every input must resolve to the same payer key and every source must be unspent at verification. |
| Change | Supported with restrictions | At most one non-dust P2PKH change output is allowed and it must return to the payer. |
| Confirmation settlement | Supported | Configurable confirmation count; default is one confirmation. |
| Mempool settlement | Supported as opt-in | Accepts mempool/confirmed observation without waiting for a confirmation. This is weaker finality. |
| Double-spend-proof settlement | Supported as opt-in | Requires provider support for proof observation; absence of a proof is not confirmation. |
| Reorg/finality guarantees | Deployment-dependent | The provider strategy and confirmation depth define the acceptance threshold; x402 does not provide a universal finality guarantee. |

### UTXO-specific safety obligations

The account-model schemes can often verify an authorization and then have a
contract enforce nonce, balance, recipient, and amount atomically. BCH exact
does not have that shared account state. The following are therefore separate
obligations:

1. Resolve every input outpoint's value and locking script from an authoritative
   provider. A client-supplied source value is only a hint and MUST NOT be used
   for settlement verification.
2. Check that each source outpoint is currently unspent, while treating that
   observation as a race-prone preflight rather than a reservation.
3. Verify each input's script, public-key ownership, BCH signing serialization,
   and source value independently. A valid signature on one input does not
   authorize another input.
4. Enforce conservation: source value equals merchant output plus change plus
   fee. Fee policy is part of validation because BCH has no contract call that
   separately records the intended fee.
5. Enforce payer-owned change. Sending the remainder to an arbitrary P2PKH
   address would turn a payment into an unreviewed multi-recipient transfer.
6. Claim the TXID against the x402 resource and requirements before broadcast.
   This is an application-level idempotency guard; it does not reserve the
   inputs on the BCH network.
7. Reconcile uncertain broadcast outcomes by TXID. A transport timeout or a
   lost response is not evidence that the transaction was not accepted.

### Remaining implementation gaps

The current implementation deliberately leaves these gaps for follow-up work:

- `maxTimeoutSeconds` is carried as an x402 requirement but is not currently
  enforced against a client timestamp, because the BCH payload has no signed
  creation/expiry field. It is therefore an application acceptance window,
  not a transaction validity rule.
- A process-local `BchSettlementStore` prevents duplicate work only within one
  process. Production multi-instance facilitators need a durable shared claim
  store with atomic compare-and-set and recovery of claims left pending by a
  crash.
- Provider responses are transport trust boundaries. Failover improves
  availability but does not prove that endpoints agree on chain tip, source
  output, mempool state, or double-spend evidence.
- There is no proof-carrying settlement receipt, merkle inclusion proof, or
  reorg monitor in the scheme. Consumers needing stronger finality must add
  provider-specific monitoring and choose confirmation policy accordingly.
- The client UTXO selector is intentionally simple and does not provide coin
  selection privacy, fee bumping, replace-by-fee policy, consolidation policy,
  or robust concurrent-wallet reservation. Applications must prevent two
  concurrent clients from selecting the same UTXO set.
- The shared fixture covers one-input P2PKH interoperability. Multi-input,
  malformed-source, change-ownership, mempool-race, reorg, and provider
  disagreement scenarios need broader cross-language vectors before claiming
  production maturity.
