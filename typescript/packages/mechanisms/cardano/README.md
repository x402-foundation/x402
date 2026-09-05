# @x402/cardano

x402 Payment Protocol — Cardano `exact` scheme implementation.

This package implements the [`exact` scheme on Cardano](../../../../specs/schemes/exact/scheme_exact_cardano.md) for the x402 protocol. It provides:

- A **client scheme** (`@x402/cardano/exact/client`) that delegates transaction signing to a user-supplied `ClientCardanoSigner`.
- A **facilitator scheme** (`@x402/cardano/exact/facilitator`) that verifies and settles transactions per the spec's six verification rules.
- A **server scheme** (`@x402/cardano/exact/server`) that parses prices (`"$0.10"` and `"0.10 USDM"` resolve to the network's USDM from `DEFAULT_ASSETS`), declares the `authorization` payment flow for every asset transfer method, and enhances payment requirements.
- A **default-asset table** (`DEFAULT_ASSETS`, `getDefaultAsset`, `findDefaultAsset`) listing USDM on mainnet and preprod. The client scheme exposes `findDefaultAsset`, so `x402Client`'s default spend controls accept USDM under the `$1` cap; `lovelace` is not USD-pegged and needs `spendControls.allowedAssets` (or `spendControls: false`) on the client.

## Networks

The implementation registers the following x402 network identifiers, matching the spec verbatim:

| Network         | Identifier        | Cardano Network ID |
| --------------- | ----------------- | ------------------ |
| Mainnet         | `cardano:mainnet` | 1                  |
| Preprod testnet | `cardano:preprod` | 0                  |
| Preview testnet | `cardano:preview` | 0                  |

These identifiers are deliberately human-readable and match the x402 Cardano spec; they are not canonical CAIP-2 (no registered `cardano` namespace exists). The CIP-34 forms `cip34:1-764824073` (mainnet), `cip34:0-1` (preprod), and `cip34:0-2` (preview) are accepted as input aliases and normalized to the canonical id above.

## Asset format

Cardano native tokens are identified as `${policyId}.${assetNameHex}`, e.g. USDM Mainnet:

```
c48cbb3d5e57ed56e276bc45f99ab39abe94e6cd7ac39fb402da47ad.0014df105553444d
```

## Transaction decoding

CBOR transaction decoding in the facilitator uses Intersect's [Evolution SDK](https://www.npmjs.com/package/@evolution-sdk/evolution) — a pure-TypeScript Cardano serialization library with no WASM. It is bundled as a regular dependency; nothing extra to install.

## Reference signers

The client and facilitator schemes are signer-agnostic (e.g. a browser wallet can implement `ClientCardanoSigner` via CIP-30). For server-side keys, the package ships reference signers built on the Evolution SDK — `toClientCardanoSigner` builds, signs, and returns the payment transaction; `toFacilitatorCardanoSigner` performs chain lookups and submission.

```typescript
import { toClientCardanoSigner, toFacilitatorCardanoSigner } from "@x402/cardano";
import { ExactCardanoScheme as ExactCardanoClient } from "@x402/cardano/exact/client";
import { ExactCardanoScheme as ExactCardanoFacilitator } from "@x402/cardano/exact/facilitator";

const provider = { blockfrost: { baseUrl: process.env.BLOCKFROST_PREPROD_URL!, projectId: process.env.BLOCKFROST_PROJECT_ID! } };

// Client (payer)
const clientSigner = toClientCardanoSigner({ mnemonic, network: "cardano:preprod", provider });
client.register("cardano:*", new ExactCardanoClient(clientSigner));

// Facilitator (verify + settle). Supply a complete ledger phase-1 validator
// for the default server-submission mode and durable shared settlement state.
const facilitatorSigner = toFacilitatorCardanoSigner({
  network: "cardano:preprod",
  provider,
  awaitConfirmation: true,
  validatePhase1Transaction: ledgerValidator.validatePhase1Transaction,
});
facilitator.register(
  "cardano:preprod",
  new ExactCardanoFacilitator(facilitatorSigner, { settlementStore }),
);
```

The facilitator only broadcasts the client's signed transaction, so its `mnemonic` is **optional** — omit it to run provider-only (no funds, no signer); when supplied it is used only to expose an address in the `/supported` response. `settlementStore` must be an atomic durable `CardanoSettlementStore` shared by every facilitator worker. The reference signer also implements the optional `evaluateTransaction` script dry-run. A Koios provider (`{ koios: { baseUrl, token? } }`) may be used instead of Blockfrost. `provider.requestTimeoutMs` bounds every reference-signer provider query, build, submission, evaluation and confirmation wait; it defaults to 10 seconds.

## Testnet funds

Get test ADA (tADA) for `cardano:preprod` or `cardano:preview` from the official
[Cardano testnets faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/). Only the
**client** needs funds: it builds and signs the complete transaction, so its wallet must hold the
asset it pays with plus a little ADA for the network fee. The **facilitator** only broadcasts that
signed transaction — it pays no fee and needs no funds. `asset: "lovelace"` is fundable directly
from the faucet; preprod **USDM** must be sourced separately, so use lovelace for quick live testing.

## Asset transfer methods

Per spec, three methods can be selected via `requirements.extra.assetTransferMethod`:

- `default` — address-to-address payments. No extra verification beyond the core rules.
- `masumi` — locks funds into Masumi's `vested_pay` escrow for **concrete agent-to-agent payments**. Issue the 402 with `issueMasumiRequirements` (it derives `payTo` from the deployment parameters, builds the request commitment and gets the seller's CIP-8 signature over `termsDigest`); the client and facilitator both re-verify that authorization, and the facilitator additionally checks the 19-field lock datum (`verifyMasumiLock`). No subclassing is required.
- `script` — locks funds into **any contract defined by the server**, with an optional arbitrary datum. The base facilitator reconstructs the script address from `extra.script`/`parameters` (or `scriptHash`) and verifies it equals `requirements.payTo`. Supply `extra.datum` (CBOR hex) to attach an inline datum for contracts that require one — the client attaches it verbatim; because the datum is arbitrary and contract-specific, the facilitator does **not** verify its contents, so a correct datum is the server's responsibility (a wrong or missing one strands the funds). Use this to lock into your own contract; use `masumi` for agent payments.

Overriding `runMethodSpecificChecks` is **not** required for any built-in method; if you subclass to add a custom method, call `super.runMethodSpecificChecks(...)` so the Masumi and script checks still run.

## Submission and confirmation policy

`requirements.extra.submissionPolicy` selects who broadcasts: `server` (the default when absent), `client`, or `either`. The paid payload echoes the normalized `submissionMode`, which must be allowed by the policy and must stay the same across retries for one transaction. Server mode requires a complete ledger phase-1 validator through `validatePhase1Transaction`; script evaluation alone is not enough. Client mode requires `getTransactionEvidence`, because the client broadcasts before the paid retry and the facilitator must authenticate that exact transaction. `/supported` advertises only modes for which these hooks exist.

`requirements.extra.confirmationPolicy.l1Confirmations` sets the evidence required before `settle()` reports success: `-1` authenticated mempool acceptance, `0` canonical block inclusion, `1..20` that many newer blocks. It defaults to `1`. Below the threshold, `settle()` returns `errorReason: "payment_pending"` with the strongest evidence in `extra`; the paid retry resumes observing the same transaction without resubmitting it.

Hydra settlement is **not implemented**: a `settlementLayer: "hydra"` payload is rejected and `/supported` advertises L1 only. Authenticating a Hydra payment needs verified Init state, head parameters, a seller-participant binding and `SnapshotConfirmed` evidence.

## Idempotency boundary

`settle()` is idempotent per canonical transaction ID, not one-shot. The spec requires a paid retry to repeat the exact original `PAYMENT-SIGNATURE` and the verifier to resume observing the same transaction, so a terminal "already settled" state would strand any payment that needs more confirmations than a single call can wait for. What this package guarantees is that a given transaction is **broadcast at most once** and always reports the same ledger truth.

A definitive pre-ledger rejection is terminal for that issued payment: the facilitator retains both the transaction and Masumi `termsDigest` tombstones. It does not accept corrected transaction bytes afterwards, and ambiguous transport or node failures remain non-releasable for the same reason.

Facilitators must supply an atomic durable `CardanoSettlementStore`. The process-local store is available through explicit configuration for tests and disposable development; it stops at its configured entry limit and must not be used in production.

## Masumi quote storage

A Masumi 402 is a seller-signed offer: `termsDigest` covers exactly one issued quote (each carries a fresh `sellerNonce`), and the buyer's transaction locks against it. The resource-server scheme therefore persists every Masumi 402 it serves and holds the paid retry to that record:

- `enrichPaymentRequiredResponse` stores the issued requirements under their `termsDigest`. The first 402 for a digest wins, so a later response cannot rotate what a buyer was quoted.
- `onAfterVerify` recomputes the digest from `payload.accepted`, rejects a quote this server never issued (`masumi_terms_unknown`) or one whose requirements were altered (`masumi_terms_mismatch`), and binds the first transaction to claim it. A different transaction for the same terms is refused (`duplicate_settlement`); the same transaction may retry, which is what the spec's pending-confirmation flow needs.

`default` and `script` payments never touch this store — they carry no server-issued terms, and binding a settled transaction to a single protected operation is the integrating server's concern, exactly as for the other exact schemes.

```ts
import { ExactCardanoScheme } from "@x402/cardano/exact/server";

// Process-local store: fine for tests and single-process development.
server.register("cardano:*", new ExactCardanoScheme());

// Production: share one durable, atomically-updating store across workers.
server.register("cardano:*", new ExactCardanoScheme({ masumiStorage: myRedisTermsStorage }));
```

`MasumiTermsStorage` mirrors the batch-settlement `ChannelStorage` contract: `updateTerms(termsDigest, current => next)` must apply the callback atomically for every instance sharing the backend. `InMemoryMasumiTermsStorage` only guarantees that inside one JS runtime, and evicts the oldest quote past `maxEntries`.

## Relationship to `masumi-payment-service`

The `masumi` method locks into the **real** deployed `vested_pay` V2 escrow: the compiled validator is taken verbatim from `masumi-payment-service`, and `payTo` is re-derived from the deployment parameters, so the canonical addresses match Masumi's own `PAYMENT_SMART_CONTRACT_ADDRESS_V2_*` exactly. The 19-field datum, the `collateral_return_lovelace` floor, the post-`SubmitResult` min-UTxO headroom, the deadline minimums and the `blockchainIdentifier` encoding all follow Masumi's rules, so a lock issued here is locatable and structurally valid on chain.

The **seller authorization does not**. `reference_signature` here is a CIP-8 signature over this scheme's `termsDigest` (`SHA-256("masumi:x402:terms:v1\n" || JCS(signedTerms))`). `masumi-payment-service` verifies the same datum field against a signature over `SHA-256(stableStringify(signedBlockchainIdentifierPayload))` — a different payload entirely. The divergence is deliberate: `termsDigest` covers the exact issued 402 and is what binds a payment to one protected operation, which is the whole basis of this package's replay and idempotency guarantees. Signing Masumi's payload instead would break that binding.

The consequence is concrete and worth stating plainly: **a lock created by this package cannot be driven through a `masumi-payment-service` node.** Masumi tooling can decode the `blockchainIdentifier` and find the UTxO, but its purchase-init check will reject the signature, so result submission, refunds and dispute resolution must be driven by x402-aware tooling holding the seller key. Use the `masumi` method when you want the escrow's guarantees inside an x402 flow — not as a transport into an existing Masumi deployment.

Two smaller asymmetries follow from the same split. This package requires `lockedLovelace == requestedLovelace + collateral_return_lovelace` **exactly**, where Masumi tolerates lovelace overpayment; a Masumi-built transaction that rounds up to min-UTxO therefore will not satisfy an x402 402. And datum addresses are restricted to enterprise key addresses and base addresses whose payment *and* stake credentials are both key hashes — Masumi's `getPubKeyAddressDatum` accepts nothing else, and a script stake credential or pointer address would leave the escrow unspendable by its tooling.

## Masumi registry claims

A non-empty `terms.agentIdentifier` claims a Masumi V2 registry identity. The policy prefix alone proves nothing — anyone can copy a registered agent's identifier into their own terms — so such a claim is **rejected** unless you supply a `validateRegistryClaim` validator (on the facilitator config and, for the client, `validateMasumiRegistryClaim`) that independently checks the asset, seller authorization, metadata, endpoint, network and price on the selected network. Unregistered sellers (an absent, `null` or empty identifier) need no validator.

## Settlement status

Cardano uses Ouroboros Praos (probabilistic finality). `settle()` reports the strongest verified evidence in `extra` (`status`, `confirmations`, `submissionMode`). Granting access on `mempool` is **strongly discouraged** by the spec, so the facilitator refuses a mempool-only result unless the operator sets `acceptMempool` *and* the policy allows `-1`.

## Script evaluation

Server submission requires `validatePhase1Transaction`, which must apply the complete Cardano phase-1 ledger rules to the exact signed transaction. The optional `evaluateTransaction(signedTransactionBase64, network)` hook is narrower: it dry-runs Plutus execution and does not prove value conservation or input authorization. Typical implementations route it to a Cardano node `evaluate-tx` endpoint or Blockfrost's `/utils/txs/evaluate`.

See `specs/schemes/exact/scheme_exact_cardano.md` for the full protocol description.
