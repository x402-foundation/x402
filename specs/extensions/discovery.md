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
  "x402Version": 2,
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
| `x402Version` | MUST | Highest x402 protocol version the host speaks. MUST be a JSON number (integer), not a string, and MUST NOT be spelled `version` — the field carries the same name and type as the `x402Version` in the host's own 402 challenge. See Migration. |
| `kind` | MUST | `"facilitator"`, `"resource-server"`, or `"both"`. |
| `name`, `description` | SHOULD | Human-readable identification. |
| `facilitator` | MUST if `kind` includes facilitator; MAY if `kind` is `resource-server` | **When `kind` includes facilitator: an object** — the capability block described by the rows below — and a consumer **MUST** reject a non-object value. **When `kind` is `resource-server`: a string** is permitted, and names the HTTPS base URL of the facilitator this host routes its payments through. A string `facilitator` is a *pointer*, not a capability block: consumers **MUST NOT** dereference it directly — it is a third party, so the same-origin rule on `facilitator.baseUrl` cannot protect that fetch — and **MAY** instead discover the named facilitator by running this same procedure against its host, whose own manifest is same-origin for it. This is the shape already deployed: of 14 publishers carrying the field in Circadian-agent's 171-host census on 2026-08-23 — a corpus that partially overlaps ours, not an independent sample — 12 publish a string with this meaning and 0 publish a conforming object (x402#2979). The extension gives that incumbent a defined meaning rather than leaving a lenient consumer to invent one. |
| `facilitator.baseUrl` | MUST | HTTPS base URL of the facilitator API. It **MUST** be on the same domain as, or a subdomain of, the host serving the manifest, and consumers **MUST** reject manifests that violate this. Without it a host can name someone else's facilitator as its own — the very thing the `wk` same-origin rule exists to prevent — and turn every conforming crawler into a request amplifier aimed at a third party. |
| `facilitator.endpoints` | MUST | Relative paths for `supported`/`verify`/`settle` (hosts differ; don't guess). |
| `facilitator.kinds` | MUST | **Live mirror of `GET {baseUrl}{endpoints.supported}`.** Divergence between the manifest and the live endpoint is a misconfiguration; consumers MUST prefer the live endpoint. |
| `facilitator.assets` | SHOULD | Settleable assets per network, with the token standard the scheme relies on (e.g. `EIP-3009`). |
| `resources` | MAY | x402-paywalled resources on this host, `bazaar`-compatible: indexers that speak `bazaar` can probe each URL for the full 402 + `extensions.bazaar` description. Each `url` **MUST** be HTTPS and on the manifest's own domain or a subdomain. Consumers **MUST NOT** dereference entries that are not, and SHOULD treat their presence as an abuse signal rather than silently discarding them. Because this document invites indexers to fetch these URLs, an unconstrained field is server-side request forgery by specification — a host listing `http://169.254.169.254/…` or an internal address has every conforming crawler dereference it from inside the crawler's own network. |
| `attestation` | MAY | Execution-integrity claims: `{"type":"none"}`, or e.g. `{"type":"tee","scheme":"confidential-space","verifier":"<url>"}`. See Security. |
| `peers` | MAY | Up to 32 bare domain names of other hosts believed to publish x402 discovery data. Hints only, never vouchers — see Peer hints. |
| `updated` | SHOULD | ISO-8601 timestamp of last manifest change; consumers use it for cache decisions alongside HTTP caching headers. |

Unknown fields MUST be ignored (forward compatibility).

### Resource entries: bare pointer or complete

A `resources` entry MUST be either a **bare pointer** — `url`, and optionally `method` and
`description` — or a **complete** payment description carrying every field a client needs
to construct a payment without a round trip. A partially populated entry MUST NOT be
published, and consumers MUST treat one as a bare pointer: dereference the `url`, take the
402 as authoritative, and ignore the partial fields entirely.

An entry MAY also be a bare **string**, which MUST be treated as exactly equivalent to
`{"url": <string>}` and therefore as a bare pointer. This is not a courtesy to sloppy
publishers: it is the modal deployed shape. In a survey of 1,619 catalogued hosts, 380 of
the 442 that publish a version-like key outside this specification's vocabulary carry
`resources` as an array of strings, and a partially overlapping 171-host census reports 52 of 76.
Leaving the type undefined would leave a strict consumer type-erroring on the most common
manifest on the network while a lenient one invented this same coercion privately — which
is the mechanism this extension exists to stop, reproduced one layer down.

Consumers MUST NOT infer any other field from a string entry. A string says where, and
nothing about price, network or scheme; those come from the 402.

The reason is that payment data rots and the 402 challenge does not. A complete entry is a
standing promise to keep `asset` and `payTo` correct forever; a bare pointer delegates that
to the endpoint, which is already authoritative and already has to be right. There is no
value in the middle: a consumer that cannot trust the block to be complete has to fetch the
402 anyway, so the partial fields buy nothing and can only be wrong.

Publish a complete entry only if you intend to serve payment data statically and keep it
fresh. Otherwise publish the pointer.

### Peer hints (`peers`)

A manifest MAY carry a `peers` array of bare registrable domain names — no
scheme, no path, no port — of other hosts the publisher believes publish x402
discovery data:

```json
"peers": ["facilitator-b.example", "indexer.example.org"]
```

Peers are **hints, not vouchers**. A consumer treats each entry as nothing
more than a domain name to feed back into the resolution algorithm from the
beginning: its own TXT lookup, its own manifest fetch, every bound and
refusal in this document applied unchanged. No capability, reputation, or
trust of any kind transfers from the referring manifest — an entry is only a
name, so there is nothing to transfer.

Rules:

- A manifest MUST NOT list more than **32** peers. Consumers MUST ignore
  entries beyond the cap, and indexers SHOULD flag manifests that exceed it.
- Entries MUST be bare DNS names. Consumers MUST ignore entries carrying a
  scheme, path, port, or userinfo, IP-address literals, and the manifest's
  own domain.
- Crawlers SHOULD dedupe the frontier globally and bound traversal depth as
  in any web crawl. The peer graph is public, attacker-writable input; each
  name is hostile until it has resolved on its own.
- Crawlers SHOULD additionally enforce **frontier diversity by registrable
  domain**. The 32-entry cap bounds fan-out per manifest; it bounds nothing
  per operator, and deployment data makes the gap concrete: in a census of
  1,521 live hosts, four single-operator domains each hold 32 or more hosts
  of their own, so any of them can fill an entire peers array without naming
  anything it does not control — a crawler seeded inside such a fleet walks
  a full frontier and never leaves. Diversity belongs to the consumer's
  crawl budget, not the record grammar: when scheduling the frontier, prefer
  names under registrable domains not yet visited, and treat a frontier
  dominated by one registrable domain as measuring an operator's fleet
  rather than the network.
- "Registrable domain" SHOULD be judged against the public-suffix boundary,
  not by counting labels. The same census makes the failure concrete from the
  other side: 394 of the 1,521 hosts sit directly under shared-platform
  suffixes (`vercel.app` 202, `workers.dev` 72, `up.railway.app` 66,
  `onrender.com` 27, and the rest across `fly.dev`, `replit.app`,
  `netlify.app`, `a.run.app`, `sslip.io`, `nip.io`), where each name is a
  DIFFERENT operator deploying on a common platform. A last-two-labels rule
  collapses those 394 operators into ten buckets and hands the most
  operator-diverse quarter of the network one operator's crawl budget —
  inverting the diversity rule's intent. Consumers that do not carry a full
  Public Suffix List can satisfy this with a short static list of operator
  boundaries treated as public — with one care: each entry is the DEPTH at
  which a new operator begins, and that depth differs per platform. A
  Cloudflare account sits directly under `workers.dev` (the worker name
  above the account is not a new operator), while Railway tenants sit under
  `up.railway.app` and Cloud Run services under `a.run.app` — an entry of
  `railway.app` or `run.app` merges every tenant into a single bucket, the
  same failure this rule exists to prevent, one level down. The test for a
  candidate entry: if the label directly above it changes hands between
  unrelated parties, the boundary is below it, not at it — and the test is
  mechanical, so run it as a script over census data rather than reading
  platform documentation; a scripted pass is what caught the second case.
  Wildcard-DNS mappers (`sslip.io`, `nip.io`) belong on such lists for a
  different reason: every name under them resolves for whoever asks and
  there is no account level at all, so the operator-boundary test does not
  apply — they are listed so each name stands alone. Ten boundaries cover
  every platform host in the census today, at the cost of occasional
  updates as new platforms appear in the wild.

Why this exists: with peer hints the network is crawlable from **any seed**.
One known-good domain reaches its connected component with no directory, no
registry, and no gatekeeper — curated lists stop being load-bearing even for
bootstrap. Sybil clusters can list each other freely and gain nothing,
because listing confers nothing: every name still has to resolve, serve a
manifest under its own TLS certificate, and pass every check alone. This is
the address-gossip pattern proven by Bitcoin `addr` relay, NNTP feeds, and
fediverse instance peers: **existence spreads peer-to-peer; trust never
does.**

The claim this section makes is testable, and should be tested rather than
asserted: the number that matters is **coverage** — the fraction of
independently censused hosts a peer-crawl reaches from a single seed,
checked against the census as ground truth. Entries-per-manifest is
bookkeeping; coverage is whether the directory bootstrap is actually gone.

### Migration

Two changes affect already-deployed manifests. Both are mechanical, and in both cases the
correct value can be verified against the host's own endpoint rather than against this
document.

**`version` → `x402Version`.** Deployments spelling this field `version` should rename it.
The value does not change. A census of 260 live payment-gated hosts found 139 readable 402
challenges, and **all 139** spell the field `x402Version`, every one typed as an integer.
The protocol therefore already has one unanimous name for this field on the wire, and a
manifest spelling it differently makes the same protocol call one thing two names in two
documents that ship together. Confirm the value by reading your own 402 response.

**Partial resource entries.** For an entry in the middle state, the cheaper compliant move
is usually **removing** the partial payment fields rather than completing them — a bare
pointer is fully conforming and carries no maintenance obligation. Of 205 manifests observed
in the middle state, 188 were missing `asset` and 144 were missing `payTo`; for those,
deletion is both less work and less to keep correct. Complete the block only if serving
static payment data is a deliberate choice.

*(Deployment figures here, and the DNS census cited in the TXT section, are from
independent measurements by [@meloliva14](https://github.com/meloliva14), published at
[meloliva14/x402-measure](https://github.com/meloliva14/x402-measure); re-runnable against
any revision of this document.)*

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

Consumers **MUST** ignore a record that does not parse under this grammar —
a missing or unrecognized `v` token, an absent or non-HTTPS `wk` — and
continue to resolution step 2 exactly as if no record existed. The label is
already occupied, in several incompatible spellings, by records that do not
parse under this document; the generated table below carries the current
counts, the name set they were drawn from, and the date. Those numbers are
deliberately not restated here — a hand-written count beside a generated block
is a second source of truth and always the one that rots. Treating a malformed
record as an absence rather than an error
keeps the manifest-only fallback reachable for exactly the hosts that most
need it: a publisher has no in-band way to learn their record is malformed —
a wrong TXT record produces no error anywhere — so a hard failure here would
silently unlist them everywhere at once. Indexers SHOULD flag records that
exist at the label but fail to parse, since an indexer's report is the only
feedback channel such a publisher has.

The TXT record is a **pointer, not an authority**: all capability data comes
from the manifest, which comes over HTTPS. This split (unauthenticated DNS
pointer → authenticated HTTPS policy) is the [MTA-STS] pattern and keeps the
extension useful even where DNSSEC is absent.

Hosts without DNS control (e.g. platform subdomains like `*.run.app`) simply
publish the manifest alone — resolution step 2 below still finds them.

### Spellings observed in the wild

<!-- GENERATED by scripts/x402/txt-records.ts — do not edit by hand. -->
A walk of 2,235 names over 1,611 catalogued hosts, 2026-08-23, found
**7 records across 6 operators: 5 non-conforming, and 2 names
belonging to the one operator that conforms.** They are recorded here so that a
lenient consumer does not privately invent a coercion for them, which is the
failure this extension exists to prevent:

| observed | records | why it is not a record |
|---|---|---|
| `https://host/.well-known/x402` (bare URL) | 2 | no `v=`, no pointer token |
| `v=x4021;descriptor=…;url=https://…` | 1 | conforms to **draft-jeftovic-x402-dns-discovery** §4, a different published draft |
| `v=x4021;url=https://…` | 1 | conforms to **draft-jeftovic-x402-dns-discovery** §4, a different published draft |
| `x402-manifest=https://…` | 1 | no `v=`; unrecognised pointer token |
| `v=x402-1; wk=https://…` | 2 | **conforming** — one operator publishing at both apex and host |

⚠️ **2 of these 5 are not malformed — they conform to a different draft.**
`draft-jeftovic-x402-dns-discovery` §4 defines `version = "x4021"` as a literal and
`url=` as its pointer, and one of the two records is that draft's own example with
the domain substituted. So a consumer refusing them is not rejecting a malformed
record — it is
**declining to honour another specification's conforming publishers**, which is a
spec-conflict decision and belongs to the working group rather than to this table.
Recorded here so that nobody reads the row above as a spelling mistake.

This is a **floor, not a census**: the name set is seeded from the
catalogue, so it can only find records at names the catalogue already
knows. It bounds the population from below and cannot establish a total.

<!-- END GENERATED -->

Consumers **MUST NOT** accept any of them under *this* grammar: each fails the
version check before the pointer is ever considered, and each is treated as
absent under step 1 rather than as an error — a publisher has no in-band way to learn their
record is malformed, so an absent verdict is the one that lets them keep serving
while the manifest path still works.

**The version token is the load-bearing half, not the pointer.** `_x402` is a
dedicated label, but a dedicated label is not a guarantee: zones put SPF
fragments, verification strings and wildcard answers at names nobody expected.
`v=x402-1` is what lets a consumer say *this TXT is an x402 record* rather than
*this name returned something*. Accepting a bare URL would surrender that for a
spelling no operator would then be required to fix.

For the same reason this extension does **not** alias `url=` to `wk=`. Every
record above fails on `v=` as well, so an alias would convert no existing
publisher while leaving two spellings in the grammar permanently.

**The two `v=x4021` records are a different matter and this document does not
settle it.** They are conforming publishers of `draft-jeftovic-x402-dns-discovery`,
which reached the same primitive independently and earlier — a `_x402` TXT record
pointing at an HTTPS manifest — with an incompatible spelling. Two drafts sharing
a registered label and disagreeing on its grammar is a question for the working
group and the IANA registrant, not something to resolve by whichever consumer
ships first. Until it is settled, a consumer following this document treats those
records as absent and falls through to the well-known path, which is the outcome
that harms neither publisher.

## Resolution algorithm

### Comparing host names

Every comparison of two host names in this document — a `wk` URL's host against
`D`, a referenced URL's host against an ancestor `A`, a host `H` against `A`,
`facilitator.baseUrl` against the manifest's host — is a comparison of **DNS
names**, not of octet strings. Consumers **MUST** compare case-insensitively,
on A-labels (an internationalised name is converted with IDNA before comparing,
so a U-label and its A-label are the same name), and ignoring a trailing dot
(`api.example.com.` and `api.example.com` are the same name). A comparison that
treats any of those pairs as different fails *closed*: it scores a conforming
publisher's `wk` as out-of-domain and drops them from discovery with nothing
logged, which is the failure direction nobody reports.

### Determining `D` from a resource URL

A consumer usually holds a **resource URL**, not a domain. This section says how
to get from one to the other; the algorithm below then takes `D` as given.

Querying only `_x402.<exact-host>` is not sufficient, and the failure is not
theoretical: a survey of 1,609 catalogued hosts on 2026-08-22 recorded **this
extension's own author as publishing nothing**, because the record sits at the
apex while its `wk` target is a service subdomain. One DNS zone in front of
several service hosts is the natural arrangement, and the narrow reading makes
those publishers invisible. On a later 1,617-host walk, **three of the seven
live `_x402` records on the network sat at names that were not themselves
catalogued hosts** — reachable only by climbing.

Consumers **MUST** query the resource host first, and **SHOULD** then query
ancestor names, nearest first, stopping at the first name that yields a usable
record. Implementations **SHOULD** bound this at two ancestors and **MUST NOT**
query a name of fewer than two labels. The walk is **SHOULD** rather than MAY
because two conforming consumers holding the same resource URL must not reach
different answers about the same publisher — which is the failure this section
opens by describing; a consumer that skips it is expected to have a reason (for
example, it only ever holds apex names), not merely permission. Measured against the same 1,617 hosts,
that bound leaves only 7 (0.4%) unable to reach their own apex.

**An ancestor's record only speaks for a host it names.** Under a shared hosting
suffix the ancestor is controlled by the platform rather than the tenant, so one
record would otherwise make every name beneath it discoverable — including
tenants that published nothing, and names that do not resolve at all. That is
not hypothetical either: in the same survey an invented subdomain inherited the
author's apex record.

Accordingly, a manifest obtained from an ancestor name `A` applies to a host `H`
(where `H` is `A` or a subdomain of `A`) **only if the manifest itself
references `H`**, in `facilitator.baseUrl` or in an entry of `resources`. A
referenced URL counts only when its own host is `A` or a subdomain of `A`. If
the manifest does not reference `H`, the consumer **MUST** treat discovery as
having failed for `H` rather than attributing the ancestor's capability to it. A
manifest retrieved from `H` itself always applies to `H`.

This rule deliberately avoids depending on a public suffix list: such a list is
a mutable external dependency, it disagrees with operational reality for
privately delegated suffixes, and an error in it converts silently into a false
claim that a host is discoverable. Requiring the zone operator to name the host
is a positive statement by a party in a position to make it.

> **Note for implementers.** That justification describes a *zone* operator, and
> under a shared suffix the zone operator is not the host's operator. In a walk
> over 1,611 catalogued hosts on 2026-08-23, 381 (23.6%) reach a name that is
> itself a public suffix — `workers.dev`, `vercel.app`, `up.railway.app`, `onrender.com`, `fly.dev`, and 23 more.
> None of the 28 suffixes so reached carries an `_x402` record, so the naming
> rule above is what keeps this safe rather than an assumption about who controls
> the ancestor. The walk, its frame digest (`25e61f5433b1…`), the
> full host list and the pinned public-suffix list it was computed against are
> published at
> <https://github.com/whawk46/x402-discovery-checks/blob/main/conformance/ancestor-walk.json>
> so these numbers can be recomputed rather than taken; they are exact for that
> frame and not comparable across draws without the digest.

**Normative source.** These rules are maintained in
`draft-hawkins-x402-dns-discovery-03` — Section 5 for the derivation of `D` and
the ancestor walk, Section 6 for the resolution algorithm — and restated here so
that an implementer reading this document has the complete algorithm. If the two
ever disagree, the draft is the source and this text is the defect. The pin
names a revision on purpose: an unpinned pointer made a disagreement
undiagnosable — a reader could not tell whether this text was stale or they
were. This text and -03 agree on every rule. A reader comparing this text
against **-02** will find differences, and they are -02's: it predates the
`SHOULD` on the ancestor walk and the "a party" wording (both Section 5), and
the host-comparison rule and the CNAME/NOERROR rule in step 1 (both Section 6).
Each was corrected here first and carried into -03. They are listed by name
rather than counted, so that a stale list is visibly stale.

### Resolving a domain to a capability

Given a domain `D` — the host itself, or an ancestor admitted by the rule above
— a client resolves x402 capability as:

1. Query TXT for `_x402.D`. If a record with `v=x402-1` exists, fetch the
   manifest from its `wk` URL (rejecting non-HTTPS or out-of-domain URLs).
   A record that fails to parse under the grammar above is treated as
   absent, not as an error. Consumers **MUST** ask whether a TXT record was
   returned that parses, not whether the query returned an answer: under a
   wildcard-CNAME zone `_x402.<name>` answers NOERROR with a CNAME and no TXT at
   all, which a naive reader scores as a record.
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

**Consumers MUST refuse private destinations.** Before every fetch this
document invites — the manifest, each redirect hop, `resources[]` probes,
the live `supported` cross-check — a consumer MUST refuse a URL whose host
is, or resolves to, a loopback, link-local, or private-range address. The
HTTPS and in-domain rules do **not** cover this: the publisher controls
their own DNS, so an in-domain hostname can resolve to `169.254.169.254`
or an address inside the crawler's network, and DNS-01 issuance grants
valid certificates to names that never point anywhere public. The check
MUST be re-applied on every redirect hop (a public first hop redirecting
to an internal name is the classic bypass). Resolution-time checks remain
subject to DNS rebinding between check and connect; consumers needing a
stronger guarantee SHOULD pin the resolved address for the connection.
Deployments intentionally operating on private networks MAY relax this
rule, explicitly. Our reference implementation resolves first and refuses
loopback, link-local, RFC 1918, CGNAT, and IPv6 ULA ranges.

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
- **Peer hints transfer discovery, not trust.** The `peers` list is
  attacker-writable by construction (anyone can publish a manifest naming
  anyone). That is safe precisely because an entry carries no claim beyond
  "a name exists": consumers re-run the full resolution pipeline per name,
  and crawler resource use is bounded by the 32-entry cap plus ordinary
  frontier dedup. A consumer that lets a peer entry shortcut any check in
  this document has reimplemented the vulnerability the entry-cap and
  re-resolution rules exist to prevent.
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
- **Companion evidence layers** (intended use): the unknown-fields rule
  above, together with named optional members, makes this document an attach
  point rather than a container. A sibling extension can define its own member
  without this document carrying it — execution-integrity attestation answers
  whether a service ran the way its host claims, while whether the counterparty
  accepted the agreed outcome is a separate question answered from a different
  vantage. Both are out of scope here; the ignore-unknown-fields rule is what
  keeps the slot open for them, and it is not expected to tighten.
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

