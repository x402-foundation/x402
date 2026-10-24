# Extension: `delivery-receipt`

| | |
|---|---|
| Status | Draft (v0.2.1) |
| Extension key | `delivery-receipt` |
| x402 versions | v2 (the signed payload itself is version-agnostic) |
| Transports | HTTP (normative). MCP / A2A: see §11 |
| Related | [`offer-receipt`](./extension-offer-and-receipt.md), [`payment-identifier`](./payment_identifier.md) |
| Test vectors | Appendix A (in this document) and [`delivery-receipt.vectors.json`](./delivery-receipt.vectors.json) |

## 1. Summary

The `delivery-receipt` extension lets a resource server commit, at the moment it settles a payment, to **what it
delivered for that payment**. After a successful settle the server returns a signed receipt that binds, in one
signed object:

- the settlement locator — `network`, `transaction` and, when known, the `logIndex` of the transfer;
- the economic terms that were paid — `scheme`, `asset`, `payTo`, `amount`, `payer`;
- the resource — `resourceUrl`, HTTP `method`;
- the served content — either the SHA-256 of the exact response body (`delivery.mode = "body"`) or, for streamed
  responses, the frame count and running digest of the frames sent (`delivery.mode = "stream"`), plus the content
  type and (when available) the response status;
- the key directory the receipt was signed under — its epoch and digest;
- the issuance time and the issuer.

Every receipt carries **two signatures over the same message**: an `ed25519` signature that a client can check
inside the x402 session with the WebCrypto API available on edge runtimes, and an `ml-dsa-65` (NIST FIPS 204)
signature for the archival path, so the receipt stays usable as long-lived evidence without depending on a
signature scheme that a cryptographically relevant quantum computer would break. A verifier states which path it
took.

On HTTP the `PAYMENT-RESPONSE` header carries, by default, only a compact reference to the receipt
(`receiptId`, `receiptUrl`, `digest`; at most 1 KB), and the receipt itself is served immutable at a URL addressed by
its id (§5.5). Nothing is added to the response body.

Signing keys are published in a **signed key directory** at a stable URL, with an immutable archive per epoch and a
hash chain between epochs. With the archive of the epoch a receipt names, a receipt can be verified **offline**, by
anyone, long after the HTTP exchange.

## 2. Relationship to `offer-receipt`

[`offer-receipt`](./extension-offer-and-receipt.md) defines signed offers and a privacy-minimal receipt whose
payload carries `network`, `resourceUrl`, `payer`, `issuedAt` and an **optional** `transaction` (a server opts in
with `includeTxHash`), signed with EIP-712 or JWS.

What `offer-receipt` does not carry, and what `delivery-receipt` adds, is:

- the **transfer locator** `logIndex`, which distinguishes the payment from other transfers in the same transaction;
- the **accepted terms** (`scheme`, `asset`, `payTo`, `amount`), so the receipt can be checked against the chain
  without the 402 response;
- a **content reference** (body digest, or stream digest and frame count), i.e. *which bytes* were delivered;
- a **key directory** with epochs, so a receipt resolves the key and its lifecycle at issuance years later.

This is the requirement of audit, dispute and agent-to-agent accounting. A server that only needs reputation-style
receipts SHOULD use `offer-receipt`; a server that wants its customers to be able to prove what they were served
SHOULD use `delivery-receipt`. Maintainers may prefer to fold these fields into a future `offer-receipt` payload
version; the payload, signed message and key directory in this document are designed so that this remains possible
(§13).

### 2.1 Declaring both extensions on one route

The two extensions MAY be declared together. Both then place an artifact in `SettleResponse.extensions` (on HTTP,
`PAYMENT-RESPONSE`), so a client holds **two receipts for one payment**. The following rules are normative:

1. **They describe the same payment.** A server MUST derive both from the same `SettleResponse`. The
   `offer-receipt` receipt payload and the `delivery-receipt` payload MUST be equal in `network` and `payer`
   (case-insensitive for EVM addresses), and, when the `offer-receipt` receipt includes `transaction`, in
   `transaction`. A verifier that sees both in one `SettleResponse` MUST compare these fields and MUST reject the
   `delivery-receipt` (at the `settlement` level) if any of them differs.
2. **Neither replaces the other.** `delivery-receipt` is the one that binds the content and the transfer locator;
   it does not make the `offer-receipt` receipt redundant, and it is not a substitute for verifying the
   `offer-receipt` signature under that extension's rules.
3. **One payment, counted once.** For accounting, both receipts identify the same payment, keyed by
   `(network, transaction, logIndex)` taken from the `delivery-receipt` payload (§12). An `offer-receipt` receipt
   that arrives in the same `SettleResponse` MUST NOT be counted as a second payment.

### 2.2 Relationship to the `x402-served` profile (legacy)

Some issuers already sign `x402-served` receipts (a profile of the FractalAI Trust Kernel), whose signed message is
`"FRACTALAI-x402-served-v1" || "\n" || route_id || "\n" || digest` — a route label and a content digest, with no
settlement fields. The following rules are normative for x402 routes:

1. **`delivery-receipt` subsumes `x402-served`.** It binds everything `x402-served` binds — the content digest
   (`delivery`) and the route (`resourceUrl`, `method`) — plus the settlement (`network`, `transaction`, `logIndex`,
   `payer`, `amount`, `asset`, `payTo`, `scheme`) and the key-directory epoch and digest. `x402-served` remains a
   legacy profile for receipts already issued; new x402 integrations SHOULD issue `delivery-receipt` only.
2. **One authoritative receipt.** A seller that emits both for one paid response MUST derive them from the same
   response, and a verifier MUST treat `delivery-receipt` as authoritative for that response: where the two disagree,
   the `delivery-receipt` verdict stands, and an `x402-served` receipt never makes a failing `delivery-receipt` pass.
   For accounting the pair is one payment (§12).
3. **Route identity.** In `x402-served`, `route_id` is a label chosen by the seller: it separates the seller's
   domains, not endpoints, and a third party cannot recompute it (a seller can reuse one label across endpoints).
   `delivery-receipt` binds `resourceUrl` and `method` of the request as the client made it, which the client — and
   any third party holding the request line — can recompute and compare (§8.3).

## 3. Terminology

- **Receipt payload** (`payload`): the JSON object of §5.2.
- **JCS**: JSON Canonicalization Scheme, RFC 8785. Signed JSON in this extension MUST contain only strings,
  booleans, `null`, arrays, objects and integers in the IEEE-754 safe range (|n| ≤ 2^53 − 1). Floating-point
  numbers are not allowed anywhere in a signed object, and neither is `-0` (JCS prints it as `0`, other encoders as
  `-0`). Strings, including member names, MUST be valid Unicode (I-JSON, RFC 7493 §2.1): a lone surrogate has no
  UTF-8 encoding and runtimes disagree on how to hash it. A verifier MUST reject a payload or directory that violates
  this subset (`integrity`) instead of coercing it.
- **Receipt id** (`receiptId`): the **64-character lowercase hexadecimal text** of `SHA-256(JCS(payload))`. It is
  text, not the 32 raw digest bytes.
- **Signed message**: the exact octets passed to every signature algorithm (§5.3):
  `UTF-8("x402-delivery-receipt/1") || 0x0A || UTF-8(receiptId)` — 88 octets.
- **Session path / archival path**: the two verification paths of §8.1, which check the `ed25519` and the
  `ml-dsa-65` signature respectively.
- **Issuer**: the origin (`scheme://host[:port]`) that owns the key directory and signs receipts.
- **Epoch**: one version of the key directory (§7).

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be interpreted as described in RFC 2119 / RFC 8174.

## 4. `PaymentRequired` — declaration

A server that will issue delivery receipts for a route declares it in the 402 response:

```json
{
  "extensions": {
    "delivery-receipt": {
      "info": {
        "version": 1,
        "issuer": "https://api.example.com",
        "keyDirectory": "https://api.example.com/.well-known/x402-receipt-keys",
        "algorithms": ["ed25519", "ml-dsa-65"],
        "deliveryMode": "body",
        "receiptTransport": "reference"
      },
      "schema": {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
          "version": { "type": "integer", "const": 1 },
          "issuer": { "type": "string" },
          "keyDirectory": { "type": "string", "format": "uri" },
          "algorithms": {
            "type": "array",
            "items": { "type": "string" },
            "allOf": [{ "contains": { "const": "ed25519" } }, { "contains": { "const": "ml-dsa-65" } }]
          },
          "deliveryMode": { "type": "string", "enum": ["body", "stream"] },
          "receiptTransport": { "type": "string", "enum": ["inline", "reference"] }
        },
        "required": ["version", "issuer", "keyDirectory", "algorithms"]
      }
    }
  }
}
```

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | integer | Yes | Receipt payload version the server will sign. Currently `1`. |
| `issuer` | string | Yes | Origin of the signer. MUST equal the origin of `keyDirectory`. |
| `keyDirectory` | string | Yes | **Stable** HTTPS URL of the current key directory (§7.1). |
| `algorithms` | string[] | Yes | Algorithms of the signatures every receipt will carry (§6). MUST include `ed25519` and `ml-dsa-65`. |
| `deliveryMode` | string | No | `body` (default, §5.4) or `stream` (§5.6). |
| `receiptTransport` | string | No | `reference` (default) or `inline` (§5.5). A client MUST accept both forms wherever a receipt travels. |

The declaration is a **promise, not a proof**: a client MUST NOT treat the presence of the declaration as evidence
that a receipt will be returned, and the absence of a receipt after a successful settle does not invalidate the
settlement (§8.4).

## 5. Receipt

### 5.1 Placement

For `deliveryMode: "body"`, on a successful settle the server adds to the `SettleResponse` it returns to the client
(on HTTP, the `PAYMENT-RESPONSE` header), under the v2 extension structure, either a **reference** (the default,
§5.5) or the receipt **inline**:

```
SettleResponse.extensions["delivery-receipt"].info = { "receiptId", "receiptUrl", "digest" }   ; reference (default)
SettleResponse.extensions["delivery-receipt"].info = { "receipt": { "payload", "signatures" } } ; inline
```

The settle-response member is `{ "info": … }`; the JSON Schema of §10 is not repeated on the wire.

For `deliveryMode: "stream"` the receipt (or its reference) travels in the terminal event of the stream (§5.6),
because the response headers are sent before the content exists.

A server MUST NOT place the receipt, or its reference, in the response body: the body stays byte-identical to what
`delivery.sha256` (or the stream digest) covers. A receipt MUST NOT be returned for a failed settle
(`success: false`).

### 5.2 Receipt payload (version 1)

| Field | Type | Required | Description |
|---|---|---|---|
| `version` | integer | Yes | `1` |
| `issuer` | string | Yes | Same value as the declaration. |
| `resourceUrl` | string | Yes | Absolute URL of the paid resource as the client requested it. A server behind a TLS-terminating proxy MUST sign the client-facing scheme and port (e.g. by rebasing the request path on `issuer` when the host matches). |
| `method` | string | Yes | Upper-case HTTP method of the paid request. |
| `scheme` | string | Yes | Payment scheme of the accepted requirements (e.g. `exact`). |
| `network` | string | Yes | CAIP-2 network of the settlement (e.g. `eip155:8453`). |
| `asset` | string | Yes | Asset of the accepted requirements. |
| `payTo` | string | Yes | Recipient of the accepted requirements. |
| `amount` | string | Yes | Settled amount in atomic units: `SettleResponse.amount` when present, otherwise the accepted requirements' `amount`. |
| `payer` | string | Yes | `SettleResponse.payer`. |
| `transaction` | string | Yes | `SettleResponse.transaction`. MUST be non-empty. |
| `logIndex` | integer \| null | Yes | Block-level index of the transfer log of `transaction` that paid `payTo`, when the server resolved it; otherwise `null`. |
| `paymentId` | string \| null | Yes | The `payment-identifier` extension `id` sent by the client, if any; otherwise `null`. |
| `responseStatus` | integer \| null | Yes | HTTP status code of the served response, or `null` when the server's x402 integration does not expose it (the reference HTTP integrations only settle for status < 400). |
| `responseContentType` | string \| null | Yes | `Content-Type` of the served response, or `null`. |
| `delivery` | object | Yes | Content commitment: `{ "mode": "body", "sha256" }` (§5.4) or `{ "mode": "stream", "framing", "frameCount", "digest" }` (§5.6). No other members. |
| `keyDirectoryEpoch` | integer | Yes | Epoch (≥ 1) of the key directory in force at `issuedAt` (§7). |
| `keyDirectoryDigest` | string | Yes | `root` of that epoch (§7.2): the lowercase hex SHA-256 of the canonical directory content. |
| `issuedAt` | integer | Yes | Unix time (seconds) at which the receipt was signed. |

All fields are present in every receipt (optional values are `null`), so the signed bytes never depend on how a
serializer treats absent keys. Network identifiers MUST be CAIP-2 even when the exchange used x402 v1 names.

Servers MUST derive every field from data they hold at settle time: the verified payment payload, the accepted
requirements, the facilitator's `SettleResponse`, the response produced by the handler and the directory epoch they
publish. Fields MUST NOT be copied from client-supplied text, except `paymentId`.

### 5.3 Wire object and signed message

```json
{
  "payload": { "version": 1, "...": "..." },
  "signatures": [
    { "alg": "ed25519", "kid": "4a1b0f2d9e8c7b6a", "signature": "<base64, 64 bytes>" },
    { "alg": "ml-dsa-65", "kid": "86c139c960bb274c", "signature": "<base64, 3309 bytes>" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `payload` | object | The receipt payload of §5.2. |
| `signatures` | object[] | 2–4 entries with distinct `alg`. MUST contain one `ed25519` and one `ml-dsa-65` entry (§6.1). Order is not significant. |
| `signatures[].alg` | string | Algorithm identifier from §6. |
| `signatures[].kid` | string | Identifier of the signing key in the directory epoch named by the payload. |
| `signatures[].signature` | string | Canonical base64 (RFC 4648 §4, padded) of the signature. |

Every signature in `signatures` is computed over **the same signed message**, which is exactly these octets:

```
message = UTF-8("x402-delivery-receipt/1") || 0x0A || UTF-8(receiptId)
receiptId = lowercase_hex(SHA-256(JCS(payload)))      ; 64 characters of [0-9a-f]
```

The message is therefore always 88 octets: 23 octets of domain string, one line feed, and the 64 hex characters of
the receipt id. Implementations MUST NOT sign or verify the raw 32-byte digest, the transmitted JSON text, or any
other representation. Appendix A gives the payload, its JCS octets, the receipt id, the message octets, public keys
and signatures for every registered algorithm.

The fixed first line provides domain separation: a signature over this message cannot be confused with a
signature produced by the same key for any other purpose, provided other protocols using the key also
domain-separate. For `ml-dsa-65` and `ml-dsa-87` the context string is empty and the pure (non-pre-hash) variant of
FIPS 204 is used. For `ed25519`, PureEd25519 of RFC 8032 is used.

### 5.4 Body mode

`delivery = { "mode": "body", "sha256": <hex> }`, where `sha256` is the lowercase hex SHA-256 of the exact octets of
the response body that the server hands to the transport for this request, **before** any content-coding is applied
(i.e. the identity representation). A client computes the digest over the body after removing content-coding (what
`fetch()` returns from `arrayBuffer()`).

A server MUST NOT issue a body-mode receipt when it cannot observe the whole body — for example when the payment flow
settles before the handler runs. Streamed routes use §5.6.

### 5.5 Delivery by reference (default) and header budget

An inline receipt with both baseline signatures makes the `PAYMENT-RESPONSE` header about 8 KB (base64), and the same
response may already carry a `PAYMENT-REQUIRED`-sized challenge on the way in; a client or proxy with a 16 KB total
header limit is one extension away from failing. Receipts are therefore delivered **by reference by default**:

```json
{
  "info": {
    "receiptId": "<64 hex>",
    "receiptUrl": "https://api.example.com/x402/receipts/<64 hex>",
    "digest": "<64 hex>"
  }
}
```

| Field | Description |
|---|---|
| `receiptId` | The receipt id (§3) of the referenced receipt. |
| `receiptUrl` | `https` URL, same-origin with `issuer`, whose last path segment is `receiptId` (no query, no fragment). |
| `digest` | `lowercase_hex(SHA-256(D))`, where `D` is the UTF-8 encoding of `JCS(receipt)` — the whole wire object of §5.3, payload and `signatures`. |

**Header budget.** By reference, the UTF-8 JSON text of `SettleResponse.extensions["delivery-receipt"]` MUST NOT
exceed **1024 octets** (the reference above is under 300). This is the size assumption of this extension; a server MUST
check it before responding. A server MAY deliver the receipt inline (`"receiptTransport": "inline"`) only when it knows
that every hop between it and the client accepts the resulting response headers; this extension makes no assumption
about that size.

**Serving.** `GET receiptUrl` MUST return, without payment, `application/json` whose body is exactly the octets `D`.
The resource is **immutable**: it MUST return the same octets for as long as it is served (servers SHOULD send
`Cache-Control: private, no-store` by default; an issuer MAY opt in to public archival with
`Cache-Control: public, max-age=31536000, immutable` and SHOULD state that choice in its documentation), and servers
SHOULD keep it retrievable for at least 30 days. Immutability rests on `receiptId` addressing and `digest`, not on
public cacheability.
Because the URL is addressed by `receiptId` and the octets are fixed by `digest`, any static store or CDN can serve
it.

**Resolving.** The URL comes from the server's response, so the client MUST decide whether to fetch it **before**
fetching: `receiptId` and `digest` are 64 lowercase hex characters; `receiptUrl` is `https`, same-origin with an issuer
the client accepts for the resource (§8.2) and ends with `/<receiptId>`. The fetch MUST NOT follow redirects and SHOULD
be bounded in size (e.g. 256 KiB). Then, in this order, the client MUST:

1. check that `SHA-256` of the octets received equals `digest`, **before parsing or trusting them**;
2. parse them with a parser that rejects duplicate member names, and check that they are the JCS text of the parsed
   object;
3. recompute the receipt id from the payload and reject it if it differs from `receiptId` (this prevents a store from
   substituting another genuine receipt), and check that `payload.issuer` is the origin of `receiptUrl`;
4. verify the receipt as any other (§8).

Any failure is a missing receipt (§8.4), never a receipt of lower standing. A client MUST accept a receipt inline even
when the declaration said `reference`, and a reference even when it said `inline`.

### 5.6 Stream mode

For responses that are delivered as a sequence of frames over a long window (for example a Server-Sent Events route
priced per session), the receipt commits to the frames in order:

```
d_0 = SHA-256(UTF-8("x402-delivery-stream/1"))
d_i = SHA-256(d_{i-1} || uint64_be(len(f_i)) || f_i)          for i = 1 … n
delivery = { "mode": "stream", "framing": "sse", "frameCount": n, "digest": lowercase_hex(d_n) }
```

`d_{i-1}` is the 32-octet digest, `len(f_i)` the length of frame `f_i` in octets as an unsigned 64-bit big-endian
integer, and `f_i` the frame octets. The length prefix prevents frame boundaries from being shifted; the chaining
makes the digest depend on order. Each step is a one-shot SHA-256, so the digest can be maintained with WebCrypto
alone. A stream with no frames has `frameCount: 0` and `digest = hex(d_0)`.

**Framing `sse`** (the only framing registered by this version):

- A frame is each event that an `EventSource` would dispatch (HTML Living Standard, "Server-sent events"), in order,
  **excluding** the terminal event. The frame octets are the UTF-8 encoding of the event's data buffer, i.e. the
  value `MessageEvent.data` exposes: the values of the event's `data:` lines joined with a line feed, no trailing
  line feed. Field names, the `event:`, `id:` and `retry:` lines and the blank line that ends the event are not part
  of the frame, so the raw octets of the stream are never hashed and a buyer can recompute the digest from a browser.
  Comment lines, `retry:` fields and events with an empty data buffer are not frames. The `event` and `id` fields are
  not hashed; servers SHOULD put everything the buyer pays for in `data`.
- Because an `EventSource` treats CR, LF and CRLF alike as line ends, a server MUST hash each frame **as the client
  will see it**: with every CRLF and every lone CR replaced by LF. A server MUST NOT emit a content event whose
  `event` field contains CR or LF or equals `x402-delivery-receipt`.
- As in `EventSource`, an event that is still pending when the stream ends (not terminated by a blank line) is
  discarded: it is not a frame, and a terminal event without its blank line is missing.
- The stream ends with one **terminal event** of type `x402-delivery-receipt` whose data is a single-line JSON object:

  ```
  event: x402-delivery-receipt
  data: {"frameCount":901,"digest":"<hex>","receipt":{"payload":{…},"signatures":[…]}}
  ```

  or, when the receipt is delivered by reference (§5.5),
  `{"frameCount":901,"digest":"<hex>","reference":{"receiptId","receiptUrl","digest"}}` — the reference is nested,
  because `digest` at the top level is the stream digest. The `reference` form is the default; since the terminal
  event is not a header, the 1 KB budget does not constrain the `receipt` form here.
- `frameCount` and `digest` in the terminal event MUST equal `payload.delivery.frameCount` and
  `payload.delivery.digest`.
- The terminal values travel **only** in the terminal event and in the signed payload. They MUST NOT be carried
  (only) in HTTP trailer fields, which many proxies and client libraries drop.
- A browser client can recompute the digest from `EventSource` alone: the frames are the `MessageEvent.data` values
  in order. `EventSource` dispatches a named event only to listeners for that name, so such a client MUST listen to
  every event type the route emits (servers SHOULD document them; e.g. `hello`, `pool`, `expired`) or read the
  response with `fetch()` and an event-stream parser. An event it did not observe makes the digest disagree: the
  receipt then fails, it never passes falsely. On the terminal event the client SHOULD call `close()`: a reconnection
  is a new request, not covered by this receipt.

The server settles the payment before streaming (there is no body to buffer), sends the frames, and signs the
receipt when the stream ends, over the settlement it obtained. `responseContentType` is normally
`text/event-stream`. A client verifies by recomputing `(frameCount, digest)` over the frames it received and
comparing them with the terminal event and with the signed payload; altering, reordering, inserting or dropping a
frame changes the digest or the count, and a stream that ends without the terminal event has no receipt. Events
after the terminal event are not covered and a client MUST treat their presence as a delivery failure.

Other framings (for example newline-delimited JSON) can be registered by amending this section; each MUST define what
a frame is and where the terminal frame travels, in the content itself. A verifier MUST reject
(`integrity`) a stream receipt whose `framing` is not registered, since the digest has no defined meaning otherwise.

The `deliveryMode` of the declaration is the server's word, not the client's observation: a client MUST NOT skip
receipt verification because the 402 declared `stream`. A response that is not an event stream is verified as a
body (and, without a receipt, fails).

## 6. Algorithms

| `alg` | Scheme | Public key | Signature | Status |
|---|---|---|---|---|
| `ed25519` | PureEd25519, RFC 8032 | 32 bytes | 64 bytes | REQUIRED (session path). Not post-quantum. |
| `ml-dsa-65` | ML-DSA-65, FIPS 204, pure, empty context | 1952 bytes | 3309 bytes | REQUIRED (archival path). |
| `ml-dsa-87` | ML-DSA-87, FIPS 204, pure, empty context | 2592 bytes | 4627 bytes | OPTIONAL (additional signature). |

Keys and signatures are transmitted as canonical base64 (padded, standard alphabet, no whitespace; decoding then
re-encoding MUST reproduce the input). Verifiers MUST reject a receipt whose `signatures` contain an `alg` that is not registered in
this table, an `alg` that differs from the directory entry of its `kid`, and lengths that do not match the table.

### 6.1 Baseline pair

- A server MUST sign every receipt with **both** an `ed25519` key and an `ml-dsa-65` key, over the same message
  (§5.3). It MAY add one signature per further registered algorithm (at most four in total).
- **Session path.** A client verifying inside the x402 session MUST verify the `ed25519` signature. Edge runtimes
  (Cloudflare Workers, Vercel Edge, Deno) and current browsers expose Ed25519 in WebCrypto; verifiers SHOULD use it
  where it exists. Deterministic signatures were produced for Appendix A; ML-DSA signers MAY use the hedged variant,
  so vectors are checked by verification, not by re-signing.
- **Archival path.** A verifier that keeps or relies on a receipt as long-lived evidence (audit, dispute, accounting
  after the session) MUST verify the `ml-dsa-65` signature. A result obtained on the session path MUST NOT be
  presented as long-term evidence.
- Both signatures cover the same message, so stripping one of them does not change what the other attests; a receipt
  that lacks either baseline signature is malformed (`integrity` fails) on every path.
- **No split verdict.** A present-but-invalid signature is not "absent": an archival verifier MUST verify **every**
  entry of `signatures` (each under the key of its `kid`, with the lifecycle of §7.4) and reject the receipt if any
  fails, so a receipt valid on the archival path is valid on every path. A session verifier MUST report the
  algorithms it did not check. Because a server can pair a valid `ed25519` signature with a broken `ml-dsa-65` one,
  a client that will keep a receipt as evidence MUST run the archival path before relying on it, and SHOULD do so
  before the session ends when its runtime allows it (e.g. Node.js, browsers with a WASM ML-DSA).
- Ed25519 public keys in a directory MUST be canonical encodings of points that are not of small order, and
  verifiers MUST use RFC 8032 strict verification (no ZIP-215 leniency); a small-order key would accept a forged
  signature for any message.

New algorithms are added by amending this table. A hybrid composite is expressed as a further entry of
`signatures`, not as a second receipt.

## 7. Key directory

### 7.1 Discovery, stable path and archives

The directory URL is the declaration's `keyDirectory`. By convention issuers SHOULD serve it at
`<issuer>/.well-known/x402-receipt-keys`. It is fetched with `GET`, without payment, over HTTPS, without following
redirects.

- The URL MUST be **stable**: it MUST NOT change between key lifetimes or epochs. It always returns the current
  epoch. Rotating keys produces a new epoch at the same URL, never a new URL.
- Every epoch MUST also be published, **immutably**, at `<keyDirectory>/epoch/<n>` (decimal `n`, no leading zeros),
  including the current one. The document served there MUST be byte-for-byte the same JSON value forever.
- Issuers SHOULD keep every epoch retrievable for as long as receipts signed under it may be relied on, and verifiers
  that archive receipts SHOULD archive the epoch document with them (the receipt's `keyDirectoryDigest` proves that a
  saved copy is the directory the receipt was signed under).

### 7.2 Format

```json
{
  "spec": "x402-receipt-key-directory/1",
  "issuer": "https://api.example.com",
  "epoch": 2,
  "prevRoot": "8f1c…",
  "publishedAt": 1790470800,
  "governanceKeys": [
    { "alg": "ed25519", "publicKey": "<base64>" },
    { "alg": "ml-dsa-65", "publicKey": "<base64>" }
  ],
  "keys": [
    {
      "kid": "86c139c960bb274c",
      "alg": "ml-dsa-65",
      "publicKey": "<base64>",
      "use": "x402-delivery-receipt",
      "status": "active",
      "notBefore": 1790470800,
      "notAfter": null,
      "revokedAt": null
    }
  ],
  "root": "<hex>",
  "signatures": [
    { "alg": "ed25519", "signature": "<base64>" },
    { "alg": "ml-dsa-65", "signature": "<base64>" }
  ]
}
```

| Field | Description |
|---|---|
| `spec` | `x402-receipt-key-directory/1` |
| `issuer` | Origin that owns the directory. MUST equal the origin of the URL it was fetched from. |
| `epoch` | Positive integer, incremented by one on every change. |
| `prevRoot` | `root` of epoch `epoch − 1`; 64 zeros if and only if `epoch` is 1. |
| `publishedAt` | Unix seconds from which this epoch is in force. Non-decreasing across epochs. |
| `governanceKeys` | 1–4 keys with distinct `alg`, MUST include `ed25519` and `ml-dsa-65`. They sign the directory and MUST NOT appear in `keys`. |
| `keys[]` | 1–256 entries. `kid` unique; `use` MUST be `x402-delivery-receipt` for receipt keys; `status` ∈ `reserved`, `active`, `retiring`, `retired`, `revoked`; times are unix seconds or `null`. Keys of any registered `alg` may be listed; an issuer lists at least one `ed25519` and one `ml-dsa-65` receipt key. |
| `root` | `lowercase_hex(SHA-256(JCS({spec, issuer, epoch, prevRoot, publishedAt, governanceKeys, keys})))` with `governanceKeys` sorted by `alg` and `keys` sorted by `kid`. This is the value receipts carry as `keyDirectoryDigest`. |
| `signatures` | One entry per governance key: the signature by that key over the UTF-8 message `"x402-receipt-key-directory/1" || "\n" || root`. |

`kid` is opaque to verifiers (≤ 64 characters, `[A-Za-z0-9._-]`). Issuers SHOULD derive it as the first 16 hex
characters of SHA-256 over the base64 public key text, which keeps identifiers stable across epochs.

### 7.3 Verifying one epoch

A verifier MUST check, in order: the `spec`; that the document has exactly the members of §7.2 with the declared
types; that `root` recomputes; that the governance signature **of its path's algorithm** (`ed25519` on the session
path, `ml-dsa-65` on the archival path) verifies under the governance key of that algorithm; that `issuer` equals the
fetch origin (or the expected issuer for an offline copy). It then decides **why it trusts the governance key**, and
MUST report that basis:

- `pinned` — the governance key whose signature it verified was configured out of band. RECOMMENDED for long-lived
  verification. Pinning one governance key does not vouch for a signature made by another one: a verifier that pins
  only the `ml-dsa-65` governance key and checks the `ed25519` signature has not established `pinned` trust. A
  verifier that pins SHOULD also remember the highest `(epoch, root)` it has accepted and reject a lower epoch
  (rollback) or a different root for the same epoch (equivocation). Remembering is only useful if it is enforced:
  a verifier that has accepted epoch `m` MUST reject a receipt whose chain, as supplied, ends below `m` — even when
  every document is signed by a pinned key — because the missing epochs may revoke the signing key (§7.5 step 5).
  A pinned verifier that is online SHOULD fetch the current directory from the stable URL and chain to it.
- `tls` — the key is accepted because the current directory was fetched over HTTPS from the issuer's stable URL.
  This is trust-on-first-use and MUST be reported as such.

### 7.4 Key lifecycle

A key authorizes a signature only if, at `T = payload.issuedAt`:

- `use` is `x402-delivery-receipt` and `alg` equals the signature's `alg`;
- `status` is `active` and `notBefore ≤ T` and (`notAfter` is `null` or `T ≤ notAfter`); or
- `status` is `retiring` or `retired` and `notBefore ≤ T ≤ notAfter` (both set);
- `reserved` never authorizes. `revoked` never authorizes: a holder of a revoked key can choose any `issuedAt`, so the
  signed time alone cannot show that a receipt predates revocation. (An independent time proof, e.g. a timestamp
  anchor, could lift this restriction in a later version.)

A verifier MUST also reject `issuedAt` more than its clock-skew allowance (default 300 s) in the future.

Directories are **append-only** across epochs: every key listed in epoch `n` MUST be listed in epoch `n + 1` with the
same `kid`, `alg`, `publicKey` and `use`, and its `status` only moves forward along
`reserved → active → retiring → retired`, or to `revoked` from any status. The governance keys MUST be identical in
every epoch of a chain; replacing a governance key starts a new chain and requires verifiers to re-pin (a signed
hand-over between governance keys is out of scope of this version).

### 7.5 Resolving the issuance epoch and chaining

To evaluate a receipt, a verifier:

1. Obtains the directory of epoch `payload.keyDirectoryEpoch` — from the current directory when its `epoch` is that
   value, otherwise from `<keyDirectory>/epoch/<n>` or from a saved copy — and verifies it (§7.3).
2. Checks that its `root` equals `payload.keyDirectoryDigest`; otherwise the receipt is not `trusted`
   (`KEY_DIRECTORY_DIGEST_MISMATCH`).
3. Checks that the epoch was in force at issuance: `publishedAt ≤ issuedAt + skew`, and, when the verifier holds epoch
   `n + 1`, `issuedAt ≤ publishedAt(n + 1) + skew`. A server MUST sign under the epoch in force; the skew allowance
   (default 300 s) covers the hand-over.
4. Chains forward from epoch `n` through every later epoch it holds: each `prevRoot` equals the previous `root`, epochs
   are consecutive, governance keys are identical and the append-only rule of §7.4 holds.
   - With `tls` trust, the chain MUST reach the current directory fetched from the stable URL; a gap or a fork is a
     failure. Fetching epochs `n … current − 1` from the archive path is sufficient. Verifiers SHOULD bound the
     number of epochs they fetch (e.g. 64).
   - With `pinned` trust, epoch `n` alone is sufficient (it is signed by a pinned key); later epochs, when available,
     MUST still chain, and a remembered higher epoch MUST be reached (§7.3). A result obtained without the current
     directory MUST report the latest epoch it was chained to, since revocation status is only known up to it.
   - A verifier that bounds the number of epochs MUST fail when the bound is exceeded; it MUST NOT silently drop
     documents (the dropped tail is the current epoch, which carries the latest revocations).
5. Evaluates the key lifecycle (§7.4) for the signing key both in epoch `n` and in the latest chained epoch, so a
   revocation published after issuance is honored.

## 8. Verification

### 8.1 Levels and paths

A verifier chooses a path — **session** (`ed25519`) or **archival** (`ml-dsa-65`) — and evaluates, and reports
separately:

| Level | Meaning |
|---|---|
| `integrity` | The wire object is well-formed: payload members and types, canonical encodings, and a `signatures` array that contains both baseline algorithms. |
| `authentic` | The signature of the path's algorithm verifies over the signed message under the public key of its `kid` in the directory epoch named by the payload. |
| `trusted` | The epoch resolves and chains (§7.5), its root equals `keyDirectoryDigest`, it was in force at `issuedAt`, the key authorizes the signature (§7.4), and the issuer is authorized for the resource (§8.2). |
| `settlement` | The payload matches the settlement the client observed (§8.3), and any `offer-receipt` receipt in the same `SettleResponse` agrees with it (§2.1). |
| `delivery` | The body digest (body mode), or the frame count, running digest and terminal event (stream mode), equal what the client received, and `responseStatus`, when not `null`, equals the observed status. |

A verifier MUST report which path it used. A receipt is **valid for the client** only if all five levels pass; a
level that was not evaluated has not passed, and an implementation that exposes a single "valid" verdict MUST NOT
return it as true when `settlement` or `delivery` was not evaluated, unless the caller explicitly asked for a
third-party (offline) evaluation. A verifier error (exception, unexpected input type) MUST yield a failing verdict,
never a partially evaluated passing one. A result is **long-term evidence** only if it was obtained on the archival
path with `authentic` and `trusted` passing.
An offline third party that has the receipt, the directory epoch(s) and the content can evaluate `integrity`,
`authentic`, `trusted` and `delivery`; `settlement` can then be checked against the chain (`transaction`, `logIndex`,
`payTo`, `amount`, `asset`).

### 8.2 Issuer authorization

The issuer MUST be authorized to sign for `payload.resourceUrl`. By default, a verifier accepts only an issuer
whose origin equals the origin of `resourceUrl`. A verifier MAY be configured with additional accepted issuers
(for example an independent notary that attests on behalf of a resource server); this MUST be explicit
configuration, never inferred from the receipt.

A verified receipt binds the **delivery** to the issuer's origin; it does not bind `payTo` to an operator identity.
A client that also needs "who was paid" SHOULD verify that separately, for example with the `payee-name` extension
(x402-foundation/wg-identity#36), and treat the two verdicts as independent: `payee-name` checks that the contacted
origin and the accept's `payTo` are bound to one name; this extension checks that this origin delivered this result
for this settlement. When both are present, the origin the client contacted, `payload.resourceUrl`'s origin and the
name's `org.x402.origins` SHOULD all agree; a receipt is never evidence for a payee binding on its own.

### 8.3 Settlement binding (client side)

Inside the x402 session the client MUST check:

- `payload.transaction` = `SettleResponse.transaction` and `payload.network` = `SettleResponse.network`;
- `payload.payer` = `SettleResponse.payer` (case-insensitive for EVM addresses);
- `payload.scheme`, `payload.asset`, `payload.payTo` equal the requirements the client accepted;
- `payload.amount` = `SettleResponse.amount` when present, otherwise the accepted `amount`;
- `payload.resourceUrl` and `payload.method` equal the request the client made;
- `payload.paymentId` equals the `payment-identifier` id the client sent, if any;
- when the `SettleResponse` also carries an `offer-receipt` receipt, the rule of §2.1.

The `SettleResponse` is server-supplied data: a field of an unexpected type (e.g. a non-string `payer`) is a
mismatch, not a reason to skip the comparison.

### 8.4 Failure handling

Receipts are issued after settlement, so a failed or missing receipt cannot undo a payment. A client that required
a receipt and did not get a valid one SHOULD record the failure (with the `SettleResponse`, and for streams the
frames received) as evidence for dispute resolution, and MAY stop using the server. It MUST NOT retry the payment
automatically. Missing, unconfirmed or no-longer-recoverable output is never by itself a reason to pay again: no
second payment follows automatically from any of the outcomes below, and a new payment is a new request the client
authorizes explicitly.

Four outcomes are distinct, and a client keeps them separate (informative):

- **receipt validity** — the `integrity`, `authentic` and `trusted` levels: the issuer's authorized key signed this
  receipt;
- **receipt availability** — the verifier holds octets that match `digest` (§5.5). A matching copy in the verifier's
  hands establishes only that the verifier has it; it says nothing about whether `receiptUrl` is retrievable from the
  issuer's origin today. Origin availability stays unevaluated unless there is an actual retrieval observation (a
  fetch of `receiptUrl` at a recorded time). The 30-day retention of §5.5 is about availability of the receipt, not of
  the result;
- **result recoverability** — whether the issuer can still serve the output again. This is the issuer's operational
  policy; no signature covers it and no level depends on it. Comparing the current time `now` with a declared recovery
  deadline `until` establishes only window eligibility: the window is open when `now < until` and closed when
  `now >= until` (the deadline instant itself is outside the window). An open window does not show that the issuer
  still holds a retrievable result; only an actual retrieval observation does;
- **buyer-observed output** — what the client actually captured. It is the only input to `delivery`.

A valid receipt held by the client with no captured output leaves `delivery` not evaluated ("delivery unconfirmed"):
`valid` is false and the rule above applies, so the payment is not retried automatically, whether the recovery
window is still open or has closed. A response the client saved stays verifiable against the receipt after the
issuer stops serving it. Appendix B, `deliveryUnconfirmed`, gives these cases, and both sides of the deadline, as
vectors.

## 9. Example (x402 v2, HTTP, body mode)

`PAYMENT-RESPONSE` (decoded) with the default transport — a reference of 283 octets for the
`delivery-receipt` member:

```json
{
  "success": true,
  "transaction": "0x5c6e0000000000000000000000000000000000000000000000000000000000a1",
  "network": "eip155:8453",
  "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
  "extensions": {
    "delivery-receipt": {
      "info": {
        "receiptId": "80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
        "receiptUrl": "https://api.example.com/x402/receipts/80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
        "digest": "833ac85c9562151925552435cb7db05683fcf4a69147952de8967138858cc9a2"
      }
    }
  }
}
```

`GET receiptUrl` returns the wire object as JCS text (shown indented here; the octets served, whose SHA-256 is
`digest`, are the `reference.document` member of the `endToEnd` vector in
[`delivery-receipt.vectors.json`](./delivery-receipt.vectors.json), with real keys and signatures). The same object is
what an inline `info.receipt` carries:

```json
{
  "payload": {
    "version": 1,
    "issuer": "https://api.example.com",
    "resourceUrl": "https://api.example.com/premium-data",
    "method": "GET",
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "amount": "10000",
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "transaction": "0x5c6e0000000000000000000000000000000000000000000000000000000000a1",
    "logIndex": 312,
    "paymentId": null,
    "responseStatus": null,
    "responseContentType": "application/json",
    "delivery": {
      "mode": "body",
      "sha256": "<hex SHA-256 of the body>"
    },
    "keyDirectoryEpoch": 1,
    "keyDirectoryDigest": "<root of epoch 1>",
    "issuedAt": 1790473960
  },
  "signatures": [
    { "alg": "ed25519", "kid": "<kid>", "signature": "<base64, 64 bytes>" },
    { "alg": "ml-dsa-65", "kid": "<kid>", "signature": "<base64, 3309 bytes>" }
  ]
}
```

## 10. JSON Schema of the settle-response `info`

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "receipt": {
      "type": "object",
      "properties": {
        "payload": { "type": "object" },
        "signatures": {
          "type": "array",
          "minItems": 2,
          "maxItems": 4,
          "items": {
            "type": "object",
            "properties": {
              "alg": { "type": "string" },
              "kid": { "type": "string" },
              "signature": { "type": "string" }
            },
            "required": ["alg", "kid", "signature"]
          }
        }
      },
      "required": ["payload", "signatures"]
    },
    "receiptId": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "receiptUrl": { "type": "string", "format": "uri" },
    "digest": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
  },
  "oneOf": [{ "required": ["receipt"] }, { "required": ["receiptId", "receiptUrl", "digest"] }]
}
```

The schema documents the `info` object; it is not repeated in the settle response (§5.1), so that a reference stays
within the header budget of §5.5.

## 11. Other transports

For MCP and A2A, where the `SettleResponse` travels in transport metadata, the extension is carried the same way.
Until those transport specs define a body representation, `delivery.sha256` SHOULD be computed over `JCS(result)` of
the paid tool/task result, `method` SHOULD be the transport method name (e.g. `tools/call`) and `responseStatus`
SHOULD be `200` for a non-error result. Streaming results (e.g. MCP progress notifications) MAY use stream mode with a
framing registered for that transport. Implementations MUST document what they hash.

## 12. Security and privacy considerations

- **What a receipt proves.** A valid receipt proves that the issuer's authorized key signed the stated settlement
  locator and content commitment at `issuedAt`. It does not prove that the content is correct, lawful or useful, and
  it does not by itself prove that the transfer happened — check `transaction`/`logIndex` on chain for that.
- **Self-issued.** The issuer is normally the seller. A receipt is therefore an admission by the seller, which is
  what a buyer needs in a dispute; it is not an independent witness. Independent attestation requires a
  third-party issuer accepted by explicit verifier policy (§8.2).
- **Two paths, one message.** The session path relies on Ed25519, which a cryptographically relevant quantum
  computer would break; the archival path relies on ML-DSA-65. Because both signatures cover the same message, an
  attacker who could forge Ed25519 in the future gains nothing against an archival verifier. Session-path results are
  for decisions made at the time of the exchange and MUST NOT be archived as evidence.
- **Post-quantum scope.** ML-DSA is believed to resist known classical and quantum attacks; "post-quantum" is not
  "unbreakable". Use of the FIPS 204 algorithm does not make an implementation a CMVP-validated module.
- **Directory availability.** A receipt names its directory epoch and digest, so a saved copy of that epoch is
  self-authenticating against the receipt even if the issuer's origin later disappears; verifiers that archive
  receipts SHOULD archive the epoch document with them. A directory that is reachable only at the issuer's origin is
  otherwise a single point of failure. Anchoring directory roots in a public log or on-chain is compatible with this
  format and out of scope of this version.
- **Canonicalization.** Only the subset of §3 is signed, so every conforming JCS implementation produces identical
  bytes. Verifiers MUST parse receipts and directories received as text with a parser that rejects duplicate member
  names (JSON.parse keeps the last one, other parsers the first, so a duplicate lets two verifiers — or a verifier and
  a display — read two different payloads).
- **Receipts by reference.** `receiptUrl` is an unauthenticated capability URL: anyone who learns it can read the
  receipt (and with it the payer–transaction–content link below). `receiptId` is a SHA-256 over a payload that
  contains the transaction, so it is not guessable, but clients and servers SHOULD treat the URL as confidential as
  the receipt itself. The `digest` binds the signatures as well as the payload, so a store or cache cannot swap a
  signature without detection; serving the octets `D` exactly is what makes `digest` checkable before parsing.
  Origin deletion is not cache deletion: a receipt served with a public cache policy may outlive the origin's
  retention, and an issuer MUST NOT describe origin deletion as revocation of the capability.
- **Streams.** The SSE framing hashes event data only; `event` and `id` fields are not covered. A stream receipt is
  signed at the end of the stream, after settlement: a server can stop a stream early and sign the shorter stream,
  and the receipt then states what was delivered, not what was promised.
- **Replay and de-duplication.** A receipt is bound to a single `transaction` (and `logIndex`). Verifiers that count
  receipts (e.g. for accounting) MUST de-duplicate by `(network, transaction, logIndex)`. This key also covers an
  `offer-receipt` receipt delivered in the same `SettleResponse` (§2.1): it is the same payment, not a second one.
- **Privacy.** Unlike the privacy-minimal `offer-receipt` receipt, a delivery receipt links the payer, the
  transaction and a digest of the content. Clients that share receipts publicly reveal that link. The digest does
  not reveal the content, but low-entropy responses can be confirmed by guessing.
- **Resource limits.** Verifiers SHOULD bound the size of fetched directories (e.g. 1 MiB), the number of archived
  epochs fetched per receipt (e.g. 64) and the size of receipts, and SHOULD NOT follow redirects when fetching a
  directory.

## 13. Design notes (non-normative)

- *Why a new key instead of extending `offer-receipt`?* The fields, the signed message and the trust model differ
  (content commitment, settlement locator, signature pair with a signed key directory). Keeping them separate avoids
  a breaking change to an approved extension. If maintainers prefer, the payload of §5.2 can become `offer-receipt`
  receipt payload version 2 with an additional `format` value; nothing here prevents that.
- *Why hash-then-sign?* The signed message is short and fixed-shape, so verification does not depend on
  transmitting JCS text, and the receipt id doubles as a stable content address for storage and anchoring.
- *Why a pair rather than a composite signature?* Edge runtimes can verify Ed25519 natively today and cannot verify
  ML-DSA without shipping a WASM module; two independent signatures over one message let each verifier check the one
  its environment and its purpose require, without a new composite encoding.
- *Why chain the stream digest instead of hashing the concatenation?* Each step is a fixed-size one-shot hash, which
  WebCrypto supports (it has no incremental hashing), and the per-frame length prefix makes frame boundaries part of
  the commitment.

## 14. Version history

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-10-09 | Initial draft. | FractalAI (FRACTAL AI S.A.S.) |
| 0.2.1 | 2026-10-10 | Decisions from public review (x402-foundation/x402#3758): receipts delivered **by reference by default** — `PAYMENT-RESPONSE` carries `{ receiptId, receiptUrl, digest }` within a stated 1 KB budget, the receipt is served immutable as JCS at a URL addressed by `receiptId`, `digest` checked before parsing, nothing in the body (§5.1, §5.5, §10); relationship to the legacy `x402-served` profile (§2.2); stream terminal values only in the terminal `x402-delivery-receipt` event (never an HTTP trailer), nested `reference`, browser `EventSource` rules, and a 15-minute SSE session fixture (§5.6, Appendix B). From a separate adversarial (red-team) review: no split verdict between paths (archival checks every signature); pinned verifiers enforce a remembered epoch; `valid` means five levels and never follows a verifier error; reference URLs checked before fetching; SSE CR normalisation, event-name and end-of-stream rules; registered framings only; `-0` and lone surrogates outside the signed subset; duplicate members MUST be rejected; epoch bounds fail instead of truncating; Ed25519 strict verification stated (§6.1). | FractalAI (FRACTAL AI S.A.S.) Post-review addenda: §8.2 relationship to `payee-name` (delivery is not payee identity); Appendix A table of which runtime verified each row, plus an OpenSSL-only check. Appendix A.6: worked directory-root example and the digests of common wrong projections (public review). |
| 0.2 | 2026-10-09 | From public review (x402-foundation/x402#3758): signed octets stated unambiguously with test vectors (Appendix A); `signatures[]` with an `ed25519` (session) + `ml-dsa-65` (archival) pair, directory signed by the same pair; `keyDirectoryEpoch`/`keyDirectoryDigest` in the payload, stable directory URL with per-epoch archives and chaining; stream mode; corrected `offer-receipt` framing and composition rule (§2, §2.1). The wire object of v0.1 (`alg`/`kid`/`signature`) is replaced; payload and domain identifiers stay at version 1 while the extension is a draft. | FractalAI (FRACTAL AI S.A.S.) |

## Appendix A. Test vectors

These vectors were generated by the TypeScript reference implementation (`@x402/extensions/delivery-receipt`) and
are checked by its test suite and by a second implementation (a JavaScript port of the reference,
`@fractalai/x402-receipts`) that reproduces them byte for byte; both read them from this appendix. The port shares the
reference's structure, so agreement between the two shows that the vectors are reproducible from the text, not that
two independent designs agree. All values are exact. Keys are derived from the 32-octet `seed` (Ed25519: the seed is the RFC 8032 private
key; ML-DSA: the seed is FIPS 204 `ξ`). Signatures were produced with deterministic signing; verify them rather than
re-signing if your ML-DSA signer is hedged.

This specification PR carries only the text and `delivery-receipt.vectors.json`. The TypeScript reference
implementation, its test suite and the OpenSSL-only check referenced below are proposed in a follow-up PR; until
then they are public at `johnInarti/x402`, branch `feat/delivery-receipt-extension` (commit `3cce288`).

**Which runtime checked what.** "The vectors pass" means different things per row, so each check is listed with
the runtime that performed it:

| Row | Reference + port (noble) | node:crypto / OpenSSL 3.5 (independent) | External review (#3758) |
|---|---|---|---|
| `ed25519` | id, message, key from seed, signature | id, message, key from seed, signature, tamper rejected, deterministic re-sign byte-identical | id, message, key from seed, signature |
| `ml-dsa-65` | id, message, key from seed, signature | id, message, key from seed, signature, tamper rejected | id, message, sizes only (no ML-DSA in that runtime) |
| `ml-dsa-87` | id, message, key from seed, signature | id, message, key from seed, signature, tamper rejected | id, message, sizes only |

The OpenSSL check shares no code with the reference: it builds SPKI/PKCS#8 from the published bytes (RFC 8410,
RFC 9881 seed form) and calls `crypto.verify`. It runs as `test/delivery-receipt-openssl.test.ts` and skips, rather
than passes, rows its runtime cannot verify (ML-DSA needs OpenSSL >= 3.5, Node >= 24). A size check is never
reported as a signature check.

The same payload is used for every algorithm. `jcs` is the exact UTF-8 text of `JCS(payload)` (it is ASCII here),
`receiptId` is the hex SHA-256 of those octets, and `messageHex` is the full 88-octet signed message.

<!-- VECTORS:BEGIN (generated; do not edit by hand) -->

### A.1 Payload, JCS octets, receipt id and signed message

<!-- test-vector: receipt-message -->
```json
{
  "payload": {
    "version": 1,
    "issuer": "https://api.example.com",
    "resourceUrl": "https://api.example.com/premium-data",
    "method": "GET",
    "scheme": "exact",
    "network": "eip155:8453",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
    "amount": "10000",
    "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66",
    "transaction": "0x5c6e0000000000000000000000000000000000000000000000000000000000a1",
    "logIndex": 312,
    "paymentId": null,
    "responseStatus": null,
    "responseContentType": "application/json",
    "delivery": {
      "mode": "body",
      "sha256": "98cbaf8d7df338a7b9f0331693bd866d76be025663328afdaf6b9fee2a0a5813"
    },
    "keyDirectoryEpoch": 1,
    "keyDirectoryDigest": "40b0560cd3637678eef1ff13743dfbac97ed6f153dcabebc536e3bc5e1e9e4a6",
    "issuedAt": 1790473960
  },
  "jcs": "{\"amount\":\"10000\",\"asset\":\"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\",\"delivery\":{\"mode\":\"body\",\"sha256\":\"98cbaf8d7df338a7b9f0331693bd866d76be025663328afdaf6b9fee2a0a5813\"},\"issuedAt\":1790473960,\"issuer\":\"https://api.example.com\",\"keyDirectoryDigest\":\"40b0560cd3637678eef1ff13743dfbac97ed6f153dcabebc536e3bc5e1e9e4a6\",\"keyDirectoryEpoch\":1,\"logIndex\":312,\"method\":\"GET\",\"network\":\"eip155:8453\",\"payTo\":\"0x209693Bc6afc0C5328bA36FaF03C514EF312287C\",\"payer\":\"0x857b06519E91e3A54538791bDbb0E22373e36b66\",\"paymentId\":null,\"resourceUrl\":\"https://api.example.com/premium-data\",\"responseContentType\":\"application/json\",\"responseStatus\":null,\"scheme\":\"exact\",\"transaction\":\"0x5c6e0000000000000000000000000000000000000000000000000000000000a1\",\"version\":1}",
  "receiptId": "80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
  "message": "x402-delivery-receipt/1\n80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
  "messageHex": "783430322d64656c69766572792d726563656970742f310a38303232333232346234343430356331323365656232323639616138356439383131306661626565653036363866636130333864316333363036353738363362"
}
```

### A.2 `ed25519`

<!-- test-vector: signature/ed25519 -->
```json
{
  "alg": "ed25519",
  "seed": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "kid": "ff73a0647bbc29aa",
  "publicKey": "A6EHv/POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg=",
  "receiptId": "80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
  "signature": "YIqtlQDE4GvqoP1vn4Pr99gqHOfkRS9v3qRMbUE1TRAqKi8jxdYMH0+QbTm8SSabyb88cyxQ+juyxXjfdvJOCQ=="
}
```

### A.3 `ml-dsa-65`

<!-- test-vector: signature/ml-dsa-65 -->
```json
{
  "alg": "ml-dsa-65",
  "seed": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "kid": "4159762d886caa6b",
  "publicKey": "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",
  "receiptId": "80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
  "signature": "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"
}
```

### A.4 `ml-dsa-87`

<!-- test-vector: signature/ml-dsa-87 -->
```json
{
  "alg": "ml-dsa-87",
  "seed": "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "kid": "3999779cb837b8aa",
  "publicKey": "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",
  "receiptId": "80223224b44405c123eeb2269aa85d98110fabeee0668fca038d1c360657863b",
  "signature": "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"
}
```

### A.5 Stream digest (§5.6)

`steps[0]` is `d_0`; `steps[i]` is `d_i` after frame `i`. The third frame contains a line feed (an SSE event with two `data:` lines).

<!-- test-vector: stream -->
```json
{
  "domain": "x402-delivery-stream/1",
  "frames": [
    "{\"seq\":0,\"price\":\"64000\"}",
    "{\"seq\":1,\"price\":\"64001\"}",
    "line one\nline two"
  ],
  "steps": [
    "f38eaa175a3004a7239699a2c292c0de5db607f4e9c76679bd4531b130fca732",
    "4ce4b2253fb3af27b9ab68ec43eef84b63872245569d451d3c03e0c3ce749fd8",
    "d3f4f9db742048db0fb291a969a67eb92f2b901245d9db2e9102869be60b8dc3",
    "3cadd9495a2863d2faffaebd7c4c5a8f76f75baa1d480fbaddb0fc92aa4a6df8"
  ],
  "frameCount": 3,
  "digest": "3cadd9495a2863d2faffaebd7c4c5a8f76f75baa1d480fbaddb0fc92aa4a6df8"
}
```

<!-- VECTORS:END -->

### A.6 Key directory root (§7.2), worked example

The directory of Appendix B (`endToEnd.directory`) has nine members. The root covers **exactly seven** of them:
`root` and `signatures` are outside the preimage, `governanceKeys` is sorted by `alg` and `keys` by `kid`
(here `ed25519, ml-dsa-65` and `153053ad13ee065b, c47ca781ddf6ace8`).

```
preimage = JCS({spec, issuer, epoch, prevRoot, publishedAt, governanceKeys, keys})   → 5905 UTF-8 octets
root     = lowercase_hex(SHA-256(preimage))
         = 40b0560cd3637678eef1ff13743dfbac97ed6f153dcabebc536e3bc5e1e9e4a6
```

A verifier that gets another value has almost always hashed a different projection. These are the common ones,
with the digest each produces for this vector, so a mismatch can be diagnosed instead of read as a broken directory
(the pattern was found in public review, x402-foundation/x402#3758):

| Projection hashed (wrong) | SHA-256 |
|---|---|
| document without `signatures`, but **`root` still inside** | `d2b584052f3b4eba60f9623067c6fa899441121ad867985693462750bd231bc1` |
| whole document, `root` and `signatures` included | `b781c6532561bae7fe3c855a33203c4c9b882cca53bde9b3fbb6aa2903aeb0c6` |
| seven members, arrays **not sorted** (here: reversed) | `d7b1a34dc2bc97c4f931023713137c381974d522bad7f5053de67f6ec7d9f412` |
| six members, `publishedAt` omitted | `0c5c80bc9a971aeb6b619e9e33e53c176b3bffd56a6b904864a117e5b9a54d89` |
| seven members serialised with insertion order instead of JCS | `23d5a755a17f2b9e1eda158a8c5de73168a11530a16106d0713579157278fbd1` |

Sorting matters only when an issuer serves the arrays in another order; a directory that already serves them sorted
gives the same root with or without the sort, so test with the reversed row above. This appendix is informative: the
normative construction is the `root` row of §7.2.

### A.7 Expected verdicts in the vectors file

The fixtures of `delivery-receipt.vectors.json` are data; what a verifier must conclude from them is stated
separately, in the top-level member `expectedVerdicts`, so that adding an expectation never changes a fixture. Each
entry is one verifier run:

| Member | Meaning |
|---|---|
| `id` | Unique name of the run. |
| `vector` | JSON Pointer (RFC 6901) to the fixture the run is about. |
| `path` | `session` or `archival` (§8.1). |
| `offline` | `true` only for an explicitly requested third-party evaluation (§8.1). |
| `inputs` | What the verifier is given, by role: `receipt`, or `reference` + `receiptDocument` (the octets served at `receiptUrl`), or `eventStream`; `directory`; `pinnedGovernanceKeys` (trust basis `pinned`, §7.3); `now`; and what the client observed: `settle`, `requirements`, `resourceUrl`, `method`, `responseBody`, `responseStatus`. A role that is absent was not available to the verifier. A value of the form `{ "$ref": "<JSON Pointer>" }` refers to a value elsewhere in the file; any other value is literal. |
| `levels` | The result of each of the five levels of §8.1 — `integrity`, `authentic`, `trusted`, `settlement`, `delivery` — as `"pass"`, `"fail"` or `"not-evaluated"`. |
| `valid` | The single "valid for the client" verdict of §8.1. |
| `longTermEvidence` | Whether the result is long-term evidence (§8.1). |
| `reason` | `null` when `valid` is `true`; otherwise `{ "level", "code" }`: the first level that did not pass and why. |
| `outcomes` | Optional. The four outcomes of §8.4: `receiptValidity` (`valid` when `integrity`, `authentic` and `trusted` pass); `receiptAvailability` (`receiptAvailableToVerifier` when `receiptDocument` hashes to the reference `digest` — the verifier holds a matching copy; availability at the issuer's origin is not evaluated, since no run has a retrieval observation); `resultRecoverability` (`window-open` when `now < recoveryWindow.until`, `expired` when `now >= recoveryWindow.until`; the value `recoverable` is reserved for a run whose inputs record an actual retrieval of the result from the issuer, and no run in this file has one); and `buyerObservedOutput` (`captured` when `inputs` has `responseBody` or `eventStream`, otherwise `none`). Each is computable from the file. |
| `automaticRepayment` | Optional. Always `false`: §8.4 forbids retrying the payment automatically, and missing output never triggers a second payment. |

A verifier conforms on a run when it reports the same `path`, the same value for each of the five levels, and the
same `valid` and `longTermEvidence`. `reason.level` is part of the expectation; `reason.code` is compared only for
codes this specification defines (`KEY_DIRECTORY_DIGEST_MISMATCH`, §7.5 step 2, and `DELIVERY_UNCONFIRMED`: the
`delivery` level was not evaluated because the client holds no observed content to compare). Other codes in the
file are diagnostics of the reference implementation. This convention restates §8.1 and adds no requirement to it.

## Appendix B. End-to-end vector

[`delivery-receipt.vectors.json`](./delivery-receipt.vectors.json) contains, besides the vectors above:

- `endToEnd`: a complete key directory (epoch 1, governance pair, receipt-key pair), the receipt the reference
  implementation issues for the example of §9 (both signatures), the body, the settlement and the requirements, and a
  complete SSE event stream with its terminal event (receipt inline). With the governance keys pinned, it must verify
  on both paths at `now`, with every level passing.
- `endToEnd.reference`: the same receipt delivered by reference (§5.5) — the settle-response member, its size in
  octets (within the 1 KB budget) and the exact `document` served at `receiptUrl`, whose SHA-256 is `digest`.
- `streamSession`: a paid SSE route modelled on a real one — one response held open for a 15-minute window, events
  `hello`, `pool` and `expired`, keep-alive comments, `retry:` and `id:` fields, one two-line event and one event
  written with CRLF — with the receipt by reference in the terminal `x402-delivery-receipt` event. It gives the event
  stream, the events an `EventSource` dispatches, the frames, `frameCount`, `digest`, the terminal event, the receipt
  document, and the `recipe` (frames, event names, ids and raw lines in order) from which a writer reproduces the
  stream byte for byte. The data is synthetic; keys and directory are those of `endToEnd`.
- `expectedVerdicts`: the expected result of each verifier run over the fixtures above, in the convention of A.7 —
  `endToEnd` (body, by reference and SSE) and `streamSession`, each on both paths, all five levels passing.
- `deliveryUnconfirmed`: the negative fixture of §8.4. The buyer holds the `endToEnd` receipt document, directory,
  `SettleResponse` and requirements, but no response body, and verifies at `now`, one hour after the issuer's
  24-hour `recoveryWindow` closed (synthetic values). Expected, on both paths: `integrity`, `authentic`, `trusted` and
  `settlement` pass, `delivery` is not evaluated, `valid` is false with reason `DELIVERY_UNCONFIRMED`, no automatic
  repayment; outcomes `valid` / `receiptAvailableToVerifier` / `expired` / `none`. A companion run with the body the
  buyer saved passes all five levels at the same `now`: recoverability and observed output are independent. Two
  boundary runs (session path, no output, `now` given literally) fix the deadline: at `now = until - 1` the outcome
  is `window-open`, at `now = until` it is `expired`; the levels, `valid`, `reason` and `automaticRepayment` are the
  same on both sides.
