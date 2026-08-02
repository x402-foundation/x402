# Extension: `discovery` — DNS + `.well-known` records for x402

## Summary

The `discovery` extension defines how x402 participants — facilitators and
resource servers — publish their payment capabilities **out-of-band**, so that
clients, agents, and indexers can find them without prior knowledge or a
central directory. It uses two standard, DNS-era mechanisms:

1. A **`/.well-known/x402` manifest** ([RFC 8615]) served over HTTPS — the
   authoritative, machine-readable record of a host's x402 capabilities.
2. An optional **DNS TXT record** at `_x402.<domain>` — a lightweight pointer
   that lets crawlers discover x402 capability from DNS alone, before making
   any HTTP request.

This mirrors how email solved the same problem: DNS records (MX/SPF/DKIM,
and most directly [MTA-STS], which is exactly "TXT record points to an HTTPS
policy file") made mail servers discoverable and their policies verifiable
without a registry. x402's in-band design already makes *payment terms*
self-describing at the moment a client hits a 402; this extension makes
*capability* discoverable **before** first contact, and makes curated
directories optional caches rather than load-bearing infrastructure.

## Motivation

x402 today has three discovery directions in three different states:

- **"What does this resource cost?"** — solved in-band. The 402 response's
  `accepts[]` is self-describing.
- **"What resources exist?"** — addressed by the `bazaar` extension and
  facilitator discovery APIs.
- **"What facilitators exist, and what do they support?"** — unsolved.
  Today this is hardcoded configuration and hand-curated lists (npm
  packages, directory sites). Lists rot, don't scale, and centralize
  what should be edge-published data — the ecosystem-page sunset made
  this concrete.

A facilitator that can publish one JSON file and one TXT record becomes
discoverable by any client on the internet with zero gatekeepers. Indexers
(x402scan and peers) can crawl, verify, and rank records instead of accepting
PRs. Agents can answer "find me a facilitator that settles `exact` on network
X for asset Y" by resolution, not by shipping a config file.

## The `.well-known/x402` manifest

A host participating in x402 SHOULD serve a JSON manifest at:

```
https://<host>/.well-known/x402
```

`Content-Type: application/json`. CORS SHOULD allow `GET` from any origin
(the manifest is public data). The manifest MUST be served over HTTPS.

### Schema

```json
{
  "x402Version": 1,
  "kind": "facilitator",
  "name": "Example Facilitator",
  "description": "One-line human description.",
  "facilitator": {
    "baseUrl": "https://facilitator.example.com",
    "endpoints": {
      "supported": "/supported",
      "verify": "/verify",
      "settle": "/settle"
    },
    "kinds": [
      { "x402Version": 1, "scheme": "exact", "network": "coston2" }
    ],
    "assets": [
      {
        "network": "coston2",
        "address": "0x1F930B6A9F68c91aB23db07a9c4A5Dc166eF8011",
        "symbol": "FCUSD",
        "decimals": 6,
        "standard": "EIP-3009"
      }
    ]
  },
  "resources": [
    {
      "url": "https://facilitator.example.com/demo/card",
      "method": "POST",
      "description": "x402-paywalled demo resource"
    }
  ],
  "attestation": {
    "type": "none"
  },
  "docs": "https://facilitator.example.com/",
  "contact": "ops@example.com",
  "updated": "2026-07-29T00:00:00Z"
}
```

### Field semantics

| Field | Req | Meaning |
|---|---|---|
| `x402Version` | MUST | Highest x402 protocol version the host speaks. |
| `kind` | MUST | `"facilitator"`, `"resource-server"`, or `"both"`. |
| `name`, `description` | SHOULD | Human-readable identification. |
| `facilitator` | MUST if kind includes facilitator | Capability block. |
| `facilitator.baseUrl` | MUST | HTTPS base URL of the facilitator API. It **MUST** be on the same domain as, or a subdomain of, the host serving the manifest, and consumers **MUST** reject manifests that violate this. Without it a host can name someone else's facilitator as its own — the very thing the `wk` same-origin rule exists to prevent — and turn every conforming crawler into a request amplifier aimed at a third party. |
| `facilitator.endpoints` | MUST | Relative paths for `supported`/`verify`/`settle` (hosts differ; don't guess). |
| `facilitator.kinds` | MUST | **Live mirror of `GET {baseUrl}{endpoints.supported}`.** Divergence between the manifest and the live endpoint is a misconfiguration; consumers MUST prefer the live endpoint. |
| `facilitator.assets` | SHOULD | Settleable assets per network, with the token standard the scheme relies on (e.g. `EIP-3009`). |
| `resources` | MAY | x402-paywalled resources on this host, `bazaar`-compatible: indexers that speak `bazaar` can probe each URL for the full 402 + `extensions.bazaar` description. Each `url` **MUST** be HTTPS and on the manifest's own domain or a subdomain. Consumers **MUST NOT** dereference entries that are not, and SHOULD treat their presence as an abuse signal rather than silently discarding them. Because this document invites indexers to fetch these URLs, an unconstrained field is server-side request forgery by specification — a host listing `http://169.254.169.254/…` or an internal address has every conforming crawler dereference it from inside the crawler's own network. |
| `attestation` | MAY | Execution-integrity claims: `{"type":"none"}`, or e.g. `{"type":"tee","scheme":"confidential-space","verifier":"<url>"}`. See Security. |
| `updated` | SHOULD | ISO-8601 timestamp of last manifest change; consumers use it for cache decisions alongside HTTP caching headers. |

Unknown fields MUST be ignored (forward compatibility).

## The DNS TXT record

A domain MAY additionally publish a TXT record at the label `_x402.<domain>`:

```
_x402.example.com.  IN  TXT  "v=x402-1; wk=https://facilitator.example.com/.well-known/x402; k=facilitator; net=coston2; scheme=exact"
```

Keys (semicolon-separated, order-insensitive):

| Key | Req | Meaning |
|---|---|---|
| `v` | MUST | `x402-1` (record format version). |
| `wk` | MUST | Absolute HTTPS URL of the manifest. MUST be on `<domain>` or a subdomain of `<domain>` (see Security). |
| `k` | SHOULD | `facilitator` / `resource-server` / `both` — coarse filter so crawlers can skip fetches. |
| `net` | MAY | Comma-separated network ids (coarse filter only). |
| `scheme` | MAY | Comma-separated scheme names (coarse filter only). |

A domain **MUST** publish at most one `v=x402-1` record. Consumers that find
more than one **MUST** treat the name as unresolvable rather than choosing
between them: "first record wins" is a race that anyone able to add a single
TXT record can win by ordering — a shared DNS panel, a delegated subdomain, a
partial compromise. [SPF] and [DMARC] both make duplicates a hard error for
precisely this reason, and it is worth inheriting rather than rediscovering.

The TXT record is a **pointer, not an authority**: all capability data comes
from the manifest, which comes over HTTPS. This split (unauthenticated DNS
pointer → authenticated HTTPS policy) is the [MTA-STS] pattern and keeps the
extension useful even where DNSSEC is absent.

Hosts without DNS control (e.g. platform subdomains like `*.run.app`) simply
publish the manifest alone — resolution step 2 below still finds them.

## Resolution algorithm

Given a domain `D`, a client resolves x402 capability as:

1. Query TXT for `_x402.D`. If a record with `v=x402-1` exists, fetch the
   manifest from its `wk` URL (rejecting non-HTTPS or out-of-domain URLs).
   Consumers **MUST** re-apply the in-domain constraint to **every redirect
   hop**, and report the final URL as the manifest source. Checking only the
   URL that was requested validates a location the bytes need not have come
   from: an in-domain `wk` that redirects off-domain otherwise passes, which
   defeats the one control the (unauthenticated) DNS layer has. Redirect
   chains SHOULD be bounded.
2. Otherwise, attempt `GET https://D/.well-known/x402`.
3. Validate the manifest shape; ignore unknown fields.
4. Before *using* a facilitator, fetch `{baseUrl}{endpoints.supported}` and
   treat the live response as authoritative over the manifest's `kinds`.

Steps 1–2 answer "does this domain speak x402, and in what role" with at most
one DNS query and one HTTP GET. Indexers crawl the same way and SHOULD
periodically re-verify records.

**Consumers MUST bound the manifest fetch** — a request timeout and a maximum
response size (256 KiB is generous for this document; our reference
implementation uses that, with a 10 s deadline and at most 3 redirect hops).
An unbounded read is a denial-of-service handed to anyone who can publish a
TXT record: a hostile host serves a multi-gigabyte body, or trickles bytes
indefinitely, and the crawler exhausts memory or hangs. Size limits **MUST**
be applied to the bytes actually received, not to `Content-Length`, which is
the server's claim rather than a measurement.

## Security considerations

- **Discovery is not endorsement.** A manifest proves a host *claims* a
  capability; it transfers no trust. Clients MUST validate settlement the
  way x402 already requires (the on-chain transaction is the receipt), and
  SHOULD apply their own reputation/allowlist policy on top.
- **DNS spoofing**: the TXT record is unauthenticated without DNSSEC; that is
  why it may only point *into the same domain*, and why the manifest — served
  under the domain's TLS certificate — is the authority. An attacker who can
  forge the TXT record but not the domain's HTTPS gains nothing.
- **Same-origin constraint on `wk`** prevents a domain from claiming another
  operator's facilitator as its own (or being used as an open redirect for
  crawler traffic). This holds only if consumers enforce it on every redirect
  hop and on `facilitator.baseUrl`, not on the requested URL alone.
- **Servers MUST NOT derive manifest URLs from request-controlled input.**
  A manifest that builds its own `baseUrl`/`resources`/`docs` from the `Host`
  or `X-Forwarded-Host` header lets any caller make the document — served
  under the operator's own TLS certificate — advertise an attacker's host,
  and a cacheable response without a matching `Vary` can then be replayed to
  other crawlers. Pin the public origin to configuration. This is the same
  attack the `wk` rule addresses, arriving on the side this document calls
  authoritative, and it is easy to introduce precisely because deriving the
  origin from the request looks like good hygiene.
- **DNSSEC upgrades the TXT record from a hint to an assertion.** Unsigned,
  the record is a convenience that the HTTPS manifest must backstop. Signed,
  a resolver can prove the delegation was not tampered with, and the
  `AD` flag is what demonstrates it — the presence of `DS` and `DNSKEY`
  records shows only that keys were published, not that they agree.
  Operators SHOULD sign zones carrying `_x402` records, and SHOULD monitor
  RRSIG expiry: an expired signature fails validation exactly like a forged
  one, so the record — and the discovery path — disappears on a timer.
- **Manifest/live divergence**: consumers MUST prefer live `supported` data;
  indexers SHOULD flag divergent hosts.
- **Attestation claims** (`attestation` field) are claims like everything
  else: a `tee` attestation is only meaningful if the verifier URL lets the
  client independently check a quote/token chain (e.g. a Confidential Space
  token whose image digest matches a published, reproducible build). Absent
  verification, treat as `none`.
- **Crawler load**: manifests are static JSON; hosts SHOULD serve them with
  cache headers. Rate-limit as any public endpoint.

## Relationship to other mechanisms

- **`bazaar`** describes *resources* in-band (inside a 402). `discovery`
  describes *hosts* out-of-band. They compose: a crawler finds a host via
  `discovery`, then probes its `resources` list and reads `bazaar` blocks.
- **Curated lists** (npm `facilitators` package, directory sites) become
  caches of `discovery` data rather than sources of truth — they can be
  regenerated by crawling.
- **On-chain registries** (future work): a chain contract mapping
  `(network, scheme, asset) → facilitator` entries with stake or attestation
  behind each entry would give the trustless version of this extension; the
  manifest's `attestation` field is designed so on-chain anchors can slot in
  (`{"type":"onchain","registry":"<chain>:<address>","entry":"<id>"}`).

## Reference implementation

The FlareClaw x402 facilitator (first public x402 facilitator on Flare,
Coston2 testnet) publishes a live record at:

```
https://x402-facilitator-427961920698.us-central1.run.app/.well-known/x402
```

(Platform-subdomain host, so it exercises the manifest-only path; the TXT
grammar has a reference parser in the same codebase.)

[RFC 8615]: https://www.rfc-editor.org/rfc/rfc8615
[SPF]: https://www.rfc-editor.org/rfc/rfc7208#section-4.5
[DMARC]: https://www.rfc-editor.org/rfc/rfc7489#section-6.6.3
[MTA-STS]: https://www.rfc-editor.org/rfc/rfc8461
