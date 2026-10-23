# Extension: `cardano-request-commitment`

**Status:** Draft — proposal for [#3449](https://github.com/x402-foundation/x402/issues/3449)

## Summary

`cardano-request-commitment` binds a Cardano `exact` payment to the HTTP request it pays for. The buyer includes a salted digest of the request in the payment transaction's metadata under label `402`, signs the transaction so that its `auxiliary_data_hash` commits to that metadata, and discloses the salt to the resource server in the payment payload. The resource server recomputes the digest from the request it is about to serve and the disclosed salt.

It addresses a gap in the `default` asset transfer method. Rules 1–9 of `scheme_exact_cardano.md` check network, recipient, amount, asset, nonce, phase-1, TTL, min-UTxO and confirmation, and none of them reference the request. Without this extension the server is still paid the right amount, and transaction-ID deduplication still stops a transaction from settling twice. What is missing is a link between the payment and the request. The extension adds two things:

1. **A payment cannot be redirected.** A signed payment that leaks before it is used (from a log, a proxy, a shared client) cannot be presented with a different request, including another endpoint of the same seller at the same price.
2. **The payment carries evidence of what it paid for.** The buyer, or anyone the buyer shows the salt to, can later check against the chain which request a payment was for.

The extension is opt-in per route. A route that does not declare it is unaffected. A route that declares it with `required: false` accepts payments without a commitment but rejects an invalid one; with `required: true` it also rejects payments without one.

It reuses two constructions that already exist rather than defining new ones:

- the digest is the `inputCommitment` construction of the Masumi method (`masumi:x402:input:v1`);
- the request is represented by the `http:1` binding object of `scheme_exact_lnbtc.md`, so Lightning and Cardano bind an HTTP request the same way.

The salt is one more part of the same `inputCommitment`, so the construction and its domain tag stay unchanged.

What differs from Masumi is only the anchor: Masumi stores the digest in the escrow datum, while `default` is a plain transfer with no script and no datum, so the digest goes in transaction metadata.

---

## `PaymentRequired`

The server declares the extension and publishes the commitment it computed for the request that produced the 402:

```json
{
  "extensions": {
    "cardano-request-commitment": {
      "info": {
        "required": true,
        "profile": "http:1",
        "bindingParams": { "headers": [] },
        "commitment": {
          "version": "1",
          "algorithm": "sha256",
          "parts": [
            {
              "name": "request",
              "canonicalization": "jcs",
              "digest": "22351cc0b694189e9feb7bab0fb3956fc1dcc0927b704406d2428e0fe821acd1"
            }
          ],
          "digest": "556fb70df9929f3ebd96b8b51b772374a9d38379b3983f820bf5e4629bd34e68"
        }
      },
      "schema": { "...": "..." }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `required` | `true`: a payment without a valid commitment is rejected. `false` or absent: a payment without one is accepted; an invalid one is still rejected. |
| `profile` | Request binding profile. This version defines `http:1`. `mcp:1` is reserved for a later version. |
| `bindingParams.headers` | Bound header names, chosen by the server's configuration for the route. Same rules as `extra.requestBindingParams.headers` in `scheme_exact_lnbtc.md`: lowercase field-name tokens, strictly ascending ASCII order, every header that can affect the purchased operation, content interpretation or account selection, never `payment-signature`. |
| `commitment` | A Masumi `inputCommitment` object (`version`, `algorithm`, `parts`, `digest`) computed by the server for this request, with exactly one part, `request`, and no salt. It tells the client which request the server is selling; the value signed on-chain is this commitment extended with the client's salt. `commitment` is regenerated on every 402 and is therefore excluded from client echo validation. |

The `request` part carries no `content`: both sides derive it from the request itself, and the manifest excludes `content` by construction, so omitting it does not change the digest.

---

## `PaymentPayload`

The client discloses its salt in the payment payload:

```json
{
  "extensions": {
    "cardano-request-commitment": {
      "info": {
        "salt": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
      }
    }
  }
}
```

| Field | Meaning |
|---|---|
| `salt` | 32 bytes from a cryptographically secure random source, as 64 lowercase hex characters. Fresh for every payment. It never goes on-chain. |

The payment payload reaches the resource server and the facilitator, so both learn the salt. See *Privacy* below.

---

## Commitment construction

### Request binding (`http:1`)

The binding object has exactly the members, value rules and normalization of the `http:1` profile in `scheme_exact_lnbtc.md`, including its rejection rules. The only difference is the `domain` member (below). In particular:

- `method` and `url` follow the `@method` and `@target-uri` rules of RFC 9421 §2.2: method case, percent escapes and query parameter order are preserved, and nothing is normalized.
- The URL MUST be an absolute `http` or `https` URL in ASCII URI syntax, including the query string, without a fragment or user information.
- `bodyHash` is SHA-256 of the content bytes after transfer decoding. A request without a body and a request with a zero-length body both hash the empty byte string. Neither side may substitute another representation (`null`, `""` serialized as JSON, a re-serialized parsed body).
- Each bound header's `valueHash` is SHA-256 of `0x01 || ASCII(value)`, with `value` per RFC 9421 §2.1 (each field line trimmed, multiple field lines combined with `", "`), or SHA-256 of the single byte `0x00` when the header is absent. A value that cannot be represented under those rules (non-ASCII, control characters) MUST cause rejection, not normalization.

```text
"domain": "x402:exact:cardano:request-commitment:http:1"
```

A distinct domain means a Lightning binding can never be presented as a Cardano one, or the reverse.

Unlike the Lightning profile, this extension does not require `PaymentRequired.resource.url` to equal the bound `url`. In the TypeScript core, `resource.url` is either a static value from the route configuration (usually without the query string) or the adapter's URL (derived from the `Host` header), so equality would fail for ordinary configurations. `resource.url` stays descriptive; what is bound is the `url` each side derives from the request itself.

### Digest

```text
request.digest = hex(SHA-256(UTF8(JCS(binding))))
salt.digest    = hex(SHA-256(UTF8(JCS(salt))))        -- salt as a JSON string of 64 lowercase hex characters

manifest       = { version: "1", algorithm: "sha256",
                   parts: [ { name: "request", canonicalization: "jcs", digest: request.digest },
                            { name: "salt",    canonicalization: "jcs", digest: salt.digest } ] }

inputHash      = SHA-256( UTF8("masumi:x402:input:v1\n") || UTF8(JCS(manifest)) )
```

This is the `inputCommitment` construction of `scheme_exact_cardano.md`, unchanged. The salt is an ordinary `jcs` part whose content is the salt string.

Two commitments use this construction, and they differ only in their parts:

- the commitment the server **publishes in the 402** has exactly one part, `request`;
- the commitment the buyer **signs on-chain** (`h`) has exactly two parts, `request` then `salt`, in that order.

Any other part list is rejected. Additional application-defined parts (`parameters`, `body`, `raw`) are allowed by the construction but are out of scope for this version.

### Transaction metadata

The buyer embeds the digest in the payment transaction under metadata label `402`:

```text
402: { "p": "http:1", "h": <salted inputHash, 32 bytes> }
```

- The value MUST be a map with exactly the text keys `p` and `h`.
- `p` names the profile, so a verifier that does not support it rejects the metadata instead of guessing how `h` was built.
- `h` MUST be exactly 32 bytes.

The metadata counts only if the transaction body's `auxiliary_data_hash` equals Blake2b-256 of the auxiliary data bytes as they appear in the transaction. That hash is the only part of the metadata the buyer's signature covers. Auxiliary data that is present but not committed by the body MUST be treated as invalid, never as absent and never as valid.

---

## Client rules

When a 402 declares `cardano-request-commitment`, the client:

1. MUST recompute the binding from its own request, using the declared `bindingParams.headers`, and MUST recompute `inputHash` from it.
2. MUST refuse to pay if the declared `commitment` does not match what it recomputed, whether or not `required` is set. The server is stating which request it is selling, and it is not the client's request.
3. MUST NOT embed a digest it has not recomputed itself.
4. Not being able to compute the commitment is not the same as detecting a mismatch. If the client cannot compute it (for example, the payment is made outside the code that issued the request), it MUST NOT include a commitment it has not computed itself; it MUST refuse to pay when `required` is `true`, and MAY proceed without a commitment when `required` is `false` or unset, provided no mismatch has been detected.
5. MUST generate a fresh 32-byte salt from a cryptographically secure source for every payment, MUST NOT reuse a salt, MUST embed the salted `inputHash`, and MUST disclose the salt in `PaymentPayload.extensions`.
6. MUST embed the metadata before signing, so that `auxiliary_data_hash` commits to it.
7. SHOULD check that the signed transaction actually carries the commitment, because a wallet or signer that ignores the request would otherwise drop it silently.

---

## Server rules

On the paid retry, the server:

1. MUST recompute the binding from the request that will execute, using its own route configuration. It MUST NOT take the profile, the bound headers or the expected digest from the client's echo of the 402. The salt is the only value it takes from the payment payload.
2. MUST build the target URI from its configured public origin and the request's path and query, never from the `Host` header or other client-supplied authority. Where the framework only exposes a URL assembled from client-influenced parts (scheme from `X-Forwarded-Proto`, authority from `Host` or `X-Forwarded-Host`, then the request target), a crafted value in any of them can move the boundary between authority and path and let the client choose the path that gets checked. The server MUST then reject the request unless: `X-Forwarded-Proto`, if present, holds only `http` or `https`; `Host` and `X-Forwarded-Host` hold only authority characters (no `/`, `?`, `#`, `@`); the URL's authority equals one of those headers (ignoring case and the scheme's default port); and the remaining target is in origin form (one leading `/`, no fragment). Taking the request target directly from the HTTP parser is preferable when the framework exposes it.
3. MUST hash the content bytes as received. A server that cannot obtain those bytes MUST reject any request it cannot show has no body, rather than hash a re-serialization or assume the body is empty. The absence of `Content-Length` and `Transfer-Encoding` is not such proof: an HTTP/2 request can carry a body with neither.
4. MUST read the commitment from the transaction as follows, checking the auxiliary data hash **before** looking for label `402`:

| Transaction | Outcome |
|---|---|
| No auxiliary data, no `auxiliary_data_hash` | absent |
| Auxiliary data and body hash that disagree (either one missing, or different), **whatever the metadata contains**, including metadata unrelated to this extension | **reject** (`request_commitment_unsigned`) |
| Auxiliary data the body commits to, without label `402` | absent |
| Label `402` not a map of exactly `p` and `h`, unknown `p`, `h` not 32 bytes | **reject** (`request_commitment_malformed`) |
| Absent, but the payload discloses a salt | **reject** (`request_commitment_malformed`) |
| Present, but the payload discloses no salt, or a salt that is not 64 lowercase hex characters | **reject** (`request_commitment_malformed`) |
| `p` differs from the route's profile, or `h` differs from the `inputHash` recomputed from the request and the disclosed salt | **reject** (`request_commitment_mismatch`) |
| Absent, route `required: true` | **reject** (`request_commitment_missing`) |
| Absent, route `required` false or unset | accept (no binding) |
| `h` equals the `inputHash` recomputed from the request and the disclosed salt | accept |

A commitment that is present is always checked, regardless of `required`.

These checks run before the resource executes. `exact` on Cardano uses the authorization flow (verify → resource → settle), so a transaction carrying unsigned metadata would otherwise be accepted at verify, serve the resource, and only be rejected by the ledger at settlement.

If the server cannot show that a present commitment is valid, the payment MUST NOT authorize the resource. This covers both outcomes a check can have short of success:

- an expected rejection: the commitment is missing when required, malformed, unsigned or mismatched;
- an internal error: the check could not be completed, for example because the transaction could not be decoded or the request could not be described.

Both MUST reject, regardless of `required`. An internal error MUST NOT be turned into success by default.

**Implementation note.** In the TypeScript core, an exception thrown by a `beforeVerify` hook is logged and ignored, and verification continues as if the hook had passed. An implementation of this extension MUST therefore catch every internal error and return an explicit rejection, or it fails open. This behaviour of the core is not specific to this extension and is reported in [#3689](https://github.com/x402-foundation/x402/issues/3689), with a fix proposed in [#3702](https://github.com/x402-foundation/x402/pull/3702).

## Facilitator

No change. The facilitator verifies and submits the exact signed bytes it receives, auxiliary data included. The facilitator has the transaction but not the request, so it cannot check the binding; the resource server can.

---

## Changes to the reference Cardano implementation

The extension cannot be purely additive, because the current client discards transaction metadata. Three changes are needed in `@x402/cardano`:

1. **Client scheme** (`exact/client/scheme.ts`): read the declaration from the `extensions` it already receives (and currently ignores), recompute the commitment, add a fresh salt, pass the salted digest to the signer, check the signed transaction carries it, and return the salt in the payload's `extensions`. New constructor options supply the client's view of the request and, optionally, the salt.
2. **Reference signer** (`signer.ts`): attach the metadata with the builder's `attachMetadata` before `build`, and keep `unsigned.auxiliaryData` when assembling the signed transaction. The current code sets `auxiliaryData: null`, which would leave the body committing to auxiliary data the transaction does not carry, and the ledger would reject it.
3. **New module** (`exact/requestCommitment/`): binding, digest, metadata encoding and reading, client resolution, and the resource-server extension (`enrichDeclaration` publishes the commitment; `onBeforeVerify` checks it).

Masumi's existing `computeInputHash` and `commitmentPartDigest` are reused unchanged.

---

## Cost

Reference measurement, not a constant for every Cardano transaction: measured with the reference implementation's encoding (Conway auxiliary data, tag 259), `minFeeA = 44`, `minFeeB = 155381`, offline (no transaction broadcast):

| Transaction | Size | Fee |
|---|---:|---:|
| Base lovelace transfer | 296 B | 168,405 lovelace |
| + commitment | 385 B | 172,321 lovelace |
| Delta | +89 B | +3,916 lovelace (0.0039 ADA) |

The overhead is fixed: it does not depend on the amount or the number of inputs, and it does not affect min-UTxO, because metadata is not part of any output. The salt does not change it: `h` is 32 bytes either way, and the salt itself never goes on-chain.

---

## Security considerations

- **What it binds.** The commitment ties the payment to the method, target URI, body and bound headers of one request. Single-use enforcement is unchanged: it remains transaction-ID deduplication and the spent nonce.
- **What it does not change.** Without the extension the server is still paid the correct amount, and a transaction can still settle only once. The extension does not protect the payment amount; it protects which request the payment is for.
- **Header selection.** A header that affects the response but is not bound can be changed by the client without changing the digest. Servers MUST bind every such header, as in the Lightning profile.
- **Public origin.** Deriving the URI from `Host` would let a client choose the authority it is bound to. The origin comes from configuration.
- **Unsigned metadata.** See the table above. Metadata the body does not commit to is not covered by any signature and MUST NOT be honored.
- **Privacy.** `h` is public on-chain. Without the salt it reveals nothing about the request, even a low-entropy one (a guessable URL with no body), and two payments for the same request carry unrelated values. Whoever holds the salt can confirm a guessed request against the chain: the resource server and the facilitator, which both receive the payment payload, and anyone the payload or the salt reaches later. That is the evidence property the extension is for; it is not hidden from those parties.
- **Salt reuse.** A reused salt makes payments for the same request linkable again. Clients MUST use a fresh salt for every payment.

---

## Metadata label

Label `402` is not registered in the CIP-10 registry (checked: no entry from 395 to 414) and the CIP-10 check (`tx_by_metalabel?_label=402` on Koios) returned no mainnet transactions. Registration is a coordination step that follows agreement on this layout; it is not a condition of the design. Both checks will be repeated immediately before registering.

---

## Test vectors

### 1. Bodiless GET

Request: `GET https://api.example.com/article/A`, no body, no bound headers. This is the request of the `http:1` test vector in `scheme_exact_lnbtc.md`; with the Lightning domain the same binding reproduces that vector's digest `0d6623f7…6c018`.

| Step | Value |
|---|---|
| Binding (JCS) | `{"bodyHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","domain":"x402:exact:cardano:request-commitment:http:1","headers":[],"method":"GET","url":"https://api.example.com/article/A"}` |
| `request` part digest | `22351cc0b694189e9feb7bab0fb3956fc1dcc0927b704406d2428e0fe821acd1` |
| Manifest published in the 402 (JCS) | `{"algorithm":"sha256","parts":[{"canonicalization":"jcs","digest":"22351cc0b694189e9feb7bab0fb3956fc1dcc0927b704406d2428e0fe821acd1","name":"request"}],"version":"1"}` |
| Commitment published in the 402 (`commitment.digest`, no salt) | `556fb70df9929f3ebd96b8b51b772374a9d38379b3983f820bf5e4629bd34e68` |
| Salt (fixed for the vector) | `000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f` |
| `salt` part digest | `4602db566c605e475171dc6f7ae9cafdcaa264b971d95e7c98df10c2a3a47ffc` |
| Salted manifest (JCS) | `{"algorithm":"sha256","parts":[{"canonicalization":"jcs","digest":"22351cc0b694189e9feb7bab0fb3956fc1dcc0927b704406d2428e0fe821acd1","name":"request"},{"canonicalization":"jcs","digest":"4602db566c605e475171dc6f7ae9cafdcaa264b971d95e7c98df10c2a3a47ffc","name":"salt"}],"version":"1"}` |
| `inputHash` signed on-chain (`h`) | `712cdce8a4e64fc7e2b2fb3b70ba41317ff606d84e98890c65d4fd828276a621` |
| Metadata CBOR | `a1190192a2617066687474703a3161685820712cdce8a4e64fc7e2b2fb3b70ba41317ff606d84e98890c65d4fd828276a621` |
| Auxiliary data CBOR (Conway) | `d90103a100a1190192a2617066687474703a3161685820712cdce8a4e64fc7e2b2fb3b70ba41317ff606d84e98890c65d4fd828276a621` |
| `auxiliary_data_hash` | `93798edd737919eb62f4a7613030f14892b6d0ab38b135218937841dce62c3df` |

### 2. POST with query, body and a bound header

Request: `POST https://api.example.com/search?q=cardano&lang=es`, body `{"q":"cardano"}` (15 bytes, as sent), bound headers `["content-type"]` with `content-type: application/json`.

| Step | Value |
|---|---|
| `bodyHash` | `d1ea1113acf7d9176837ceb07bfa3b30c7bbd4907b1157c8c52818ed77b6a77c` |
| `content-type` `valueHash` | `b2ec0efb460ab23169a6cfc6bd623cca0865f32297a1fd3585a974fc78d441a5` |
| Binding (JCS) | `{"bodyHash":"d1ea1113acf7d9176837ceb07bfa3b30c7bbd4907b1157c8c52818ed77b6a77c","domain":"x402:exact:cardano:request-commitment:http:1","headers":[{"name":"content-type","valueHash":"b2ec0efb460ab23169a6cfc6bd623cca0865f32297a1fd3585a974fc78d441a5"}],"method":"POST","url":"https://api.example.com/search?q=cardano&lang=es"}` |
| `request` part digest | `19f76af6c9d60eb3f599273ac707830fb5fd2703b870aa9165014048fd5375c3` |
| Commitment published in the 402 (no salt) | `f2a6d890837465ce790568b4872b576e5004fb304c3c7ed061be2fb5fa988b52` |
| `inputHash` signed on-chain (`h`), same salt as vector 1 | `d26cbb2a326a7c06dad25e8a21de168a5461e8c413fb6f2efe87980cfb2b778e` |

Both vectors were recomputed independently of the reference implementation.
