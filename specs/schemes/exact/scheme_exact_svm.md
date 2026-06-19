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

---

## Protocol Flow

The protocol flow for `exact` on Solana is client-driven.

1. Client makes a request to a Resource Server.
2. Resource Server responds with a payment required signal containing `PaymentRequired`. The `extra` field contains a `feePayer`, identifying the sponsor, and MAY contain a `recentBlockhash` for the Client to build against.
3. Client creates a transaction that effects a payment of an asset to the merchant for a specified amount. If `extra.recentBlockhash` is present the Client uses it as the transaction lifetime; otherwise the Client fetches a recent blockhash itself.
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
- `extra.recentBlockhash` (optional): A recent blockhash for the Client to use as the transaction's lifetime, supplied by the Resource Server. When present, the Client SHOULD use it instead of fetching its own via `getLatestBlockhash`, saving an RPC round-trip and pinning the transaction to a blockhash the settling RPC has observed. When absent, the Client MUST fetch a recent blockhash itself. A Resource Server SHOULD only set this when it has an RPC endpoint whose view of recent blockhashes matches the settling Sponsor's; a stale or fork-divergent blockhash will cause the transaction to expire or fail to land.
- `extra.lastValidBlockHeight` (optional): The last block height at which `extra.recentBlockhash` is valid, as a decimal string. Provided alongside `recentBlockhash` so the Client and Sponsor can bound the transaction's validity window. Ignored when `recentBlockhash` is absent.

## PaymentPayload `payload` Field

The `payload` field of the `PaymentPayload` contains:

```json
{
  "transaction": "AAAAAAAAAAAAA...AAAAAAAAAAAAA="
}
```

The `transaction` field contains the base64-encoded, serialized, **partially-signed** versioned Solana transaction.

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
  "payer": "base58 encoded public address of the transaction fee payer"
}
```

---

## 1. Exact Payment Outcome Definition (Normative)

A transaction satisfies the `exact` payment scheme **if and only if**, when executed on-chain, it produces the following outcome.

### 1.1 Required Payment Outcome (MUST)

The transaction MUST result in:

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

---

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

#### 2.1.2 Address Lookup Table Visibility (MUST)

If the transaction uses Address Lookup Tables (ALTs), the sponsor MUST resolve them so that every account the transaction can touch is visible before the isolation check in §2.1.1 runs. A sponsor that cannot resolve a transaction's ALTs MUST reject it rather than verify against an incomplete account set (`smart_wallet_alt_resolution_not_available`). A transient failure to resolve ALTs MUST fail closed (reject / retryable), never open.

#### 2.1.3 Fee Payer Fund Safety (MUST)

The sponsor MUST reject any transaction in which the sponsor's funds could be debited beyond the network fee — including SOL transfers from sponsor-controlled accounts, token transfers for which the sponsor is the authority, or account closures/reallocations that move the sponsor's lamports. Enforcing §2.1.1 and §2.1.2 is sufficient to prevent these conditions for standard Solana programs.

#### 2.1.4 Signer Set Integrity (MUST)

The transaction MUST NOT require any signatures beyond the client and the sponsor (`feePayer`). Additional signatures MAY be present but MUST NOT be required for transaction validity.

#### 2.1.5 Exact Payment Verification (MUST)

The transaction MUST satisfy the **Exact Payment Outcome Definition** (§1), including the exactly-one-matching-transfer rule (§1.4).

### 2.2 Cost and Griefing Controls (Recommended SHOULDs)

The following controls mitigate gas griefing and denial-of-service risks.

#### 2.2.1 Compute Budget Controls (SHOULD)

Sponsors SHOULD bound their fee exposure by enforcing maximum compute unit limits and maximum compute unit (priority fee) price on any `ComputeBudgetProgram` instructions. Only `SetComputeUnitLimit` (discriminator 2) and `SetComputeUnitPrice` (discriminator 3) SHOULD be accepted; other ComputeBudget instruction types expand execution surface without being necessary for payment verification and SHOULD be rejected.

Reference defaults (operator-configurable):

| Limit | Default |
|---|---|
| Max compute units | `400,000` |
| Max priority fee | `50,000` microlamports |

(The static fast path of the reference implementation applies a tighter cap of ≤ 5 lamports / CU for standard wallets; see §3.1.)

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

The ComputeBudget and SPL Memo programs are **category-exempt** — they are not wallet programs and are permitted independently of the allowlist (ComputeBudget is bounded by §2.2.1; Memo is enforced in §3.2). Any other top-level program not on the allowlist SHOULD be rejected (`smart_wallet_program_not_allowed`). Operators MAY override the allowlist.

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

The fast path for standard wallets. The decompiled transaction MUST contain 3 to 7 instructions in this order:

1. Compute Budget: Set Compute Unit Limit
2. Compute Budget: Set Compute Unit Price
3. SPL Token or Token-2022 `TransferChecked`
4. (Optional) Lighthouse or Memo program instruction
5. (Optional) Lighthouse or Memo program instruction
6. (Optional) Lighthouse or Memo program instruction
7. (Optional) Memo program instruction

- Allowed optional programs: Lighthouse (`L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`) and SPL Memo (`MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr`).
- Phantom wallet injects up to 3 Lighthouse instructions; Solflare injects 2. These are wallet-injected user protection mechanisms and MUST be allowed. The cap of 7 instructions keeps these wallets on the fast path without needing Path 2.
- The Memo instruction ensures transaction uniqueness across concurrent payments with identical parameters. Clients MUST include a Memo instruction containing either the value of `extra.memo` (when present) or a random nonce (at least 16 bytes, hex-encoded for UTF-8 compliance).
- If `extra.memo` is present, the facilitator MUST verify that exactly one Memo instruction exists and that its data matches `extra.memo` encoded as UTF-8.
- Fee payer isolation, compute budget validity (compute unit price ≤ 5 lamports/CU on this path), destination ATA derivation, and exact amount match are enforced as before.

### 3.2 Path 2 — Simulation-Based Smart Wallet Verification

Smart wallet programs wrap the transfer inside their own instruction (e.g. Squads `vaultTransactionExecute`, Swig `SignV2`), so Path 1 sees an unknown program at the transfer position and rejects it. Path 2 verifies the **outcome** instead of the instruction format:

1. **Fee payer isolation** (§2.1.1): the fee payer MUST NOT appear in any instruction's accounts or as a program ID, after ALT resolution (§2.1.2).
2. **Compute budget caps** (§2.2.1): operator-configurable CU and priority-fee caps.
3. **Program allowlist** (§2.2.2): the wrapping program MUST be on the allowlist.
4. **Memo enforcement**: if `extra.memo` is present, exactly one top-level Memo instruction MUST match it (mirrors Path 1, so a seller-required memo cannot be bypassed by routing through a smart wallet).
5. **Simulate with inner instructions**: `simulateTransaction` is called with `innerInstructions: true` to obtain the full CPI trace (no additional round-trip — simulation is already the final verification step). The RPC may return inner instructions in either `jsonParsed` or compiled (base58) format; both are handled.
6. **Match exactly one transfer** (§1.4): across top-level and inner instructions, exactly one `TransferChecked` MUST match the required mint, destination ATA (derived for both token programs), and amount (`>=` required). The fee payer / sponsor MUST NOT be the authority on any observed transfer (self-spend protection).

### 3.3 Path Selection (Path 1 → Path 2)

Path 2 runs **only** when Path 1 rejects for a *recoverable layout reason* — i.e. the verifier could not structurally understand the transaction (wrong instruction count, unknown or extra instructions, missing positional transfer). These reasons are tracked in an explicit recoverable-reason set.

Semantic failures — amount mismatch, mint mismatch, recipient mismatch, memo count/mismatch, self-spend, or a failed Path 1 simulation — return their real reason and MUST NOT fall through to Path 2. This prevents a legitimate semantic rejection from being masked behind a misleading `smart_wallet_*` error code. (A transaction that fails Path 1 simulation would fail Path 2 simulation too, so there is nothing to recover.)

The `verify` and `settle` entry points share a single internal `_verify` returning the result plus which path verified (`static` vs `smartWallet`), so `settle` applies the correct post-settlement policy without re-deriving the path.

### 3.4 Post-Settlement Verification (TOCTOU defense)

Simulation proves a transaction *would* succeed but is not proof it *did* (a malicious program could behave differently at execution time). For smart-wallet (Path 2) settlements, after the transaction confirms the sponsor MUST verify the transfer actually executed on-chain:

- **Primary**: fetch the confirmed transaction's inner instructions (`getConfirmedTransactionInnerInstructions`, with bounded retry for RPC indexing lag) and confirm exactly one matching `TransferChecked`.
- **Fallback**: if inner instructions are unavailable (indexing lag), check the destination ATA balance delta (`balanceAfter - balanceBefore >= required`), trying both SPL Token and Token-2022 programs.

Settlement success MUST reflect actual on-chain effects, not simulation alone.

---

## 4. Security Invariants

The verification model upholds the following invariants:

| # | Invariant | How it is enforced |
|---|-----------|--------------------|
| I1 | **No token loss** | Fee payer never used as authority/source/delegate on any token operation; enforced *before signing* (§2.1.1, §2.1.3). |
| I2 | **Bounded SOL exposure** | Per-transaction cost capped via compute budget limits (§2.2.1). |
| I3 | **Merchant truth** | Settlement success returned only after confirming actual on-chain effects, not simulation (§3.4). |
| I4 | **Payment landed** | Exactly one confirmed `TransferChecked` matches the required amount, mint, and destination ATA (§1.4). |
| I5 | **Simulation is non-critical** | Simulation saves fees; security comes from I1 (pre-sign) and I3 (post-settle) (§2.2.3, §3.4). |
| I6 | **No hidden accounts** | ALTs resolved so every reachable account is visible to verification (§2.1.2). |
| I7 | **Known programs only** | Only allowlisted wallet programs reach simulation-based verification (§2.2.2). |

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
