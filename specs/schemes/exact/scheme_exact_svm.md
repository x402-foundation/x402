# Exact Payment Scheme for Solana Virtual Machine (SVM) (`exact`)

This document specifies the `exact` payment scheme for the x402 protocol on Solana.

The `exact` scheme defines **outcome-based payment semantics**: a client MUST effect an on-chain payment of an exact amount of a specified asset to a specified recipient.

How transaction fees are sponsored—and how the sponsoring party evaluates risk, limits cost, or constrains transaction structure—is intentionally separated from the payment semantics and described as a **Sponsor Acceptance Policy**. The sponsor MAY be the merchant itself or a third-party facilitator.

---

## Scheme Name

`exact`

---

## Terminology

- **Client**: The end user initiating the payment.
- **Merchant**: The resource server receiving payment, identified by `payTo`.
- **Sponsor**: The entity that signs the transaction as `feePayer`. The sponsor MAY be:
  - the **merchant** itself, or
  - a **third-party facilitator**.
- **Fee Payer (`feePayer`)**: The Solana account of the Sponsor that pays transaction fees and provides the final required signature.
- **Smart wallet**: A program-controlled account (e.g. Squads, Swig, SPL Governance, Metaplex Core) that executes a token transfer via Cross-Program Invocation (CPI) rather than as a top-level `TransferChecked`.
- **Primary payment**: The transfer to the merchant identified by `payTo`. In the absence of splits this is the entire `amount`; with splits it is the remainder (§5).
- **Split**: An additional payee, beyond the merchant, that receives a fixed carve-out of the total `amount` in the same atomic transaction. Declared in `extra.splits` (§5). Used for platform fees, revenue sharing, referral commissions, or fee-payer cost recovery.

---

## Protocol Flow

The protocol flow for `exact` on Solana is client-driven.

1. Client makes a request to a Resource Server.
2. Resource Server responds with a payment required signal containing `PaymentRequired`. The `extra` field contains a `feePayer`, identifying the sponsor, and MAY contain a `recentBlockhash` for the Client to build against.
3. Client creates a transaction that effects a payment of an asset to the merchant for a specified amount. If a valid `extra.recentBlockhash` is present the Client uses it as the transaction lifetime; otherwise the Client fetches a recent blockhash itself.
4. Client signs the transaction, producing a partially signed transaction (the sponsor's `feePayer` signature is still missing).
5. Client serializes the partially signed transaction as Base64.
6. Client sends a request to the Resource Server, submitting the transaction via `PaymentPayload` alongside the `PaymentRequirements`.
7. Resource Server forwards the payload to the Sponsor's `/verify` endpoint.
8. Sponsor inspects the transaction to confirm it produces the required payment outcome and satisfies the Sponsor Acceptance Policy.
9. Sponsor returns a `VerifyResponse` to the Resource Server.
10. Resource Server, upon successful verification, forwards the payload to the Sponsor's `/settle` endpoint.
11. Sponsor provides its final signature as `feePayer` and submits the now fully-signed transaction to the network.
12. Upon successful on-chain settlement, a `SettlementResponse` is returned from the Sponsor to the Resource Server.
13. Resource Server grants the Client access to the resource in its response.

Resource servers with long-running handlers SHOULD use payment flow `upfront`, because under `authorization` the handler must complete before the signed transaction's blockhash expires (~60–90 seconds).

---

## `PaymentRequirements` for `exact`

In addition to the standard x402 `PaymentRequirements` fields, the `exact` scheme on Solana requires the following inside the `extra` field:

```json
{
  "scheme": "exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "1000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
  "maxTimeoutSeconds": 60,
  "extra": {
    "feePayer": "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd",
    "memo": "pi_3abc123def456",
    "recentBlockhash": "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k",
    "lastValidBlockHeight": "291470237"
  }
}
```

- `asset`: The public key of the token mint.
- `payTo`: The merchant's public key.
- `extra.feePayer`: The sponsor's public key. This MAY equal `payTo` (merchant-sponsored fees) or be a distinct third party.
- `extra.memo` (optional): A seller-defined UTF-8 string to include in the transaction's Memo instruction. When present, the client MUST use this value as the Memo instruction data instead of a random nonce. Maximum 256 bytes. This enables sellers to attach payment references (e.g., invoice IDs) to on-chain transactions for reconciliation without requiring unique deposit addresses.
- `extra.recentBlockhash` (optional): A recent blockhash for the Client to use as the transaction's lifetime, supplied by the Resource Server. When present and valid, the Client SHOULD use it instead of fetching its own via `getLatestBlockhash`, saving an RPC round-trip and pinning the transaction to a blockhash the settling RPC has observed. When absent or malformed, the Client MUST fetch a recent blockhash itself. A Resource Server SHOULD only set this when it has an RPC endpoint whose view of recent blockhashes matches the settling Sponsor's; a stale or fork-divergent blockhash will cause the transaction to expire or fail to land.
- `extra.lastValidBlockHeight` (optional): The last block height at which `extra.recentBlockhash` is valid, as a decimal string. This informational hint is not serialized into the transaction and MAY be ignored by the Client or Sponsor. It is ignored when `recentBlockhash` is absent.
- `extra.splits` (optional): An array of additional payees that receive fixed carve-outs of `amount` in the same transaction. When present, the merchant (`payTo`) receives the remainder rather than the full `amount`. See **Multi-Payee Splits** (§5) for the schema and semantics. When absent or empty, the scheme behaves exactly as specified in §1–§4 (a single transfer to `payTo`).
- `extra.ataCreationRequired` (optional): Boolean, default `false`. Marks the primary `payTo` as a recipient whose Associated Token Account for `asset` may not exist yet and may need to be created in the payment transaction. When set, the `feePayer` funds the creation, so it MUST only be set when the Sponsor advertises `ataCreationSponsored` in `/supported`. See §5.4 and §5.5.
- `extra.transactionVersions` (optional): The transaction message versions the sponsor accepts, as an array of `0` and/or `1`. Copied by the Resource Server from the facilitator's `/supported` `extra`. When absent, the accepted set is `[0]`. See §1.5.

`extra.recentBlockhash` and `extra.lastValidBlockHeight` are transaction-construction hints. They do not bind the submitted transaction to the hinted blockhash, and the facilitator's verification does not compare the transaction blockhash with `extra.recentBlockhash`. `extra.splits` and `extra.ataCreationRequired` are not hints: they are payment terms, verified under §5.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

```json
{
  "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
}
```

The `transaction` field contains the base64-encoded, serialized, **partially-signed** versioned Solana transaction. Its message version MUST be one the requirements advertise in `extra.transactionVersions`, or version `0` when that field is absent (see §1.5).

Full `PaymentPayload` object:

```json
{
  "x402Version": 2,
  "resource": {
    "url": "https://example.com/weather",
    "description": "Access to protected content",
    "mimeType": "application/json"
  },
  "accepted": {
    "scheme": "exact",
    "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
    "amount": "1000",
    "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "payTo": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
    "maxTimeoutSeconds": 60,
    "extra": {
      "feePayer": "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd",
      "memo": "pi_3abc123def456"
    }
  },
  "payload": {
    "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
  }
}
```

## `SettlementResponse`

The `SettlementResponse` for the exact scheme on Solana:

```json
{
  "success": true,
  "transaction": "base58 encoded transaction signature",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "base58 encoded public address of the payer's wallet"
}
```

---

## 1. Exact Payment Outcome Definition (Normative)

A transaction satisfies the `exact` payment scheme **if and only if**, when executed on-chain, it produces the following outcome.

### 1.1 Required Payment Outcome (MUST)

For a single-payee charge (no `extra.splits`), the transaction MUST result in:

- A transfer of at least `PaymentRequirements.amount`
- Of the asset identified by `PaymentRequirements.asset`
- To the recipient identified by `PaymentRequirements.payTo` (the Associated Token Account derived from `payTo` and `asset`)
- Using one of:
  - `spl-token` `TransferChecked`
  - `token-2022` `TransferChecked`

The payment MUST be:

- **Sufficient** (at least the required amount; see §1.4 on overpayment)
- **Atomic** (no partial fulfillment)
- **Unconditional** (not dependent on post-transaction behavior)

The transfer MAY appear either as a top-level instruction or as an inner instruction (CPI) emitted by another program. This is what allows smart wallets to satisfy the scheme: the payment outcome is what matters, not the instruction that produced it.

When `extra.splits` is present, §5.3 replaces this outcome. `PaymentRequirements.amount` is the total across all legs, `payTo` receives only the remainder (§5.2), and each split recipient receives its declared amount. The other properties above (asset, ATA derivation, token program, top-level or CPI) apply to each leg.

### 1.2 Payment Identification (MUST)

A verifier MUST be able to deterministically identify the payment and confirm:

- Correct mint
- Correct destination account (the ATA derived from `payTo` + `asset` under the relevant token program)
- Correct amount
- Correct token program (`spl-token` or `token-2022`)

The presence of additional instructions does not invalidate the payment, provided the required outcome is achieved.

### 1.3 Non-Prescriptive Structure (Explicit)

The `exact` scheme:

- DOES NOT prescribe a fixed instruction count
- DOES NOT require a fixed instruction order
- DOES NOT restrict additional instructions, provided the payment outcome is achieved and the Sponsor Acceptance Policy (§2) is satisfied

This ensures forward compatibility with wallet behavior, protocol evolution, and auxiliary instructions (e.g., compute budget, safety checks, memos, smart-wallet wrappers).

### 1.4 Exactly One Matching Transfer (MUST)

Across all top-level instructions and the full CPI trace, **exactly one** transfer MUST match the requirements (correct mint, correct destination ATA, amount `>=` required). A verifier:

- MUST reject if zero matching transfers are found.
- MUST reject if more than one matching transfer is found (ambiguous / potential double-payment).

A matching transfer MAY exceed `PaymentRequirements.amount` (overpayment is tolerated to accommodate smart wallets with internal fee rounding); it MUST NOT be less.

When `extra.splits` is present, this rule applies **per payment leg**: exactly one matching transfer per leg, matched to a distinct instruction (§5.3). Only the primary leg tolerates overpayment; split legs MUST match their declared amount exactly.

---

### 1.5 Transaction Versions (MUST)

Solana defines three transaction message formats: legacy, version `0` (adds
Address Lookup Tables), and version `1` ([SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md): 4096-byte transactions that
carry the compute budget in the message header). The facilitator advertises
the versions it accepts as `extra.transactionVersions` in `/supported`, and the
server MUST copy that value into `PaymentRequirements.extra.transactionVersions`.
Entries MUST be the JSON integers `0` and `1` only. Unlike Wallet Standard
`supportedTransactionVersions`, the field never contains `legacy`, and a
string such as `"1"` is not a valid entry. A client or server MUST treat a field
containing any non-integer entry (a string, `null`, or `"legacy"`) or any
integer other than `0` or `1` as invalid and fail closed with
`unsupported_transaction_version`. When the field is absent, the accepted set
is `[0]`.

Legacy (unversioned) messages are deprecated. They are never advertised in
`extra.transactionVersions` and clients MUST NOT build them. A facilitator MAY
keep accepting legacy messages from existing clients for backward
compatibility; that tolerance will be removed in a future revision of this
scheme.

- The client MUST intersect the advertised versions (`[0]` when the field is
  absent) with the versions it and its signer support, then build the highest
  version in that intersection. It MUST fail with
  `unsupported_transaction_version` when the intersection is empty.
  A version-1 message MUST NOT use Address Lookup Tables because that message
  format does not support them. Legacy and version-0 messages remain subject
  to the ALT visibility requirements in §2.1.2.
- The sponsor MUST reject a message whose version is outside the set it
  accepts, before inspecting any instruction, with
  `unsupported_transaction_version`. The sponsor enforces its own accepted
  set; it does not read `PaymentRequirements.extra.transactionVersions`.
- A legacy or version-0 transaction MUST NOT exceed 1232 serialized bytes; a version-1
  transaction MUST NOT exceed 4096 serialized bytes.
- A version-1 transaction carries its compute budget in the message's
  `TransactionConfigMask` and the config values that follow it
  ([SIMD-0385](https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md#transactionconfigmask)).
  This spec names the values by the bits that carry them:
  - bits 0 and 1: `priorityFee`, the total priority fee in lamports (u64). The
    two bits are set together; a transaction with only one set is invalid.
  - bit 2: `computeUnitLimit` (u32).
  - bit 3: `loadedAccountsDataSizeLimit` (u32).
  - bit 4: the requested heap size (u32).

  SDKs expose these as a config object (for example `config` on a
  `@solana/kit` message or `TransactionConfig` in solana-go). An unset value
  takes its minimum: an unset `priorityFee` is 0, an unset `computeUnitLimit`
  requests 0 compute units, and an unset `loadedAccountsDataSizeLimit` requests
  0 bytes of loaded account data. (The cost model still reserves 32 KiB of
  loaded account data for scheduling, but the transaction's own budget is 0.)
  A transaction that leaves bit 2 or bit 3 unset therefore cannot execute its
  instructions, so a client-built version-1 transaction MUST set both.
- The runtime ignores Compute Budget program instructions in a version-1
  transaction: they configure nothing and execute as no-ops that still consume
  compute units. As an x402 sponsor rule, a client-built version-1 transaction
  MUST NOT contain them, and the sponsor MUST reject one that does.
- A version-1 `priorityFee` is evaluated against a per-compute-unit cap as
  `priorityFee * 1000000 <= capMicroLamports * computeUnitLimit`. `capMicroLamports` is the compute unit price cap, in
  microlamports per compute unit, of the verification path that accepts the
  transaction. It is the same cap that path applies to `SetComputeUnitPrice` in
  a legacy or version-0 transaction: `maxPriorityFeeMicroLamports` on Path 1
  (§3.1) and `smartWalletMaxPriorityFeeMicroLamports` on Path 2 (§3.2); see
  §2.2.1 for the defaults. The sponsor MUST evaluate both sides of the
  inequality with arbitrary-precision integers (or at least 128-bit unsigned
  integers), so that an oversized `priorityFee` cannot wrap and pass the check.

## 2. Sponsor Acceptance Policy (Reference)

This section defines minimum required and recommended checks for any sponsor that signs as `feePayer` (merchant or third-party facilitator).

These rules concern sponsor safety and cost control, not payment validity. A sponsor MAY reject transactions that satisfy the `exact` scheme but violate its local policy. Clients SHOULD NOT assume universal sponsorship for all valid `exact` transactions.

### 2.1 Minimal Safety Baseline (Normative MUSTs)

A sponsor that signs a transaction as `feePayer` MUST enforce all of the following **before signing**.

#### 2.1.1 Fee Payer Isolation (MUST)

The sponsor's signature MUST be used only to authorize payment of transaction fees. Concretely:

- The `feePayer` MUST NOT appear in the `accounts` list of any instruction (top-level or, where resolvable, otherwise referenced), and MUST NOT be invoked as a program.
- The `feePayer` MUST NOT be used as an authority, source, or delegate for any transfer.

If the fee payer is never referenced by any instruction, the Solana runtime cannot authorize it for SOL transfers, token transfers, approvals, ATA creation, account closure, or any other drain vector. The fee payer pays only the network fee, automatically.

The `feePayer` MAY appear as the payment recipient when `feePayer == payTo`, since receiving funds does not require the fee payer to be a signer on a debiting instruction.

The one bounded exception to fee-payer isolation is recipient ATA creation (§5.4). The `feePayer` MAY appear in a top-level `AssociatedTokenProgram: CreateIdempotent` instruction, and in that instruction's CPI trace, only in these positions:

- **Funding payer** (account 0, signer, writable): only when the Sponsor advertises `ataCreationSponsored` in `/supported` and the instruction creates the ATA, for `asset`, of a recipient marked `ataCreationRequired`. In the resulting CPI trace, the fee payer MAY be the source of the System Program `CreateAccount` (or, when the ATA address already holds lamports, `Transfer`) to that ATA, for no more than the rent-exempt minimum of the token account.
- **Wallet owner** (account 2, read-only, not a signer): only when the fee payer is itself a declared recipient (`feePayer == payTo`, or a split `payTo` equal to `feePayer`) and the instruction creates that recipient's ATA. The owner position grants no authority.

The fee payer MUST NOT appear in any other account position, in any other instruction (including inside a smart-wallet wrapper), or as the source of any other System Program instruction in the CPI trace.

#### 2.1.2 Address Lookup Table Visibility (MUST)

If the transaction uses Address Lookup Tables (ALTs), the sponsor MUST resolve them so that every account the transaction can touch is visible before the isolation check in §2.1.1 runs. A sponsor that cannot resolve a transaction's ALTs MUST reject it rather than verify against an incomplete account set (`smart_wallet_alt_resolution_not_available`). A transient failure to resolve ALTs MUST fail closed (reject / retryable), never open.

#### 2.1.3 Fee Payer Fund Safety (MUST)

The sponsor MUST reject any transaction in which the sponsor's funds could be debited beyond the network fee — including SOL transfers from sponsor-controlled accounts, token transfers for which the sponsor is the authority, or account closures/reallocations that move the sponsor's lamports. Enforcing §2.1.1 and §2.1.2 is sufficient to prevent these conditions for standard Solana programs.

The sole intentional exception is fee-payer-funded ATA rent for recipients (the primary `payTo` or a split recipient) that the Resource Server marks `ataCreationRequired`, offered only by Sponsors that advertise `ataCreationSponsored` in `/supported` (§5.4, §5.5). This is bounded per transaction (≈0.002 SOL per created ATA, never for an ATA that already exists), opt-in on both sides, and forbidden for any owner outside the declared recipient set. It is not bounded over time: an owner can close its ATA and the next charge pays rent again (§5.4). A sponsor that does not advertise ATA sponsorship is unaffected.

#### 2.1.4 Signer Set Integrity (MUST)

The transaction MUST NOT require any signatures beyond the client and the sponsor (`feePayer`). Additional signatures MAY be present but MUST NOT be required for transaction validity.

#### 2.1.5 Exact Payment Verification (MUST)

The transaction MUST satisfy the **Exact Payment Outcome Definition** (§1), including the exactly-one-matching-transfer rule (§1.4). When `extra.splits` is present, this extends to every payment leg and the split-specific acceptance rules of §5.5.

### 2.2 Cost and Griefing Controls (Recommended SHOULDs)

The following controls mitigate gas griefing and denial-of-service risks.

#### 2.2.1 Compute Budget Controls (SHOULD)

Sponsors SHOULD bound their fee exposure by enforcing maximum compute unit limits and maximum compute unit (priority fee) price on any `ComputeBudgetProgram` instructions. Only `SetComputeUnitLimit` (discriminator 2) and `SetComputeUnitPrice` (discriminator 3) SHOULD be accepted; other ComputeBudget instruction types expand execution surface without being necessary for payment verification and SHOULD be rejected.

Reference defaults (operator-configurable):

| Limit | Default |
|---|---|
| Max compute units | `400,000` |
| Path 1 max compute unit price (`maxPriorityFeeMicroLamports`) | `5,000,000` microlamports / CU (5 lamports / CU) |
| Path 2 max compute unit price (`smartWalletMaxPriorityFeeMicroLamports`) | `50,000` microlamports / CU |

The two price caps are separate. Path 1 (§3.1) accepts only the fixed
standard-wallet layout and applies `maxPriorityFeeMicroLamports`. Path 2 (§3.2)
admits arbitrary allowlisted programs and applies the stricter
`smartWalletMaxPriorityFeeMicroLamports`.

In a version-1 transaction the same caps apply to the message config values
instead (§1.5): `computeUnitLimit` (bit 2) MUST be set and MUST NOT exceed the
configured maximum, `loadedAccountsDataSizeLimit` (bit 3) MUST be set, and
`priorityFee` (bits 0 and 1, total lamports) MUST satisfy
`priorityFee * 1000000 <= capMicroLamports * computeUnitLimit`, where
`capMicroLamports` is the price cap of the accepting path, evaluated without
overflow as specified in §1.5. A version-1 transaction that contains a Compute
Budget instruction MUST be rejected (an x402 sponsor rule; the runtime treats
such instructions as no-ops).

#### 2.2.2 Program Allow/Deny Lists (SHOULD)

Sponsors SHOULD maintain an allowlist of programs permitted to reach simulation-based verification, so that arbitrary custom programs cannot exercise the simulation path. The reference implementation's default allowlist is:

| Program | Address |
|---|---|
| Squads Multisig v4 | `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` |
| Squads Smart Account | `SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG` |
| Swig (legacy) | `SWiGmQedKzMz1tiTqoJCWeGDnGXfNBp2PkXLkpCAtQo` |
| Swig v2 | `swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB` |
| SPL Governance | `GovER5Lthms3bLBqWub97yVrMmEogzX7xNjdXpPPCVZw` |
| Metaplex Core | `CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d` |
| Lighthouse (Phantom assertions) | `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95` |

The ComputeBudget and SPL Memo programs are **category-exempt** — they are not wallet programs and are permitted independently of the allowlist (ComputeBudget is bounded by §2.2.1; Memo is enforced in §3.2). The Associated Token Account program (`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`) is exempt on the same basis, but only for `CreateIdempotent` instructions that satisfy §5.4. Any other top-level program not on the allowlist SHOULD be rejected (`smart_wallet_program_not_allowed`). Operators MAY override the allowlist.

#### 2.2.3 Simulation-Based Rejection (SHOULD)

Sponsors SHOULD simulate the exact signed transaction and reject it if execution fails, compute usage exceeds configured limits, or unexpected behavior is observed. (Simulation is a fee-saving and viability check; security comes from the pre-sign checks in §2.1 and post-settlement verification in §3.4 — see I5 in §4.)

### 2.3 Policy Flexibility (Explicit)

- A transaction MAY be valid under the `exact` scheme while being rejected by a sponsor's policy.
- Sponsors MAY introduce stricter limits but MUST NOT relax the §2.1 MUSTs.

---

## 3. Reference Verification Implementation (Two-Path)

The reference TypeScript facilitator (`@x402/svm`) implements §2 as two verification paths. Path 2 is **opt-in** via `enableSmartWalletVerification`; when disabled, only Path 1 applies.

```typescript
import { ExactSvmScheme } from "@x402/svm";

const scheme = new ExactSvmScheme(signer, undefined, {
  enableSmartWalletVerification: true,
  smartWalletMaxComputeUnits: 400_000,             // optional, default 400k
  smartWalletMaxPriorityFeeMicroLamports: 50_000,  // optional, default 50k
  smartWalletAllowedPrograms: [/* ... */],         // optional, defaults to §2.2.2
});
```

When `enableSmartWalletVerification` is enabled, the signer MUST implement the simulation, ALT-resolution, and post-settlement methods; the constructor throws otherwise (no silent degradation).

### 3.1 Path 1 — Static Layout Verification (standard wallets)

The fast path for standard wallets has a version-specific layout.

For a single-payee charge (no `extra.splits` and no ATA creation), a legacy or version-0 transaction MUST contain 3 to 7 instructions in this
order:

1. Compute Budget: Set Compute Unit Limit
2. Compute Budget: Set Compute Unit Price
3. SPL Token or Token-2022 `TransferChecked`
4. (Optional) Lighthouse or Memo program instruction
5. (Optional) Lighthouse or Memo program instruction
6. (Optional) Lighthouse or Memo program instruction
7. (Optional) Memo program instruction

For a single-payee charge, a version-1 transaction MUST contain 1 to 5 instructions in this order:

1. SPL Token or Token-2022 `TransferChecked`
2. (Optional) Lighthouse or Memo program instruction
3. (Optional) Lighthouse or Memo program instruction
4. (Optional) Lighthouse or Memo program instruction
5. (Optional) Memo program instruction

- Allowed optional programs: Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`) and SPL Memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
- Phantom wallet injects up to 3 Lighthouse instructions; Solflare injects 2. These are wallet-injected user protection mechanisms and MUST be allowed. For legacy and version-0 transactions, the cap of 7 instructions keeps these wallets on the fast path without needing Path 2. A version-1 transaction has no Compute Budget instructions, so its cap is 5 and that cap still applies.
- The Memo instruction ensures transaction uniqueness across concurrent payments with identical parameters. Clients MUST include a Memo instruction containing either the value of `extra.memo` (when present) or a random nonce (at least 16 bytes, hex-encoded for UTF-8 compliance).
- If `extra.memo` is present, the facilitator MUST verify that exactly one Memo instruction exists and that its data matches `extra.memo` encoded as UTF-8.
- Fee payer isolation, destination ATA derivation, and exact amount match are
  enforced on both layouts. The legacy/version-0 Compute Budget price and the
  version-1 total priority fee MUST each be no greater than
  `maxPriorityFeeMicroLamports` (default 5 lamports/CU) on this path, using the
  normalization in §1.5 for version 1.

When `extra.splits` is present or any recipient is marked `ataCreationRequired`, the single-payee caps do not apply as written. They generalize to `3 + N + K` to `7 + N + K` instructions for a legacy or version-0 transaction, and to `1 + N + K` to `5 + N + K` for a version-1 transaction, where `N` is the number of splits and `K` the number of `CreateIdempotent` instructions (at most one per marked recipient), in the layout defined in §5.7. Split charges from standard wallets are expected to verify on Path 1: a charge whose instruction count is within these bounds MUST NOT be rejected, or sent to Path 2, because of its count.

### 3.2 Path 2 — Simulation-Based Smart Wallet Verification

Smart wallet programs wrap the transfer inside their own instruction (e.g. Squads `vaultTransactionExecute`, Swig `SignV2`), so Path 1 sees an unknown program at the transfer position and rejects it. Path 2 verifies the **outcome** instead of the instruction format:

1. **Fee payer isolation** (§2.1.1): the fee payer MUST NOT appear in any instruction's accounts or as a program ID, after ALT resolution (§2.1.2). The only exception is the bounded `CreateIdempotent` one in §2.1.1 (funding payer or wallet owner of a top-level `CreateIdempotent` for a marked recipient, plus that instruction's rent CPI). The fee payer MUST NOT appear in any other instruction, including inside a smart-wallet wrapper.
2. **Compute budget caps** (§2.2.1): operator-configurable CU cap and `smartWalletMaxPriorityFeeMicroLamports` (default 50,000 microlamports/CU), applied to `SetComputeUnitPrice` on legacy/version 0 and to the normalized `priorityFee` on version 1 (§1.5).
3. **Program allowlist** (§2.2.2): the wrapping program MUST be on the allowlist.
4. **Memo enforcement**: if `extra.memo` is present, exactly one top-level Memo instruction MUST match it (mirrors Path 1, so a seller-required memo cannot be bypassed by routing through a smart wallet).
5. **Simulate with inner instructions**: `simulateTransaction` is called with `innerInstructions: true` to obtain the full CPI trace (no additional round-trip — simulation is already the final verification step). The RPC may return inner instructions in either `jsonParsed` or compiled (base58) format; both are handled.
6. **Match exactly one transfer** (§1.4): across top-level and inner instructions, exactly one `TransferChecked` MUST match the required mint, destination ATA (derived for both token programs), and amount (`>=` required). The fee payer / sponsor MUST NOT be the authority on any observed transfer (self-spend protection). When `extra.splits` is present, this generalizes to exactly one matching `TransferChecked` per payment leg (§5.3) — one for the primary remainder and one for each split — and no `asset` transfer to any account outside the declared recipient set (§5.5).

### 3.3 Path Selection (Path 1 → Path 2)

Path 2 runs **only** when Path 1 rejects for a *recoverable layout reason* — i.e. the verifier could not structurally understand the transaction (wrong instruction count, unknown or extra instructions, missing positional transfer). These reasons are tracked in an explicit recoverable-reason set.

Semantic failures — amount mismatch, mint mismatch, recipient mismatch, memo count/mismatch, self-spend, or a failed Path 1 simulation — return their real reason and MUST NOT fall through to Path 2. This prevents a legitimate semantic rejection from being masked behind a misleading `smart_wallet_*` error code. (A transaction that fails Path 1 simulation would fail Path 2 simulation too, so there is nothing to recover.)

The `verify` and `settle` entry points share a single internal `_verify` returning the result plus which path verified (`static` vs `smartWallet`), so `settle` applies the correct post-settlement policy without re-deriving the path.

### 3.4 Post-Settlement Verification (TOCTOU defense)

Simulation proves a transaction *would* succeed but is not proof it *did* (a malicious program could behave differently at execution time). For smart-wallet (Path 2) settlements, after the transaction confirms the sponsor MUST verify the transfer actually executed on-chain:

- **Primary**: fetch the confirmed transaction's inner instructions (`getConfirmedTransactionInnerInstructions`, with bounded retry for RPC indexing lag) and confirm exactly one matching `TransferChecked` per payment leg. A single-payee charge has one leg; a split charge has `N + 1`, matched to distinct transfers as in §3.2 step 6 and §5.3.
- **Fallback**: if inner instructions are unavailable (indexing lag), check the balance delta of every leg's destination ATA, trying both SPL Token and Token-2022 programs. The primary ATA's delta MUST be `>=` its required amount (`amount` for a single-payee charge, the remainder with splits) and each split ATA's delta MUST equal that split's `amount`.

Settlement success MUST reflect actual on-chain effects, not simulation alone.

---

## 4. Security Invariants

The verification model upholds the following invariants:

| # | Invariant | How it is enforced |
|---|-----------|--------------------|
| I1 | **No token loss** | Fee payer never used as authority/source/delegate on any token operation; enforced *before signing* (§2.1.1, §2.1.3). |
| I2 | **Bounded SOL exposure** | Per-transaction cost capped via compute budget limits (§2.2.1). |
| I3 | **Merchant truth** | Settlement success returned only after confirming actual on-chain effects, not simulation (§3.4). |
| I4 | **Payment landed** | Exactly one confirmed `TransferChecked` per payment leg matches that leg's amount, mint, and destination ATA (§1.4, §3.4, §5.3). |
| I5 | **Simulation is non-critical** | Simulation saves fees; security comes from I1 (pre-sign) and I3 (post-settle) (§2.2.3, §3.4). |
| I6 | **No hidden accounts** | ALTs resolved so every reachable account is visible to verification (§2.1.2). |
| I7 | **Known programs only** | Only allowlisted wallet programs reach simulation-based verification (§2.2.2). |

---

## 5. Multi-Payee Splits (Optional)

The `exact` scheme MAY distribute a single client payment across the merchant and up to eight additional recipients in one atomic transaction. This supports platform fees, revenue sharing, referral commissions, and fee-payer cost recovery without extra round-trips or separate transactions.

Splits are declared by the Resource Server in `PaymentRequirements.extra.splits`. Split support is an advertised Sponsor capability, not an unadvertised local policy: a Sponsor announces how many splits it accepts, and whether it funds recipient ATA creation, in its `/supported` response (§5.5). When `extra.splits` is absent or empty and `extra.ataCreationRequired` is not set, the scheme behaves exactly as specified in §1–§4 (a single transfer to `payTo`), and this section does not apply.

### 5.1 `extra.splits` Schema

```json
{
  "scheme": "exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "amount": "1050000",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "payTo": "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4",
  "maxTimeoutSeconds": 60,
  "extra": {
    "feePayer": "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd",
    "memo": "pi_3abc123def456",
    "splits": [
      {
        "payTo": "3pF8Kg2aHbNvJkLMwEqR7YtDxZ5sGhJn4UV6mWcXrT9A",
        "amount": "50000",
        "memo": "platform fee",
        "ataCreationRequired": false
      }
    ]
  }
}
```

In the example the client pays `1050000` base units in total: `50000` to the split recipient and the `1000000` remainder to `payTo`.

| Field | Type | Required | Notes |
|---|---|---|---|
| `splits` | array | OPTIONAL | 1–8 entries. Absent or empty ⇒ single-payee `exact`. |
| `splits[].payTo` | string | REQUIRED | Base58-encoded recipient public key. |
| `splits[].amount` | string | REQUIRED | Decimal string in base units of `asset`. An **absolute** amount, not a percentage or basis points. MUST be a positive integer no greater than `2^64 − 1` (the SPL Token `u64` range), with no sign, decimal point, exponent, or leading zeros. |
| `splits[].memo` | string | OPTIONAL | Human-readable label for this leg (e.g. `"platform fee"`, `"referral"`), ≤ 566 bytes. Part of the payment terms: the client MUST show it with the leg's `payTo` address and `amount` when obtaining consent (§5.6), and, because it is unauthenticated server-supplied text, MUST NOT show it in place of the address. It is bound like every other requirements field: the client echoes the requirements it consented to in `PaymentPayload.accepted`, and verification runs against them. It is **not** emitted as an on-chain Memo instruction. Mirrors `splits[].memo` in the MPP Solana charge draft for wire parity. |
| `splits[].ataCreationRequired` | boolean | OPTIONAL | Default `false`. Marks this recipient's ATA as possibly needing creation in the payment transaction, funded by the `feePayer`. MUST only be set when the Sponsor advertises `ataCreationSponsored` (§5.4, §5.5). Meaningful only for SPL / Token-2022 assets. |

The primary `payTo` carries the equivalent top-level flag `extra.ataCreationRequired` (default `false`), governed by the same rules (§5.4). The single on-chain Memo remains governed by `extra.memo` (§3.1); per-split memos never reach the chain.

Every split shares the top-level `asset`; a split MUST NOT name a different mint. Split `payTo` values MUST be distinct from one another and from the primary `payTo`.

### 5.2 Amount Semantics (MUST)

- The top-level `amount` is the total the client pays.
- Each `splits[].amount` is an absolute carve-out from that total.
- The **primary payment** to `payTo` is the remainder: `primary = amount − Σ splits[].amount`.
- `Σ splits[].amount` MUST be strictly less than `amount`; equivalently, the primary remainder MUST be greater than zero. A Resource Server MUST NOT issue, and a Sponsor MUST reject, requirements in which splits consume the entire amount (`split_remainder_not_positive`).
- All amounts are integers in base units. No rounding or remainder redistribution is performed; the arithmetic MUST balance exactly.

A charge with `N` splits produces `N + 1` payment legs (one primary plus `N` splits), for a maximum of nine legs. The practical maximum may be lower than eight splits: the transaction MUST still fit the size limit of its message version (§1.5: 1232 bytes for legacy and version 0, 4096 bytes for version 1), which additional `TransferChecked` and ATA-creation instructions consume. A version-0 transaction MAY use Address Lookup Tables to raise this ceiling (subject to §2.1.2); a version-1 transaction cannot use them, but its larger limit fits a full eight-split charge with room to spare.

### 5.3 Payment Outcome with Splits (MUST)

When `extra.splits` is present, the transaction MUST produce, atomically:

- One transfer of the primary remainder (§5.2) of `asset` to the ATA derived from `payTo`, and
- For each split, one transfer of that split's `amount` of `asset` to the ATA derived from that split's `payTo`.

Each required payment leg MUST be matched to a **distinct** transfer instruction. A single transfer MUST NOT satisfy more than one leg. This generalizes the exactly-one-matching-transfer rule (§1.4): the verifier requires exactly one matching transfer *per leg*, and MUST reject if any leg is unmatched (`split_leg_unmatched`) or if any `asset` transfer matches no declared leg (`split_unexpected_transfer`).

Split legs MUST match their declared `amount` **exactly** (`==`). The primary leg retains the base overpayment tolerance (`≥ primary`, §1.4) to accommodate smart-wallet fee rounding; any excess accrues to `payTo` and never to a split recipient.

### 5.4 Recipient ATA Creation (MUST)

A recipient — the primary `payTo` or a split recipient — may not yet hold an Associated Token Account for `asset`, and a transfer to a missing ATA fails. The transaction MAY therefore include an **idempotent** ATA-creation instruction (`AssociatedTokenProgram: CreateIdempotent`) for a recipient. Because ATA creation spends the funding account's lamports (rent, ≈0.002 SOL) beyond the network fee, it is authorized explicitly on every side:

- **Resource Server**: marks each recipient whose ATA may need creating — `extra.ataCreationRequired: true` for the primary `payTo`, `splits[].ataCreationRequired: true` for a split recipient. Setting a flag authorizes the `feePayer` to fund that creation, so the Resource Server MUST NOT set either flag when the selected Sponsor does not advertise `ataCreationSponsored` (§5.5).
- **Sponsor**: advertises whether it funds such creation via `ataCreationSponsored` in `/supported` (§5.5). The funding payer of every `CreateIdempotent` in the transaction MUST be the `feePayer`, and the fee payer MAY fund it **only** for a recipient marked `ataCreationRequired: true`, and only by a Sponsor that advertises `ataCreationSponsored`. A Sponsor MUST reject any transaction in which the fee payer funds ATA creation for an unmarked recipient, for an owner outside the declared recipient set (`payTo` and every `splits[].payTo`), or when it has not advertised ATA sponsorship (`split_ata_creation_not_authorized`).
- **Client**: constructs the transaction and consents by signing it, naming the `feePayer` as the funding payer. The client MUST include a `CreateIdempotent` instruction for each marked recipient whose ATA it has not confirmed to exist, and SHOULD omit it for recipients whose ATA already exists. When included, the instruction MUST be `CreateIdempotent`, not `Create`: a non-idempotent `Create` fails if the ATA is created between transaction construction and settlement (for example by a concurrent charge to the same recipient), which would fail the whole payment. When the ATA already exists, `CreateIdempotent` is a cheap no-op, so the cost of including it is transaction size, not rent.
- ATA-creation instructions for unmarked recipients, or for any owner outside the declared recipient set, MUST NOT appear in the transaction regardless of who funds them.
- Client-funded ATA creation is not part of this extension. A client cannot see the Sponsor's `/supported` response, so the flag itself carries the funding decision: a marked recipient is always fee-payer funded. When the fee payer is itself the recipient (`feePayer == payTo`, or a split to the Sponsor for cost recovery), it also appears as the wallet owner of that `CreateIdempotent`, as permitted by §2.1.1.

This is a deliberate, bounded exception to Fee Payer Isolation (§2.1.1) and Fee Payer Fund Safety (§2.1.3); §2.1.1 lists the exact account positions and the rent CPI in which the fee payer may appear. The Sponsor MUST also check that the created account is the ATA derived from the marked owner, `asset`, and the instruction's token program.

Per transaction, rent exposure is opt-in per Sponsor (advertised), opt-in per recipient (marked), and never charged for an ATA that already exists, since `CreateIdempotent` is then a no-op. It is **not** bounded over time. An owner can close its ATA, reclaiming the rent to an address it chooses, and the next charge funds creation again. A Resource Server that controls its recipients can therefore cycle create and close to extract ≈0.002 SOL per charge, and can rotate `payTo` addresses to the same effect. A Sponsor that advertises `ataCreationSponsored` SHOULD bound this, for example by tracking sponsored creations per owner and mint and refusing or pricing repeats, by rate-limiting sponsored creations per Resource Server (§2.2), or by recovering the cost through a split to itself.

### 5.5 Capability Advertisement and Sponsor Acceptance with Splits (MUST)

Split support is not an unadvertised local policy. A Sponsor announces it in the `extra` object of the matching `kinds[]` entry of its `/supported` response, alongside `feePayer`:

```json
{
  "x402Version": 2,
  "scheme": "exact",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "extra": {
    "feePayer": "EwWqGE4ZFKLofuestmU4LDdK7XM1N4ALgdZccwYugwGd",
    "maxSplits": 8,
    "ataCreationSponsored": true
  }
}
```

| Field | Type | Notes |
|---|---|---|
| `maxSplits` | number | Maximum number of `extra.splits` entries the Sponsor accepts, `0`–`8`. **Absent ⇒ `0`**: the Sponsor does not accept splits and MUST reject requirements carrying a non-empty `splits` array. |
| `ataCreationSponsored` | boolean | Whether the `feePayer` funds ATA creation for recipients marked `ataCreationRequired` (§5.4). **Absent ⇒ `false`**. |

These keys sit in `kinds[].extra`, next to `feePayer`, rather than in a discriminator-style `capabilities` map. They are not variants of the payload a client may choose between. `maxSplits` is a numeric bound and `ataCreationSponsored` is a commitment of the Sponsor's own funds, and both MUST fail closed: a Sponsor that predates this extension advertises neither key, and that MUST be read as no support. A capabilities map where absence means full support would read the same silence as unlimited splits and sponsored rent.

A Resource Server MUST NOT issue requirements with more splits than the selected Sponsor advertises, and MUST NOT mark recipients `ataCreationRequired` for a Sponsor that does not advertise `ataCreationSponsored` (marking a recipient authorizes fee-payer funding, §5.4). Clients MUST NOT assume split support that the Sponsor has not advertised.

A Sponsor that signs a split transaction as `feePayer` MUST, in addition to the baseline in §2.1:

- Reject requirements whose `splits` array has more entries than its advertised `maxSplits` (`split_count_exceeded`).
- Recompute `primary = amount − Σ splits[].amount` from the requirements and reject if `primary ≤ 0` (§5.2).
- Match every payment leg to a distinct transfer per §5.3.
- Enforce the ATA-creation authorization rules of §5.4, including rejecting fee-payer-funded creation when it does not advertise `ataCreationSponsored`.
- Confirm that no `asset` transfer sends funds to any account other than the ATA derived from `payTo` or from a declared split `payTo` (`split_unexpected_transfer`).

Within what it advertises, a Sponsor retains the policy flexibility of §2.3 (for example a lower per-request limit on sponsored ATA creations).

### 5.6 Client-Side Verification (MUST)

Before signing, the client MUST verify that `extra.splits` — when present — contains only the recipients and amounts it expects. A malicious Resource Server could otherwise inject or alter splits to divert a portion of the payment. Specifically, the client MUST:

- Confirm each split's `payTo`, `amount`, and `memo` (when present) against the terms it agreed to. When asking a user for consent, show the `memo` as the label for that leg alongside its `payTo` address and `amount`, never instead of the address.
- Independently compute the primary remainder (`amount − Σ splits[].amount`) and confirm it is the amount reaching the merchant.
- Reject requirements whose split recipients or amounts it did not agree to, and reject any `ataCreationRequired: true` it is unwilling to fund.

### 5.7 Static Layout with Splits (MUST)

Path 1 (§3.1) generalizes for splits and for ATA creation. With `N` splits and `K` `CreateIdempotent` instructions (`0 ≤ K ≤` the number of recipients marked `ataCreationRequired: true`), a legacy or version-0 transaction MUST contain `3 + N + K` to `7 + N + K` instructions in this order:

1. Compute Budget: Set Compute Unit Limit
2. Compute Budget: Set Compute Unit Price
3. `K` `AssociatedTokenProgram: CreateIdempotent` instructions, at most one per marked recipient (primary or split), each omitted when that ATA already exists (§5.4)
4. One `TransferChecked` for the primary payment (the remainder)
5. `N` `TransferChecked` instructions, one per split, in the order of `extra.splits`
6. Up to four optional instructions: the same wallet-injected Lighthouse / SPL Memo instructions permitted in §3.1

A version-1 transaction carries its compute budget in the message header (§1.5), so it omits steps 1 and 2 and MUST contain `1 + N + K` to `5 + N + K` instructions in the same order from step 3. When `K > 0`, the transaction also invokes the Associated Token Account program, whose program data counts against `loadedAccountsDataSizeLimit`, so the client MUST size that limit to include it.

The optional tail keeps the four slots of §3.1, so Phantom and Solflare injections stay on the fast path no matter how many legs the charge has. A verifier matches the transfers positionally: the first `TransferChecked` after the `K` creates is the primary leg, and the next `N` are `extra.splits[0]` through `extra.splits[N - 1]`. A transaction that departs from this layout is a recoverable layout failure (§3.3) and MAY still verify on Path 2. The compute unit limit naturally grows with `N` and `K`, and remains subject to §2.2.1 (and, on version 1, the `TransactionConfig` rules of §1.5).

The exactly-one-Memo rule for `extra.memo` (§3.1) is unchanged: a single on-chain Memo governs the whole charge, not one per leg. Smart-wallet (Path 2, §3.2) charges verify the same `N + 1`-leg outcome across the CPI trace, and post-settlement verification (§3.4) confirms every leg landed on-chain, not simulation alone.

### 5.8 Security Invariants (Splits)

These extend the invariants of §4 when `extra.splits` is present.

| # | Invariant | How it is enforced |
|---|---|---|
| I8 | **No fund diversion** | Every `asset` transfer lands on an ATA derived from `payTo` or a declared split `payTo`; unexpected transfers rejected (§5.3, §5.5). |
| I9 | **Authorized, per-transaction-bounded rent** | Fee payer funds ATA creation only when it advertises `ataCreationSponsored`, only for recipients explicitly marked `ataCreationRequired`, never for an existing ATA, and only in the account positions of §2.1.1; creation for owners outside the declared recipient set forbidden. Repeat creation after an owner closes its ATA is bounded by Sponsor policy (§5.4, §5.5). |
| I10 | **Exact carve-outs** | Each split leg matches its declared amount exactly; only the primary leg tolerates overpayment (§5.3). |
| I11 | **Consented distribution** | Client verifies split recipients, amounts, and memos (when present) before signing, showing each memo alongside its address (§5.6). |
| I12 | **Advertised capability** | Split count and ATA sponsorship are bounded by what the Sponsor advertises in `/supported`; absent advertisement means no support, and requirements exceeding it are rejected (§5.5). |

---

## Duplicate Settlement Mitigation (RECOMMENDED)

### Vulnerability

A race condition exists in the settlement flow: if the same payment transaction is submitted to the facilitator's `/settle` endpoint multiple times before the first submission is confirmed on-chain, each call may return a successful response.

Although Solana's transaction deduplication ensures the transfer only executes once on-chain, the RPC returns "success", and hence the facilitator could return `success` to each caller. A malicious client can exploit this to obtain access to multiple resources while only paying once.

### Recommended Mitigation

Merchants and/or Facilitators SHOULD maintain a short-term, in-memory cache of transaction payloads that are currently being settled. Before proceeding with settlement, the merchant/facilitator checks whether the transaction has already been seen:

1. After verification succeeds, derive a cache key from the transaction payload (e.g., the base64-encoded transaction string).
2. If the key is already present in the cache, reject the settlement with a `"duplicate_settlement"` error.
3. If the key is not present, insert it into the cache and proceed with signing and submission.
4. Evict entries older than 120 seconds (approximately twice the Solana blockhash lifetime of ~60–90 seconds). After this window, the transaction's blockhash will have expired and it cannot land on-chain regardless.

This approach requires no external storage or long-lived state — only an in-process map with time-based eviction. It preserves the facilitator's otherwise stateless design while closing the duplicate settlement attack vector.
