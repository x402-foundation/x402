<!--
Copyright 2026 Michael K. Saleme
SPDX-License-Identifier: Apache-2.0
-->
# x402 Conformance Vectors

An open, dependency-free conformance-vector set for x402 implementations —
delivering the open-source conformance harness proposed in **#2178**.

A protocol with governance but no conformance vectors is a promise, not a
guarantee: two implementations can each claim x402 compliance and still diverge
on the same request. These vectors let an implementer *prove* conformance.

## What a vector is

A vector is **data**, not a reference implementation — a normative x402
requirement plus the request that exercises it:

```json
{
  "id": "X4-001",
  "title": "402 Payment Challenge Headers Present",
  "category": "payment_challenge",
  "requirement": "HC-1: Payment protocol must return complete challenge",
  "method": "GET",
  "request": { "path": "/" },
  "normative": "MUST",
  "expected": "A conformant x402 implementation satisfies the stated requirement; a divergent response is a finding."
}
```

The schema is `schema.json`. This set carries **52 vectors** across the x402
core conformance surface: payment-challenge structure, recipient/amount
integrity, session security, spending limits, facilitator trust, information
disclosure, cross-chain confusion, identity verification, replay / double-spend,
authorization bypass, settlement finality, and protocol abuse.

## Running it against your implementation

```bash
# validate the vector set (offline, no network)
python conformance/run_conformance.py --validate

# replay every vector against your x402 endpoint and report the response
python conformance/run_conformance.py --url https://your-x402-endpoint --report report.json
```

The runner is stdlib-only (no dependencies). It replays each vector's request
and pairs the normative requirement with your implementation's observed
response, so conformance can be judged per requirement in CI or review.

## Scope and roadmap

- **This set: x402 core (52 vectors).** Vectors are generated from the
  open-source [`agent-security-harness`](https://pypi.org/project/agent-security-harness/)
  (Apache-2.0) so they stay faithful to a maintained test suite; provenance is
  recorded in each vector's `source` field.
- **Planned:** optional machine-checkable `assert` blocks (status / header /
  body predicates) so the runner can auto-judge deterministic vectors, and an
  x402 **extension** conformance set (e.g. request-integrity / spend-governance)
  contributed alongside the relevant extension spec.

## Provenance & license

Contributed by **Michael K. Saleme** (ORCID
[0009-0003-6736-1900](https://orcid.org/0009-0003-6736-1900)). Vectors are
derived from the Apache-2.0 `agent-security-harness`; methodology at Zenodo
[10.5281/zenodo.19343034](https://doi.org/10.5281/zenodo.19343034). Licensed
Apache-2.0, matching this repository.

While building the harness these vectors come from, adversarial review of **its
own reference verifier** caught three fail-open defects *in that harness code* —
a credential-release check trusting a self-asserted flag, a scope check that
failed open on an omitted field, and an SSRF blocklist that missed most of the
RFC1918 `172.16/12` range — each fixed and guarded by a negative test before
release. Fail-open is easy to ship even in code written to catch it; that is
exactly why machine-checkable conformance vectors are worth having.
