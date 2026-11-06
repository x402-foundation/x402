# @x402/cardano

x402 Payment Protocol — Cardano `exact` scheme implementation.

This package implements the [`exact` scheme on Cardano](../../../../specs/schemes/exact/scheme_exact_cardano.md) for the x402 protocol. It provides:

- A **client scheme** (`@x402/cardano/exact/client`) that delegates transaction signing to a user-supplied `ClientCardanoSigner`. The client signs but never broadcasts.
- A **facilitator scheme** (`@x402/cardano/exact/facilitator`) that verifies the signed transaction per the spec's verification rules, broadcasts it, and reports settlement evidence.
- A **server scheme** (`@x402/cardano/exact/server`) that parses prices (`"$0.10"` and `"0.10 USDM"` resolve to the network's USDM from `DEFAULT_ASSETS`), declares the `authorization` payment flow for every asset transfer method, enhances payment requirements, and can issue Masumi quotes.
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

// Facilitator (verify + broadcast + confirm). Works out of the box against a
// Blockfrost or Koios provider; see "Phase-1 checks" and "Duplicate settlement guard".
const facilitatorSigner = toFacilitatorCardanoSigner({
  network: "cardano:preprod",
  provider,
  // Return on broadcast; the scheme polls for the confirmation policy's evidence.
  awaitConfirmation: false,
});
facilitator.register("cardano:preprod", new ExactCardanoFacilitator(facilitatorSigner));
```

The facilitator only broadcasts the client's signed transaction, so its `mnemonic` is **optional** — omit it to run provider-only (no funds, no signer); when supplied it is used only to expose an address in the `/supported` response. The reference signer also implements the optional `evaluateTransaction` script dry-run and `getProtocolParameters`. A Koios provider (`{ koios: { baseUrl, token? } }`) may be used instead of Blockfrost; without Blockfrost the signer has no `getTransactionEvidence`, so `/supported` advertises an `l1Confirmations` maximum of `0` and the facilitator can only settle `0` (with the default `awaitConfirmation: true`, which the signer then requires, and a `provider.requestTimeoutMs` long enough to cover block inclusion, since that wait is bounded by it) or `-1`. Routes served by such a facilitator must set `extra.confirmationPolicy` explicitly — the spec default of `1` lies outside the advertised range, and the server scheme refuses to build the 402. `provider.requestTimeoutMs` bounds every reference-signer provider query, build, submission, evaluation and confirmation wait; it defaults to 10 seconds.

## Testnet funds

Get test ADA (tADA) for `cardano:preprod` or `cardano:preview` from the official
[Cardano testnets faucet](https://docs.cardano.org/cardano-testnets/tools/faucet/). Only the
**client** needs funds: it builds and signs the complete transaction, so its wallet must hold the
asset it pays with plus a little ADA for the network fee. The **facilitator** only broadcasts that
signed transaction — it pays no fee and needs no funds. `asset: "lovelace"` is fundable directly
from the faucet; preprod **tUSDM** (the USDM test token) comes from the
[tUSDM faucet](https://tusdm.moneta.global).

## Asset transfer methods

Per spec, three methods can be selected via `requirements.extra.assetTransferMethod`:

- `default` — address-to-address payments. No extra verification beyond the core rules.
- `masumi` — locks funds into Masumi's `vested_pay` escrow for **concrete agent-to-agent payments**. A route declares a *template* — `extra: { assetTransferMethod: "masumi" }` with the escrow address as `payTo` — and `ExactCardanoScheme({ masumi })` issues a fresh seller-signed quote per 402 and answers the paid retry with the quote it issued (see [Masumi quotes](#masumi-quotes)). Issuing outside the scheme with `issueMasumiRequirements` remains possible. The client and facilitator both re-verify the seller authorization, and the facilitator additionally checks the 19-field lock datum (`verifyMasumiLock`).
- `script` — locks funds into **any contract defined by the server**, with an optional arbitrary datum. The base facilitator reconstructs the script address from `extra.script`/`parameters` (or `scriptHash`) and verifies it equals `requirements.payTo`. Supply `extra.datum` (CBOR hex) to attach an inline datum for contracts that require one — the client attaches it verbatim; because the datum is arbitrary and contract-specific, the facilitator does **not** verify its contents, so a correct datum is the server's responsibility (a wrong or missing one strands the funds). Use this to lock into your own contract; use `masumi` for agent payments.

Overriding `runMethodSpecificChecks` is **not** required for any built-in method; if you subclass to add a custom method, call `super.runMethodSpecificChecks(...)` so the Masumi and script checks still run.

## Confirmation policy

Every method uses the `authorization` flow: the client signs a transaction and hands it over unbroadcast, the facilitator verifies it, the resource handler runs, and `settle()` broadcasts the exact signed bytes. The client never submits.

`requirements.extra.confirmationPolicy.l1Confirmations` sets the evidence required before `settle()` reports success: `-1` the facilitator's own broadcast acceptance, `0` canonical block inclusion, `1..20` that many newer blocks. It defaults to `1`. `/supported` advertises the range a facilitator can settle (`l1Confirmations: { minimum, maximum }`): the minimum is `-1` only when the operator set `acceptMempool`, and the maximum is `0` when the signer has no `getTransactionEvidence` hook to read canonical depth.

## Settlement and `settlement_pending`

`settle()` broadcasts, then waits — bounded by `confirmationTimeoutMs`, default 75s — for evidence that meets the policy. Below the threshold it returns the non-terminal

```json
{ "success": false, "errorReason": "settlement_pending", "transaction": "<tx id>", "extra": { "status": "pending", "transactionId": "<tx id>", "confirmations": 0 } }
```

`extra.confirmations` appears once the transaction has been observed (`-1` in the mempool, `0` or more once included); it is absent while the provider cannot see the broadcast transaction yet.

`@x402/core`'s resource server retries `settle()` exactly once with the same payload; the facilitator recognizes the transaction it already broadcast, never submits it again, and resumes waiting. Keep `confirmationTimeoutMs` below the resource server's facilitator-client timeout (`@x402/core` defaults to 90s); the payment then has roughly twice that budget to confirm. Once a transaction's validity window has closed, plus a short indexing grace, without the ledger ever recording it, the facilitator reports a terminal `exact_cardano_settlement_failed` instead.

Cardano uses Ouroboros Praos (probabilistic finality). `settle()` reports the strongest verified evidence in `extra` (`status`, `confirmations`). Granting access on `mempool` is **strongly discouraged** by the spec, so the facilitator refuses a mempool-only result unless the operator sets `acceptMempool` *and* the policy allows `-1`.

## Phase-1 checks

`verify()` rejects, before the resource handler runs, every transaction the ledger would refuse that it can detect from provider data: inputs spent, validity interval out of range, min-UTXO not met, value not conserved (inputs must equal outputs plus fee, per asset), and a fee below the protocol floor `minFeeB + minFeeA × size`. Value conservation uses the input values `getUtxo` returns; the fee floor and min-UTXO use `getProtocolParameters`. A transaction that mints, withdraws rewards, or carries certificates or governance deposits moves value the inputs do not show and is rejected — unless the signer supplies the optional `validatePhase1Transaction`, a complete ledger phase-1 validator for operators who run their own node. That hook always runs on top of the built-in checks; it is not required for a standard Blockfrost or Koios setup.

The optional `evaluateTransaction(signedTransactionBase64, network)` hook is narrower: it dry-runs Plutus execution and does not prove value conservation or input authorization. Typical implementations route it to a Cardano node `evaluate-tx` endpoint or Blockfrost's `/utils/txs/evaluate`.

## Duplicate settlement guard

`settle()` is keyed by the canonical Cardano transaction ID: one transaction is **broadcast at most once**, a concurrent second call for the same transaction is refused with `duplicate_settlement`, and a retry for a transaction already broadcast resumes observation instead of submitting again. A definitive pre-ledger rejection is terminal for that transaction: the facilitator keeps its tombstone and the Masumi `termsDigest` binding, so corrected bytes for the same quote are not accepted afterwards.

The guard defaults to a bounded process-local `InMemoryCardanoSettlementStore` (4096 entries; when full it evicts the oldest claim that is no longer mid-submission, so a very busy facilitator could forget a still-pending payment before its retry arrives — size it for your throughput). That is right for a single facilitator process. A deployment running several replicas without session affinity should supply a shared, atomically updating `CardanoSettlementStore` (Redis/Valkey, SQL, …) so a retry landing on another replica still resumes the same transaction:

```ts
import { ExactCardanoScheme } from "@x402/cardano/exact/facilitator";

// Single process: the default store.
facilitator.register("cardano:preprod", new ExactCardanoScheme(signer));

// Several replicas: share one durable store.
facilitator.register("cardano:preprod", new ExactCardanoScheme(signer, { settlementStore: myRedisStore }));
```

## Masumi quotes

A Masumi 402 is a seller-signed offer: `termsDigest` covers exactly one issued quote (each carries a fresh `sellerNonce`), and the buyer's transaction locks against it. The resource-server scheme both issues those quotes and holds the paid retry to them.

```ts
import { ExactCardanoScheme } from "@x402/cardano/exact/server";
import { masumiEscrowAddress, toMasumiSellerSigner } from "@x402/cardano";

const seller = toMasumiSellerSigner({ mnemonic: process.env.SELLER_MNEMONIC!, network: "cardano:preprod" });
server.register("cardano:*", new ExactCardanoScheme({ masumi: { seller } }));

// The route is a template: the method and the escrow address. The scheme signs
// a fresh quote for every 402 and matches the paid retry back to it.
app.use(paymentMiddleware({
  "GET /jobs/weather": {
    accepts: {
      scheme: "exact",
      network: "cardano:preprod",
      payTo: masumiEscrowAddress("cardano:preprod"),
      price: { amount: "5000000", asset: "lovelace" },
      maxTimeoutSeconds: 600,
      extra: { assetTransferMethod: "masumi" },
    },
  },
}, server));
```

- `enrichPaymentRequiredResponse` replaces a template with a quote — on an unpaid request a freshly issued one, on a paid retry the stored quote the payload's `accepted` names (read from `paymentPayload`, the HTTP `PAYMENT-SIGNATURE` header, or MCP `_meta["x402/payment"]`) when it still fits the route — and persists every served quote under its `termsDigest`. The first 402 for a digest wins, so a later response cannot rotate what a buyer was quoted. `payByTime` is `now + maxTimeoutSeconds`; the later deadlines follow `masumi.deadlines` (15, 35 and 55 minutes after `payByTime` by default). The request commitment defaults to the resource URL; a job endpoint that takes parameters supplies `masumi.commitment` to bind them.
- `onAfterVerify` recomputes the digest from `payload.accepted`, rejects a quote this server never issued (`masumi_terms_unknown`) or one whose requirements were altered (`masumi_terms_mismatch`), and binds the first transaction to claim it. A different transaction for the same terms is refused (`duplicate_settlement`); the same transaction may retry, which is what the pending-settlement flow needs.

`default` and `script` payments never touch this store — they carry no server-issued terms, and binding a settled transaction to a single protected operation is the integrating server's concern, exactly as for the other exact schemes.

Core invokes `enrichPaymentRequiredResponse` once per accept without saying which accept invoked it, and only that accept may gain `extra` keys, so a route carrying a Masumi template must offer a single Cardano network. Every unpaid 402 issues (and signs) a fresh quote, so rate-limit anonymous Masumi routes; the quote store is bounded and evicts the oldest quote first, which turns a buyer's late paid retry into `masumi_terms_unknown`. Quotes live in `masumiStorage`, a process-local `InMemoryMasumiTermsStorage` by default; production shares one durable, atomically-updating `MasumiTermsStorage` across workers (`new ExactCardanoScheme({ masumi, masumiStorage: myRedisTermsStorage })`). `MasumiTermsStorage` mirrors the batch-settlement `ChannelStorage` contract: `updateTerms(termsDigest, current => next)` must apply the callback atomically for every instance sharing the backend; `InMemoryMasumiTermsStorage` only guarantees that inside one JS runtime, and evicts the oldest quote past `maxEntries`.

## Relationship to `masumi-payment-service`

The `masumi` method locks into the **real** deployed `vested_pay` V2 escrow: the compiled validator is taken verbatim from `masumi-payment-service`, and `payTo` is re-derived from the deployment parameters, so the canonical addresses match Masumi's own `PAYMENT_SMART_CONTRACT_ADDRESS_V2_*` exactly. The 19-field datum, the `collateral_return_lovelace` floor, the post-`SubmitResult` min-UTxO headroom, the deadline minimums and the `blockchainIdentifier` encoding all follow Masumi's rules, so a lock issued here is locatable and structurally valid on chain.

The **seller authorization does not**. `reference_signature` here is a CIP-8 signature over this scheme's `termsDigest` (`SHA-256("masumi:x402:terms:v1\n" || JCS(signedTerms))`). `masumi-payment-service` verifies the same datum field against a signature over `SHA-256(stableStringify(signedBlockchainIdentifierPayload))` — a different payload entirely. The divergence is deliberate: `termsDigest` covers the exact issued 402 and is what binds a payment to one protected operation, which is the whole basis of this package's replay guarantees. Signing Masumi's payload instead would break that binding.

The consequence is concrete and worth stating plainly: **a lock created by this package cannot be driven through a `masumi-payment-service` node.** Masumi tooling can decode the `blockchainIdentifier` and find the UTxO, but its purchase-init check will reject the signature, so result submission, refunds and dispute resolution must be driven by x402-aware tooling holding the seller key. Use the `masumi` method when you want the escrow's guarantees inside an x402 flow — not as a transport into an existing Masumi deployment.

Two smaller asymmetries follow from the same split. This package requires `lockedLovelace == requestedLovelace + collateral_return_lovelace` **exactly**, where Masumi tolerates lovelace overpayment; a Masumi-built transaction that rounds up to min-UTxO therefore will not satisfy an x402 402. And datum addresses are restricted to enterprise key addresses and base addresses whose payment *and* stake credentials are both key hashes — Masumi's `getPubKeyAddressDatum` accepts nothing else, and a script stake credential or pointer address would leave the escrow unspendable by its tooling.

## Masumi registry claims

A non-empty `terms.agentIdentifier` claims a Masumi V2 registry identity. The policy prefix alone proves nothing — anyone can copy a registered agent's identifier into their own terms — so such a claim is **rejected** unless you supply a `validateRegistryClaim` validator (on the facilitator config and, for the client, `validateMasumiRegistryClaim`) that independently checks the asset, seller authorization, metadata, endpoint, network and price on the selected network. Unregistered sellers (an absent, `null` or empty identifier) need no validator.

See `specs/schemes/exact/scheme_exact_cardano.md` for the full protocol description.
