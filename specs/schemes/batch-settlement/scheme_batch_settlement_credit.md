# Scheme: `batch-settlement` `credit`

## Summary

The `batch-settlement` scheme on a `credit` network binding enables access to general API resources through pre-purchased fiat credit bundles. The client purchases credits from a **bundle authority** through a PSP (Stripe, Adyen, or any fiat rail), then presents a short-lived signed **attestation** per request. The authority atomically decrements the bundle balance at authorization time; settlement to the resource server happens later through off-chain financial rails on a defined schedule.

**The bundle authority is the facilitator for this binding.** It exposes the standard x402 facilitator endpoints (`/verify`, `/settle`) toward resource servers, plus one binding-specific client-facing endpoint (`/authorize`) that issues attestations. No parallel server↔authority interface is introduced; existing x402 server middleware that knows how to call a facilitator works unchanged.

**Network Identifier**: `<authority>:credit` (e.g. `acme:credit`)
**Trust Model**: Credit-backed (see [scheme_batch_settlement.md](./scheme_batch_settlement.md#credit-backed))

This binding fills the gap between the two existing `batch-settlement` bindings:

- [`cloudflare:402`](./scheme_batch_settlement_cloudflare.md) is credit-backed but purpose-built for content monetisation via crawler-identity infrastructure (HTTP Message Signatures, `.well-known` key directories). Its registration and auth flow do not translate to general REST API routes.
- [`EVM`](./scheme_batch_settlement_evm.md) covers general API monetisation but is capital-backed: it requires onchain deposits and wallet infrastructure from the client.

The `credit` binding targets the remaining cell: **general API monetisation with no onchain capital requirement** — AI agents and corporate clients paying for API access through standard fiat billing.

The scheme supports **dynamic pricing**: the client authorizes a maximum per request (`PaymentRequirements.amount`), and the server charges the actual cost within that ceiling, communicated via `PAYMENT-RESPONSE`.

## Design choice: central authorization vs local signing

This binding deliberately diverges from the EVM binding's locally-signed cumulative vouchers. There, the client signs vouchers offline with zero extra round trips, and the onchain channel guarantees the server can claim what was signed. That model is optimal for throughput but provides no hard cross-merchant budget cap: a client signing locally can oversign across many merchants in parallel, and no single party sees the cumulative total until settlement.

The `credit` binding makes the opposite trade. Every authorization is an atomic decrement against a single authority, which means:

- A budget cap (e.g. an agent's spending mandate) is enforced **before** spend, across all merchants drawing on the same bundle, with no read-modify-write race.
- The cost is one client→authority round trip per request. (The server→facilitator `/verify` and `/settle` calls are the standard x402 server flow, not an additional burden of this binding, and `/settle` MAY be deferred; see [Settlement timing](#settlement-timing).)

For high-frequency sub-cent calls where throughput dominates and the client is trusted with its own budget, the EVM binding is the better fit. For agentic clients operating under a principal's spending cap — where overspend is a liability question, not a performance question — pre-spend atomic enforcement is the point of the binding. Implementations MAY amortize the client round trip by authorizing a batch ceiling in one call where the use case tolerates it.

## Roles

- **Client** — an agent or application consuming paid API resources.
- **Resource Server** — the API being monetised.
- **Bundle Authority** — the facilitator for this binding. Sells credit bundles, holds balances, issues attestations via `/authorize`, verifies payments via `/verify`, accepts charge settlement via `/settle`, and settles with the resource server through the PSP rail. The authority may be operated by the resource server itself or by a third party.
- **PSP** — the payment service provider (Stripe, Adyen, etc.) through which bundles are purchased. The PSP is invisible to the x402 protocol; only the authority interacts with it.

## Scope

The x402-visible surface of this binding is a single payload type: `consume`. Bundle lifecycle operations — purchase, top-up, and refund of unused credits — are client↔authority operations outside the x402 exchange, reachable from the `extra.purchaseUrl` in the `402` response. The server↔authority surface is the standard facilitator interface with binding-specific semantics specified below; the only novel endpoint is the client-facing `/authorize`.

## Authority identity and trust binding

Two identifiers refer to the authority; the spec binds them as follows:

- **`extra.authority`** (a URL origin, e.g. `https://credits.acme.com`) is the trust anchor. It is the facilitator base URL, the key-discovery origin, and the attestation `iss` claim MUST equal it exactly.
- **The `network` namespace** (e.g. `acme` in `acme:credit`) is a display and routing label. To avoid collisions, the namespace SHOULD be derived from the authority's registrable domain (e.g. `credits.acme.com` → `acme`). The resource server's declaration of `extra.authority` in the `accepts` entry is what binds the label to an origin for that resource.

Clients and servers MUST anchor trust decisions to the `extra.authority` origin, never to the namespace label. A server lists an `accepts` entry for an authority precisely when it has a settlement relationship with that origin; a client buys credits from that origin precisely when it is willing to fund requests against servers that accept it.

## Credits denomination

Credits are denominated in the smallest unit of the bundle's `asset` (e.g. cents for USD). A bundle balance of `8420` with `asset: "USD"` is $84.20 of spending power. Purchase tiers MAY grant more credits than the purchase price (a volume bonus): `{ "credits": "10000", "price": "9000" }` means pay $90.00, receive $100.00 of credit. Attestation `amount`, `chargedAmount`, and `bundleState.balance` are all in the same unit; there is no separate abstract credit unit.

## Protocol Flow

### First-time setup (Client)

1. Client receives a `402` with the `credit` binding in `accepts` and `extra.purchaseUrl`.
2. Client (or the human principal behind it) completes a PSP-hosted checkout at `purchaseUrl`, purchasing a credit bundle tier.
3. The authority issues the client a long-lived **bundle credential** (out of band — API key, OAuth client, or signed credential per the authority's account model).
4. For autonomous top-ups, the principal may additionally establish a PSP off-session mandate during checkout, letting the agent top up the bundle through the authority's API without further human interaction.

### Payment flow (per request)

1. Client calls the authority's [`/authorize`](#post-authorize-client-facing) endpoint. The authority **atomically decrements** the bundle balance and returns a signed attestation in the same call, or rejects with `insufficient_credits`. There is no read-only balance query that is safe to act on; the idempotency key makes retries of the same logical request safe against double-decrement.
2. Client sends the HTTP request with the payment payload (type `consume`) carrying the attestation.
3. Resource server verifies the payment — via facilitator [`/verify`](#post-verify-standard-facilitator-endpoint), or locally by signature check (see [Verification](#verification)).
4. On success, the server serves the resource and returns `PAYMENT-RESPONSE` with the actual charged amount and a bundle state snapshot.
5. The server settles the actual charge via facilitator [`/settle`](#post-settle-standard-facilitator-endpoint) — synchronously before responding, or deferred within the hold window. The difference between authorized and charged amounts is re-credited to the bundle. If fulfillment fails, the server settles with `amount: "0"` (release the full hold) or lets the hold lapse at `holdExp`.
6. The authority settles accumulated charges with the resource server on a billing cycle through the PSP rail.

Clients holding a valid attestation may include the payment payload in their initial request, bypassing the `402` negotiation (same pre-authorized pattern as `cloudflare:402`).

### Settlement timing

The attestation carries two windows:

- **`exp`** — the presentation window (short: minutes). After `exp`, the resource server MUST reject the attestation. This bounds the replay surface.
- **`holdExp`** — the settlement window, sized to the settlement mode (see below). Until `holdExp`, the authority MUST hold the authorized funds and MUST accept a `/settle` for this attestation. After `holdExp`, an unsettled hold is released back to the bundle and `/settle` fails with `hold_expired`. `holdExp` is a *ceiling*, not a fixed lock: a hold is released as soon as `/settle` arrives, so the window only binds when settlement does not happen — its practical role is to bound how long funds stay reserved if the server never settles.

This gives servers a choice of payment-guarantee model, made explicit rather than left ambiguous:

- **Synchronous settle** — the server settles before returning `200`. Zero merchant risk; the standard x402 middleware flow. Here `holdExp` SHOULD be **short** (minutes): the hold is released at settle, so a long window only serves as the failure-reclaim bound if the server crashes between authorize and settle. A short window returns funds to the bundle quickly in that case (peage's fiat escrow uses a 900s default for exactly this synchronous shape — see [#2612 discussion](https://github.com/x402-foundation/x402/pull/2612)).
- **Deferred settle** — the server responds immediately after verification (the hold guarantees the funds exist and are reserved) and settles in the background, retrying on transient failure until `holdExp`. Merchant risk is bounded: it is exactly the probability of the server failing to deliver one idempotent HTTP call within the hold window. Here `holdExp` MUST be generous enough to make this negligible (RECOMMENDED minimum: 24 hours after `exp`).

The `holdExp` window is therefore **mode-specific, not a flat minimum**: short for synchronous settle (bound the failure-reclaim window), long for deferred settle (cover the background-retry horizon). Authorities and servers SHOULD choose it per the settlement mode in use.

Servers MUST NOT serve the resource before verifying the attestation; the choice above concerns only when settlement happens relative to the response.

## Facilitator interface

The authority exposes the standard x402 facilitator endpoints with the following binding-specific semantics, plus one client-facing endpoint. Transport is HTTPS + JSON.

### `POST /authorize` (client-facing)

Authenticated with the client's bundle credential. This is the one binding-specific endpoint added beyond the standard facilitator surface.

Request:

```json
{
  "bundleId": "bdl_7f3a91",
  "amount": "50",
  "asset": "USD",
  "resource": "https://api.example.com/v1/analyze",
  "idempotencyKey": "9f8b2c54-1a3e-4f6d-8e07-3d2a5b1c9e44"
}
```

Response on success: `{ "attestation": "<compact JWS>" }`. The decrement and the attestation issuance are one atomic operation.

**Idempotency (normative).** `idempotencyKey` is REQUIRED. The authority MUST bind `(bundleId, idempotencyKey)` to the authorization request and its result as part of the same atomic decrement:

- Concurrent or later calls with the same key and identical parameters MUST cause **at most one** decrement; every such call MUST return the attestation minted by the first successful decrement. A non-atomic check-then-decrement does not satisfy this under concurrency — the authority MUST coalesce concurrent redemptions so at most one wins and the rest observe its result.
- Reusing the key with parameters that differ in any field affecting the authorization (`amount`, `asset`, `resource`, …) MUST fail with `idempotency_conflict` and MUST NOT decrement.
- The authority MUST preserve the key binding through at least the attestation's `holdExp`. If the original result is no longer retained, the authority MUST reject reuse rather than treat the key as a new authorization. Clients MUST use a fresh key for each new logical authorization.

Because these hold across retries and concurrent delivery, a client MAY retry `/authorize` safely on timeout or transport failure without risk of double-decrement.

Failure codes: `insufficient_credits`, `bundle_not_found`, `bundle_revoked`, `idempotency_conflict`.

### `POST /verify` (standard facilitator endpoint)

Takes the standard `{ x402Version, paymentPayload, paymentRequirements }` request. The authority validates the attestation (signature, `iss`, `exp`, amount/asset, `aud`, `resource`, and — because it owns the ledger — that the `jti` has not already been settled and has not been revoked) and returns the standard `{ isValid, invalidReason }` response. Because verification of presentation-replay and revocation happens against the authority's own ledger, **resource servers can remain fully stateless**.

### `POST /settle` (standard facilitator endpoint)

Takes the **standard** `SettleRequest` — `{ x402Version, paymentPayload, paymentRequirements }` — with no binding-specific top-level fields. Following the [`upto`](../upto/scheme_upto_evm.md) precedent, the actual charge is carried in the **settlement-time** `paymentRequirements.amount`:

```json
{
  "x402Version": 2,
  "paymentPayload": { "...": "..." },
  "paymentRequirements": { "...": "...", "amount": "35" }
}
```

- Settlement-time `paymentRequirements.amount` is the actual charge, MUST be ≤ the attestation `amount`. The difference is re-credited to the bundle.
- A **release** (fulfillment failed, or nothing consumed) is `amount: "0"`, which frees the full hold. *(Open question under discussion: whether a zero-cost **fulfilled** charge must be distinguishable from a **failed** one — and if so, whether that status belongs in `paymentRequirements.extra` rather than a top-level field, which would require extending the facilitator's settlement-override support. Until resolved, `amount: "0"` covers both as a ledger release.)*
- **Idempotency (normative).** The attestation `jti` is the settlement idempotency key. The authority MUST commit at most one terminal result per `jti` and MUST coalesce concurrent settles for the same `jti`; after a terminal result commits, an identical repeat MUST return that result, and a repeat with different parameters MUST fail with `settle_conflict`. A transport or internal failure that commits no terminal result is not final and MAY be retried.
- The authority MUST authenticate the caller as the attestation's `aud` (now REQUIRED; see [Payment Payload](#payment-payload)), per the registration between server and authority — API key, mTLS, or signed request.

The settle response is the settlement result the server forwards as `PAYMENT-RESPONSE` (see below), including `extra.commitmentId` and the post-settle `bundleState`.

Failure codes: `settle_conflict`, `hold_expired`, `unauthorized_server`, `revoked`.

## 402 Response (PaymentRequirements)

```json
{
  "x402Version": 2,
  "error": "No PAYMENT-SIGNATURE header provided",
  "resource": {
    "url": "https://api.example.com/v1/analyze",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "batch-settlement",
      "network": "acme:credit",
      "amount": "50",
      "asset": "USD",
      "payTo": "merchant",
      "maxTimeoutSeconds": 300,
      "extra": {
        "version": "1.0.0",
        "authority": "https://credits.acme.com",
        "purchaseUrl": "https://credits.acme.com/purchase",
        "tiers": [
          { "credits": "1000", "price": "1000", "asset": "USD" },
          { "credits": "10000", "price": "9000", "asset": "USD" }
        ]
      }
    }
  ]
}
```

**PaymentRequirements fields:**

- `scheme`: Must be `"batch-settlement"`
- `network`: `<authority>:credit` — the namespace is a label; see [Authority identity](#authority-identity-and-trust-binding)
- `amount`: Maximum charge for this request, in the smallest unit of the asset (e.g. cents for USD)
- `asset`: ISO 4217 currency code (e.g. `"USD"`)
- `payTo`: Must be `"merchant"` (the authority handles settlement)
- `extra.version`: Binding implementation version (semver)
- `extra.authority`: Origin URL of the bundle authority — the trust anchor and facilitator base URL
- `extra.purchaseUrl`: PSP-hosted checkout for bundle purchase (human-driven setup)
- `extra.tiers`: Available bundle tiers (optional; informational; see [Credits denomination](#credits-denomination))

## Payment Payload

```json
{
  "x402Version": 2,
  "accepted": {
    "scheme": "batch-settlement",
    "network": "acme:credit",
    "amount": "50",
    "asset": "USD",
    "payTo": "merchant",
    "maxTimeoutSeconds": 300,
    "extra": { "version": "1.0.0", "authority": "https://credits.acme.com" }
  },
  "payload": {
    "type": "consume",
    "attestation": "eyJhbGciOiJFUzI1NiIsImtpZCI6IjIwMjYtMDYta2V5In0..."
  }
}
```

The `attestation` is a compact JWS issued by the authority. Required claims:

| Claim | Description |
| --- | --- |
| `iss` | Authority origin; MUST equal `extra.authority` |
| `sub` | Bundle identifier |
| `exp` | Presentation expiry; MUST be short-TTL (minutes, not hours) |
| `holdExp` | Settlement expiry; MUST be after `exp`. Sized to the settlement mode (see [Settlement timing](#settlement-timing)): deferred settle RECOMMENDS ≥ 24h after `exp`; synchronous settle SHOULD keep it short (minutes) to bound failure-reclaim. Private claim per RFC 7519 §4.3 |
| `iat` | Issued-at |
| `jti` | Unique attestation ID — the commitment identifier, replay anchor, and settle idempotency key |
| `amount` | Authorized maximum for this request, smallest unit |
| `asset` | ISO 4217 currency code |
| `aud` | Resource server origin. **REQUIRED** — bounds the attestation to one audience so it is not a transferable bearer authorization across resource servers drawing on the same authority |
| `resource` | The resource this authorization is for — the exact resource URL, or a `sha256:<lowercase-hex>` over the RFC 8785 (JCS) canonical bytes of the accepted `PaymentRequirements`. **REQUIRED** — binds the attestation to the specific endpoint/price so it cannot be replayed against a different resource of the same audience |

## Verification

Resource servers have two verification paths, mirroring the EVM binding's local-vs-facilitator distinction:

- **Facilitator `/verify`** (RECOMMENDED): the authority checks signature, `iss`, freshness, amount/asset, `aud`, `resource`, and — against its own ledger — that the `jti` is unsettled. The server keeps no state.
- **Local verification**: the server validates the JWS against the authority's published keys (e.g. JWKS at `{extra.authority}/.well-known/jwks.json`) and checks `iss`, `exp`/`iat`, amount/asset, `aud`, `resource`, and the `accepted` field. This avoids the `/verify` round trip. Without an authority-side `jti` check, a same-`jti` re-presentation within the `exp` window may be served twice — but never charged twice, since `/settle` is `jti`-idempotent.

**Verification prevents double *charge*, not double *execution*.** Settlement is downstream of fulfillment, so two *concurrent* presentations of the same `jti` can both observe it unsettled — under local verification **and** under facilitator `/verify` — and both be served, even though `/settle` idempotency collapses them to a single charge. For costly or non-idempotent resources, the server MUST coalesce fulfillment by `jti` (single-flight, and cache the outcome for the `exp` window) regardless of the verification path; a `jti` cache spanning `exp` is required for exactly-once serving.

Verification failures surfaced to the client MUST be distinguishable:

- **`attestation_expired`** — signature valid, `exp` in the past. An honest client past its TTL; the correct client response is re-authorize against the authority and retry.
- **`attestation_invalid`** — signature, structure, or type failure. Potential forgery; reject and log, no retry path on the same token.
- **`insufficient_credits`** — the authority rejected `/authorize` (surfaced to the client at step 1 of the payment flow). The correct client response is to top up via the authority or route the principal to `purchaseUrl`.

These are three distinct states driving three distinct client behaviors; implementations MUST NOT collapse them. A hold released on `attestation_expired` is a retry; a hold released on `attestation_invalid` is an attack signal.

## Settlement

The bundle authority acts as Merchant of Record (or billing agent for the resource server, per their commercial agreement). It aggregates settled charges and pays out to the resource server through the PSP rail on a billing cycle. Payout timing, dispute handling, and rate limits are registration terms between authority and resource server, outside the x402 protocol; the `/settle` contract above is the protocol-level boundary.

The client's funds move once — at bundle purchase. Per-request flows are ledger operations against the authority, with zero per-request transaction fees.

## PAYMENT-RESPONSE

The settlement result returned by `/settle`, forwarded by the server:

```json
{
  "success": true,
  "transaction": "",
  "network": "acme:credit",
  "payer": "bdl_7f3a91",
  "amount": "",
  "extra": {
    "commitmentId": "att_1d4c88",
    "chargedAmount": "35",
    "bundleState": {
      "bundleId": "bdl_7f3a91",
      "balance": "8420",
      "asset": "USD",
      "expiresAt": 1781136000
    }
  }
}
```

- `transaction` is `""` (no onchain transfer).
- `extra.commitmentId` is the attestation `jti` — the non-empty commitment identifier required by the [base scheme](./scheme_batch_settlement.md#commitment-identifier). It is the handle for audit and dispute against the authority's ledger.
- `extra.chargedAmount` is the actual charge (≤ authorized `amount`). The difference between authorized and charged amounts is re-credited to the bundle.
- `extra.bundleState` carries the post-charge snapshot, mirroring the EVM binding's `channelState` pattern, so the client stays in sync without a separate balance endpoint. Under deferred settle the snapshot reflects the hold, not the final settled charge. The balance is informational; clients MUST NOT treat it as a guarantee that a future `/authorize` will succeed — the atomic decrement at the authority is the only authorization.

## Revocation and disputes

A principal may need to stop an agent mid-flight: the mandate is withdrawn, the bundle credential is suspected compromised, or spending is paused. How revocation is *triggered* is a client↔authority account operation outside the x402 exchange (like purchase and top-up); its *effect* on the in-band verbs is normative:

- **Bundle freeze.** The authority MUST support freezing a bundle. While frozen, `/authorize` fails with `bundle_revoked` and no new attestations are issued.
- **Attestation revocation.** The authority MUST support revoking an outstanding attestation by `jti`. A revoked `jti` MUST fail `/verify` (reason `revoked`) and MUST fail `/settle` (`revoked`); any hold it reserved is released back to the bundle, or to the refund path if the bundle is also closed.
- **Revocation latency under local verification.** A server verifying locally (no `/verify` call) cannot observe revocation and will accept a revoked-but-unexpired attestation until its `exp` lapses. The short presentation window (`exp`) is therefore the upper bound on local-verify revocation latency. Servers that must honor revocation immediately MUST use `/verify`. This is the same trust-vs-latency tradeoff as elsewhere in the binding: local verification is faster but `exp`-bounded stale; `/verify` is authoritative but adds a round trip.

**Disputes.** A *settled* charge is past the hold lifecycle and cannot be revoked; it is resolved through dispute. The `extra.commitmentId` (the attestation `jti`) is the dispute handle against the authority's ledger. Dispute adjudication and any resulting re-credit or PSP chargeback are registration terms between authority and resource server, outside the x402 protocol; the protocol's contribution is a stable charge reference per request.

## Appendix

### Mapping to base-spec network requirements

| Requirement | This binding |
| --- | --- |
| Commitment format | Compact JWS attestation with the claims table above |
| Verification rules | Facilitator `/verify` (signature, `iss`/origin binding, expiry, `jti` unsettled, amount/asset, `aud`, `resource`) or local JWS verification |
| Storage behavior | The authority ledger is the commitment store; the attestation `jti` is the commitment identifier, returned as `extra.commitmentId` |
| Double-spend prevention | Atomic decrement-on-authorize at the authority (no query-then-act), concurrency-coalesced `jti`-idempotent `/settle`, mandatory concurrency-safe idempotency keys on `/authorize` |
| Commitment expiry | Two windows: `exp` bounds presentation (minutes); `holdExp` bounds settlement (hours). Unsettled holds are released at `holdExp` |
| Redemption | Server settles charges via facilitator `/settle`; authority pays out accumulated settled charges to the resource server via PSP rail on a billing cycle |
| Trust model | Credit-backed: the trust anchor is the bundle authority, in the same trust position as a PSP — already inside the trust boundary of any payment flow |

### Informative authorization profile: AP2 mandates

*This section is informative, not normative.* The binding is authorization-system-agnostic: how the authority decides to issue an attestation is the authority's policy. One profile that fits agentic clients well is [AP2](https://github.com/google-agentic-commerce/AP2) mandate verification as a pre-flight:

1. The principal issues the agent an AP2 IntentMandate (W3C VC / SD-JWT-VC) carrying spend constraints (per-request cap, cumulative cap, expiry).
2. The authority verifies the mandate before honoring `/authorize` calls, and enforces the cumulative cap as the bundle ceiling.
3. The attestation may carry an `evidence` claim: `sha256:<lowercase-hex>` over the RFC 8785 (JCS) canonical bytes of the mandate body, binding the per-request authorization to the mandate for audit.
4. A failed mandate pre-flight is a non-payment denial: no attestation, no payment payload, no settlement artifact.
5. Mandate revocation by the principal maps to bundle freeze: the authority stops honoring `/authorize` and revokes outstanding attestations per [Revocation and disputes](#revocation-and-disputes).

Because the authority's counter sits above the settlement rail, the same bundle (and the same AP2 cumulative cap) can span multiple rails and multiple merchants — the cross-merchant budget enforcement pattern discussed in [AP2 #207](https://github.com/google-agentic-commerce/AP2/issues/207) and [x402 #2452](https://github.com/x402-foundation/x402/issues/2452).

### Error codes (resource server → client)

- `attestation_expired`: Valid signature, expired attestation — re-authorize and retry
- `attestation_invalid`: Signature, structural, or type failure — reject and log
- `attestation_revoked`: Attestation revoked by the principal (reported by `/verify`) — do not retry; surface to the principal
- `price_not_acceptable`: Attestation amount below resource requirements
- `unknown`: Unknown error

(Facilitator-side errors — `insufficient_credits`, `bundle_not_found`, `bundle_revoked`, `idempotency_conflict`, `settle_conflict`, `hold_expired`, `unauthorized_server`, `revoked` — are defined in the [facilitator interface](#facilitator-interface) and [Revocation and disputes](#revocation-and-disputes).)

### Security considerations

**Atomic authorization.** The authority MUST implement `/authorize` as a single atomic decrement-and-attest operation. Exposing a balance read as a pre-condition for spending reintroduces the read-modify-write race: two parallel requests reading the same remaining balance both proceed and the bundle overspends. There is no safe query-then-act pattern; any balance query is advisory only.

**`purchaseUrl` phishing.** A malicious resource server can declare a fraudulent authority and a `purchaseUrl` pointing at a fake checkout, harvesting payment credentials from the human principal. Clients SHOULD maintain an allowlist of trusted authority origins (or consult a registry/reputation source) and MUST NOT route a principal to a `purchaseUrl` on an authority origin the client has no prior trust relationship with, without surfacing a clear warning.

**Hold release on failure.** If a request is authorized but fulfillment fails, the hold MUST be released back to the bundle — by an explicit `amount: "0"` settle, or by lapse at `holdExp`. Without this the bundle leaks value over time.

**Presentation TTL.** `exp` is minutes, not hours. A stale attestation MUST NOT be acceptable for a new charge. The longer `holdExp` window exists solely between server and authority and does not extend the presentation surface.

**No raw payment data.** The x402 layer never carries card numbers or bank details. Bundle purchase happens at the PSP (hosted checkout or tokenized off-session mandate); the protocol sees only opaque references.

**Key discovery.** Authorities MUST publish verification keys at a well-known location under the `extra.authority` origin and SHOULD support key rotation via `kid` headers.

### Comparison with sibling bindings

| Feature | `cloudflare:402` | EVM | `credit` |
| --- | --- | --- | --- |
| Trust model | Credit-backed | Capital-backed | Credit-backed |
| Client identity | Registered crawler (Web Bot Auth) | Wallet / EOA | Bundle credential at authority |
| Auth per request | HTTP Message Signatures (RFC 9421) | EIP-712 cumulative voucher | Short-TTL JWS attestation |
| Onchain capital | None | Required (channel deposit) | None |
| Budget enforcement | Network billing terms | Channel balance (per-chain) | Pre-spend atomic cap at authority |
| Target use case | Content / crawler monetisation | General API, crypto-native, throughput-first | General API, fiat-native, budget-capped agents |
| Settlement rail | Cloudflare billing | Onchain claim + settle | PSP (Stripe, Adyen, …) |

### Network version

The `extra.version` field uses semantic versioning to signal changes in binding behavior.

| Version | Date | Changes |
| --- | --- | --- |
| `1.0.0` | 2026-06 | Initial draft |
| _unreleased_ | 2026-07 | Idempotency made normative on `/authorize` (concurrency coalescing + retention through `holdExp`) and `/settle` (`jti`, concurrent-safe); `/settle` aligned to the standard `SettleRequest` — actual charge carried in settlement-time `paymentRequirements.amount` per the `upto` precedent, top-level `chargedAmount`/`status` removed; `aud` and `resource` attestation claims made REQUIRED to prevent cross-audience/cross-resource replay; clarified that verification prevents double-charge but not concurrent double-execution (servers MUST coalesce fulfillment by `jti`); `holdExp` sizing clarified as mode-specific (short for synchronous settle, ≥24h for deferred) rather than a flat minimum |
