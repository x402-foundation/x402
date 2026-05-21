# `fixtures/canonicalisation-substrate/v0/`

In-tree mirror of the four AlgoVoi-published JCS conformance vector sets that anchor the shared canonicalisation discipline section under coordination at #2326. Removes gist-URL mutability as a risk for a normative reference and provides a single repo-pinned directory that downstream extensions (`privacy_class`, `receipt_format`, `evidenceType`) can cite by file path rather than by gist hash.

## Contents

| File | Vectors | Pair invariants | Source gist | Layer |
|---|---|---|---|---|
| `ap2-omh-v0.json` | 7 | 4 | [`chopmob-cloud/1dca25fd6107db4b7a30bed5dbf2ded8`](https://gist.github.com/chopmob-cloud/1dca25fd6107db4b7a30bed5dbf2ded8) | application-mandate (AP2 OMH) |
| `ctef_vectors.json` | 7 | (CTEF) | [`chopmob-cloud/5f35eaa527d292bf3ddc52f8725a85c9`](https://gist.github.com/chopmob-cloud/5f35eaa527d292bf3ddc52f8725a85c9) | trust-evidence container |
| `aps_vectors.json` | 7 | (APS) | [`chopmob-cloud/5f35eaa527d292bf3ddc52f8725a85c9`](https://gist.github.com/chopmob-cloud/5f35eaa527d292bf3ddc52f8725a85c9) | attestation production |
| `privacy_class_v0.1.json` | 13 | 12 | [`chopmob-cloud/30bcbc717c86493f737feb92c415ba07`](https://gist.github.com/chopmob-cloud/30bcbc717c86493f737feb92c415ba07) | attestation (`privacy_class`) |
| `per_chain_envelope_v0.json` | 19 | 9 | [`chopmob-cloud/e1bf4c9efde6f0e94b77c238cb33d78d`](https://gist.github.com/chopmob-cloud/e1bf4c9efde6f0e94b77c238cb33d78d) | chain-identifier + chain-native-value |

**Total : 53 vectors + 37 pair invariants** under one Apache 2.0 directory.

## Cross-implementation status

All five reference JCS implementations validate every vector and every pair invariant byte-for-byte :

| Library | Lang | Author |
|---|---|---|
| `rfc8785@0.1.4` | Python | Trail of Bits |
| `canonicalize@3.0.0` | JS | Erdtman + Rundgren |
| `gowebpki/jcs v1.0.1` | Go | GoWebPKI |
| `cyberphone/json-canonicalization` | Java | Rundgren (RFC 8785 reference) |
| `serde_jcs 0.2.0` | Rust | l1h3r (runner maintained by Vauban Pay / @seritalien) |

Five libraries / five languages / four non-overlapping author sets, every codebase third-party-attested. Each set's source gist carries its own runner suite (Python + JS + Go + Java reference runners reading the artefact JSON directly). The Rust 5th-impl runner is maintained at https://gist.github.com/seritalien/b0b86baabae33e289fdb6d2f3fb30130.

## Provenance verification

Each JSON file in this directory is an exact byte-for-byte copy of the corresponding canonical gist content at the timestamp recorded in its `published_at` field. No edits, no reformatting, no canonicalisation pre-applied : the raw bytes are the artefact under test.

To re-verify provenance against the upstream gists :

```sh
gh api gists/1dca25fd6107db4b7a30bed5dbf2ded8 --jq '.files["ap2-omh-v0.json"].content' | diff - ap2-omh-v0.json
gh api gists/5f35eaa527d292bf3ddc52f8725a85c9 --jq '.files["ctef_vectors.json"].content' | diff - ctef_vectors.json
gh api gists/5f35eaa527d292bf3ddc52f8725a85c9 --jq '.files["aps_vectors.json"].content' | diff - aps_vectors.json
gh api gists/30bcbc717c86493f737feb92c415ba07 --jq '.files["privacy_class_v0.1.json"].content' | diff - privacy_class_v0.1.json
gh api gists/e1bf4c9efde6f0e94b77c238cb33d78d --jq '.files["per_chain_envelope_v0.json"].content' | diff - per_chain_envelope_v0.json
```

Empty diff is the conformance signal.

## Normative anchor

The canonicalisation rules these vectors codify are coordinated at #2326 and are landing as a separate file (target location : `specs/canonicalisation.md`) per the v3 section text under finalisation. The rules in summary :

- **JCS** : RFC 8785, canonical hashing path `JCS_hash = SHA-256(JCS(object))`, lowercase hex
- **Asymmetric failure surface** : producer-loud (any deviation rejected at the wire) / verifier-silent (any equivalent canonical input accepted)
- **Pair-invariant assertions** : object_key_order, array_order, optional_fields, scalar_form, unicode_normalisation (NFC vs NFD distinct), timestamp_lexical, field_name_canonicalisation
- **`canon_version`** : SHOULD pin for general emitters, MUST pin for retention-obligation frameworks (MiCA Art. 80, AMLR Art. 56, DORA Art. 14) per the v3 retention-property clause

The text is co-authored by AlgoVoi (`@chopmob-cloud`), Vauban Pay (`@seritalien`), and FeedOracle (`@feedoracle`).

## Related fixture sets

- `fixtures/action-ref-verify/v0/` — Axis 3 work-receipt binding (per PR #2398, `@andysalvo`)
- `fixtures/hybrid-pqc/v0/` — Axis 2 hybrid-PQC receipt cores (per PR #2411, `@feedoracle`)
- `fixtures/stark-vauban-pay-v1/v0/` — Axis 1 STARK proof-of-payment-conditions (Vauban-authored, separate PR forthcoming)

The four axes share `payment_hash` + `action_ref` binding values so the cross-axis interop is reproducible by any conformance harness.

## License

Apache 2.0 (matches the working assumption for sibling fixture suites in this repo).

## Updating

If AlgoVoi publishes revisions to any of the four source gists, the corresponding mirror file in this directory updates via the `gh api` command above plus a PR. The `published_at` field in each artefact is the authoritative timestamp for what version this mirror tracks. A revision to the underlying canonicalisation rule version triggers a bump to a new `v1/` (versioned-directory pattern) rather than in-place mutation of `v0/`.
