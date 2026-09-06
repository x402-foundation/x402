# Scheme: `exact` on `BSV`

## Summary

In the `exact` scheme on BSV (Bitcoin SV), the Client's BRC-100 wallet builds a fully-signed, fully-funded native-satoshi transaction paying a single P2PKH output locked to a key derived from the recipient's identity public key. The Facilitator — operated by or for the recipient, holding the recipient's wallet — verifies the payment and takes custody of the output by internalizing it into that wallet. The Client pays the miner fee; there is no gas sponsorship.

The mechanism is the [BRC-29](https://bsv.brc.dev/payments/0029) payment protocol as profiled by [BRC-121: Simple 402 Payments](https://bsv.brc.dev/payments/0121). The payment output is locked to a per-payment child key derived via [BRC-42](https://bsv.brc.dev/key-derivation/0042) from the recipient's identity key (`payTo`), a random derivation prefix, and a timestamp-encoding derivation suffix. The transaction travels in [BEEF](https://bsv.brc.dev/transactions/0062) / [Atomic BEEF](https://bsv.brc.dev/transactions/0095) format, carrying its own SPV ancestry, so the recipient's wallet can validate it without a node round trip.

**Facilitator trust model (differs from account-based chains):** BRC-42 derivation uses an ECDH shared secret between the payer and the recipient, so by default only those two parties can link the payment output to the recipient's identity key. A third party cannot take custody, and cannot verify the destination unilaterally — either counterparty can, however, voluntarily disclose a verifiable key linkage (see [Key Linkage Revelation](#key-linkage-revelation-and-auditability)). The facilitator role for this scheme is therefore fulfilled by the recipient's own BRC-100 wallet — run in-process by the resource server or self-hosted as a facilitator service. `verify` performs structural and freshness checks; `settle` is atomic verification-plus-acceptance via the wallet's `internalizeAction`, which SPV-validates the BEEF, checks the BRC-42 derivation, takes custody, and detects replays.

**Version Support:** This specification supports x402 v2 protocol only.

## `PAYMENT-SIGNATURE` Header Payload

The `payload` field must contain:

- `transaction`: Base64-encoded BEEF (BRC-62) or Atomic BEEF (BRC-95) transaction, fully signed and funded by the Client, including SPV ancestry.
- `derivationPrefix`: Base64-encoded BRC-29 payment-wide derivation prefix (a fresh random nonce, minimum 8 bytes).
- `derivationSuffix`: Base64-encoded BRC-29 derivation suffix. The decoded value MUST be the decimal Unix timestamp in milliseconds at which the Client constructed the payment.
- `senderIdentityKey`: The Client's identity public key (33-byte compressed secp256k1, hex).
- `outputIndex`: Zero-based index of the payment output within the transaction.

**Example `PaymentPayload`:**

```json
{
  "x402Version": 2,
  "resource": {
    "url": "http://api.example.com/weather?city=San%20Francisco"
  },
  "accepted": {
    "scheme": "exact",
    "network": "bsv:mainnet",
    "asset": "BSV",
    "amount": "1000",
    "payTo": "03f8104e2b31f9c0a172f8e2f3b1204a3d21a72515b7d2a99b02c1c39fea014b26",
    "maxTimeoutSeconds": 60,
    "extra": {}
  },
  "payload": {
    "transaction": "AQEBAQFXpc4W8...base64-BEEF...",
    "derivationPrefix": "Cn0z2Q08xUzc",
    "derivationSuffix": "MTcwMDAwMDAwMDAwMA==",
    "senderIdentityKey": "02ab1c4f01b8ea24b0937a0a904ba9deec81a3120b784ed5f0662a2f9a4e2b19cd",
    "outputIndex": 0
  }
}
```

### `accepted` field definitions

- `network`: CAIP-2 network identifier from the registered ChainAgnostic [`bsv` namespace](https://github.com/ChainAgnostic/namespaces/blob/main/bsv/caip2.md) ([namespaces#190](https://github.com/ChainAgnostic/namespaces/pull/190)). This spec defines behavior for `bsv:mainnet`, `bsv:testnet`, `bsv:ttn` (Teranode Test Net), and `bsv:tstn` (Teranode Scaling Test Net); implementations MAY support additional `bsv:*` identifiers provided the wallet-chain agreement rule (Verification rule 3) still holds. The `bip122` namespace (genesis-block reference) is ambiguous for BSV because BSV shares its genesis block with BTC and BCH; clients and facilitators MUST refuse ambiguous Bitcoin-family identifiers (including genesis-only `bip122:*` references) rather than defaulting them to BSV.
- `asset`: The literal string `BSV` — this scheme transfers native satoshis only. There is no token contract.
- `payTo`: The recipient's BRC-100 identity public key (33-byte compressed secp256k1, 66 hex characters). This is *not* an on-chain address: the on-chain destination is a per-payment child key derived from it, unlinkable to `payTo` by third parties. It MUST be the identity key of the wallet held by the facilitator.
- `amount`: Exact amount in satoshis (atomic units, 8 decimals per BSV), as a decimal string.
- `extra`: No required fields.

### Payment construction (Client)

1. Generate a fresh random `derivationPrefix` (base64, minimum 8 bytes of entropy).
2. Let `time` be the current Unix timestamp in milliseconds as a decimal string; `derivationSuffix` = base64(UTF-8(`time`)).
3. Derive the recipient's per-payment public key via BRC-42 with the BRC-29 protocol ID `[2, "3241645161d8"]`, key ID `"<derivationPrefix> <derivationSuffix>"`, and counterparty `accepted.payTo`.
4. Build a P2PKH locking script over the hash160 of the derived public key (`76a914<pkh>88ac`).
5. Create, fund, and sign a transaction with an output of exactly `accepted.amount` satoshis to that script (BRC-100 `createAction`), and serialize it as BEEF including SPV ancestry.
6. Populate the payload with the base64 BEEF, the derivation parameters, the Client's identity key, and the payment output's index.

## Verification

A facilitator verifying an `exact` scheme payment on BSV MUST reject any payload that fails any rule below. General x402 v2 validation, including `PaymentPayload` structure and selected `PaymentRequirements` consistency, is defined by the core x402 specification.

1. **Verify** the payload shape: `transaction`, `derivationPrefix`, and `derivationSuffix` are non-empty strings, `senderIdentityKey` is a 33-byte compressed secp256k1 public key in hex, and `outputIndex` is a non-negative integer. `derivationPrefix` MUST base64-decode to at least 8 bytes (the BRC-29 nonce minimum). `PaymentRequirements.asset`, when present, MUST be `BSV` — this scheme transfers native satoshis only.
2. **Verify** `PaymentRequirements.payTo` equals the identity public key of the facilitator's wallet (hex comparison is case-insensitive). A facilitator MUST NOT accept payments destined for identity keys it does not hold, since it cannot verify or take custody of them.
3. **Verify** wallet-chain agreement: `PaymentRequirements.network` MUST identify the network the facilitator's wallet operates on (per BRC-100 `getNetwork`). A facilitator MUST NOT verify or settle payments for a network its wallet does not operate on.
4. **Verify** freshness: `derivationSuffix` MUST base64-decode to a decimal Unix-millisecond timestamp within the payment window of the verifier's clock (30 seconds by default). The window is symmetric — future-dated timestamps beyond the window MUST also be rejected. (At settlement the past-facing window is extended by `maxTimeoutSeconds`; see Settlement.)
5. **Verify** the `transaction` decodes as BEEF and contains a subject transaction. The subject transaction is the one named by the Atomic BEEF (BRC-95) subject txid when present; for plain BEEF (BRC-62) it is the last transaction in dependency order. Verifiers MUST resolve the subject by Atomic subject txid when available so that the transaction validated is the one the wallet will internalize.
6. **Verify** the subject transaction's output at `outputIndex` exists, is a P2PKH output, and carries **exactly** `PaymentRequirements.amount` satoshis. Note this is stricter than plain BRC-121, which accepts overpayment; x402 `exact` semantics require equality.
7. **Verify** the payment destination: the P2PKH output MUST pay the hash160 of the child public key derived per BRC-42 with the BRC-29 protocol ID, key ID `"<derivationPrefix> <derivationSuffix>"`, and counterparty `senderIdentityKey` (the facilitator's wallet derives its own child key, e.g. BRC-100 `getPublicKey` with `forSelf: true`). This is the check a third party cannot perform unilaterally — a facilitator that does not hold the recipient wallet cannot satisfy this rule (absent a key-linkage disclosure per the [appendix](#key-linkage-revelation-and-auditability)), which is why rule 2 exists.
8. **Settlement-level verification** (performed by the wallet during `internalizeAction`, and the reason `settle` is authoritative): SPV validity of the BEEF ancestry (merkle paths against block headers, script evaluation for unmined ancestors) and transaction uniqueness (replay detection).

A facilitator MAY additionally SPV-validate the BEEF during `verify` (rule 8's first check) when it has access to a block-headers service, to fail earlier.

## Settlement

Settlement is performed by internalizing the payment output into the recipient's BRC-100 wallet via `internalizeAction` with the `wallet payment` protocol and the BRC-29 payment remittance `{ derivationPrefix, derivationSuffix, senderIdentityKey }`. The wallet validates the BEEF's SPV data, derives the child private key, confirms the output pays it, and takes custody.

The facilitator MUST re-run verification at settlement and MUST NOT assume a prior `/verify` result is still valid. For the freshness rule only, the past-facing window is extended by `PaymentRequirements.maxTimeoutSeconds` — the settlement budget the server advertised — so a payment that verified in time cannot expire while the resource is being served. The settlement deadline is therefore `timestamp + paymentWindow + maxTimeoutSeconds`.

**Broadcast and finality.** The facilitator's wallet MUST propagate the settled transaction to the BSV network promptly after internalization (e.g. via ARC). `success: true` reflects wallet acceptance of a transaction that is typically not yet mined: settlement is zero-confirmation. The payer holds the keys to the transaction's inputs until it is mined and can attempt a double-spend, so operators SHOULD price resources accordingly (BRC-121 targets small per-request amounts) and MAY hold `success` until broadcast acceptance or delay high-value custody decisions until confirmation.

**Replay protection** is layered:

1. The facilitator MUST reject duplicate settlement of the same subject txid. When the wallet reports a merge of an already-known transaction (the wallet-toolbox `isMerge: true` extension to the BRC-100 `internalizeAction` result — not part of the core BRC-100 result shape) *and* reports no newly internalized satoshis (`satoshis` is omitted or `0`), the facilitator MUST treat the call as a replay. `isMerge` alone is insufficient: a self-payment (same wallet creates and internalizes) returns `isMerge: true` on first settle because `createAction` already registered the transaction, while still reporting newly internalized satoshis. Because a conforming BRC-100 wallet is not required to report merge status or internalized satoshis, the facilitator MUST additionally keep a short-term dedup record of settled txids covering at least the settlement window (this also serializes concurrent duplicate `/settle` calls).
2. The freshness window (rule 4, as extended at settlement) bounds the total lifetime of any payment payload. The dedup record SHOULD therefore be retained for at least `paymentWindow + maxTimeoutSeconds`.

The dedup record is typically process-local (in-memory). Operators running multiple facilitator instances, or restarting between settle attempts, MUST route a given payment to a consistent instance (sticky sessions) or use a shared/persistent record — otherwise a fresh instance cannot see another's record and must fall back to the wallet's (non-portable) merge signal. Facilitators without a block-headers service to SPV-check at verify time also expose a limited DoS surface: a structurally valid but unfunded BEEF can force a resource handler to run before settlement rejects it, so such facilitators SHOULD enable an SPV pre-check at verify where available.

If internalization fails for any reason, the facilitator MUST return `success: false` with an `errorReason`.

## `SettlementResponse`

The `SettlementResponse` returned to the client for the `exact` scheme on BSV is:

```json
{
  "success": true,
  "payer": "02ab1c4f01b8ea24b0937a0a904ba9deec81a3120b784ed5f0662a2f9a4e2b19cd",
  "transaction": "6dd23e2b5e745a9a026b1ff8d3e59e88fd0f6ba0be6d0e2f5a7c5c1c95a6b30f",
  "network": "bsv:mainnet"
}
```

- `success`: Boolean indicating the settlement outcome.
- `payer`: The Client's identity public key (`senderIdentityKey`).
- `transaction`: 32-byte hex transaction id (txid) of the payment transaction.
- `network`: CAIP-2-style network identifier.

On failure (`success: false`), the response additionally contains:

- `errorReason`: A short string describing why settlement failed (e.g. `duplicate_settlement`, `invalid_exact_bsv_payload_amount_mismatch`).

Per the core x402 v2 specification, `transaction` MUST be the empty string whenever `success` is `false`, including `duplicate_settlement` (where the txid is known but the settlement did not occur).

## Appendix

### Privacy Properties

The on-chain output is a plain P2PKH payment to a key that only the payer and the recipient can associate with the recipient's identity key (BRC-42 ECDH derivation). Outside observers cannot link payments to `payTo`, and each payment uses a fresh derived key. Consequently `payTo` never appears on chain — it is a wallet-level identifier, not an address. Privacy is a default, not a lock-out: either counterparty can selectively disclose a payment's linkage (below) without affecting any other payment.

### Key Linkage Revelation and Auditability

Either counterparty can voluntarily prove that a specific payment output pays a key linked to the recipient's identity key, without revealing private keys and without granting any spend capability. BRC-100 exposes this as `revealSpecificKeyLinkage` (one derived key, one protocol, one counterparty) and `revealCounterpartyKeyLinkage` (the root shared secret — links *all* interactions between the two parties, far more invasive) per [BRC-69](https://bsv.brc.dev/key-derivation/0069); the revelation is independently verifiable by third parties using the Schnorr zero-knowledge proof scheme of [BRC-94](https://bsv.brc.dev/key-derivation/0094).

This makes the payment destination *third-party verifiable on demand*: a future scheme extension could carry a specific key-linkage proof in the payload (or an x402 extension), letting a facilitator that does not hold the recipient wallet verify rule 7, or letting an auditor confirm who was paid — relevant for regulated assets such as stablecoins issued on BSV. Custody is unaffected: only the recipient wallet can derive the child private key and spend the output. This specification does not define such an extension; implementations MUST NOT require linkage disclosure for the base scheme.

### Facilitator Deployment

Because settlement requires the recipient's wallet, the standard deployments are:

1. **In-process facilitator** — the resource server registers the BSV facilitator scheme (constructed with its own wallet) on a local `x402Facilitator` and routes verify/settle to it directly.
2. **Self-hosted facilitator service** — the recipient runs the standard x402 facilitator HTTP service backed by their wallet and points their resource servers at it.

A shared multi-tenant facilitator would need custody of (or RPC access to) each recipient's wallet; supporting third-party facilitators without recipient wallets would require either a different addressing mode (e.g. plain P2PKH to a static address in `payTo`) or a key-linkage-proof flow (see [Key Linkage Revelation](#key-linkage-revelation-and-auditability)) — both out of scope for this spec.

### Asset Identifier

The `asset` field is the literal ticker string `BSV`. Amounts are denominated in satoshis (1 BSV = 100,000,000 satoshis). The maximum representable amount is 2,100,000,000,000,000 satoshis.

### Network Identifiers

Registered ChainAgnostic [`bsv` namespace](https://github.com/ChainAgnostic/namespaces/blob/main/bsv/caip2.md) identifiers (CAIP-2):

- `bsv:mainnet` — BSV main network.
- `bsv:testnet` — BSV public test network.
- `bsv:ttn` — Teranode Test Net (public Teranode scaling test network / Teratestnet).
- `bsv:tstn` — Teranode Scaling Test Net (private, per-deployment Teranode scaling test network).

The `bip122` CAIP-2 namespace identifies chains by (truncated) genesis-block hash. BSV shares its genesis block with BTC and BCH, so a genesis-only `bip122` reference (e.g. `bip122:000000000019d6689c085ae165831e93`) cannot distinguish BSV from BTC. Paying the correct amount on the wrong chain is unrecoverable. Therefore:

1. This scheme uses the dedicated `bsv` namespace only.
2. Clients and facilitators MUST refuse to build, verify, or settle payments when `network` is an ambiguous Bitcoin-family identifier. They MUST NOT fall back to a default BSV network.

Wallet-chain agreement (Verification rule 3) maps each registered CAIP-2 id to the BRC-100 `getNetwork()` name: `mainnet`, `testnet`, `ttn`, or `tstn` respectively.

### External References

- [CAIP-2 for BSV](https://github.com/ChainAgnostic/namespaces/blob/main/bsv/caip2.md) — network identifier format (`bsv:mainnet`, `bsv:testnet`, `bsv:ttn`, `bsv:tstn`).
- [BRC-121: Simple 402 Payments](https://bsv.brc.dev/payments/0121) — the HTTP 402 payment profile this scheme adapts to x402.
- [BRC-29: Simple Authenticated BSV P2PKH Payment Protocol](https://bsv.brc.dev/payments/0029) — payment message format and key derivation semantics.
- [BRC-42: BSV Key Derivation Scheme](https://bsv.brc.dev/key-derivation/0042) — the ECDH child-key derivation underlying BRC-29.
- [BRC-62: Background Evaluation Extended Format (BEEF)](https://bsv.brc.dev/transactions/0062) — transaction serialization with SPV ancestry.
- [BRC-95: Atomic BEEF](https://bsv.brc.dev/transactions/0095) — single-subject-transaction BEEF profile.
- [BRC-100: Wallet-to-Application Interface](https://bsv.brc.dev/wallet/0100) — the wallet interface (`createAction`, `internalizeAction`, `getPublicKey`, `revealSpecificKeyLinkage`) used by both roles.
- [BRC-69: Revealing Key Linkages](https://bsv.brc.dev/key-derivation/0069) / [BRC-94: Verifiable Revelation of Shared Secrets Using Schnorr Protocol](https://bsv.brc.dev/key-derivation/0094) — the voluntary, third-party-verifiable disclosure mechanism discussed in the auditability appendix.
