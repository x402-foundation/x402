Add cross-language byte-equivalence fixtures for the batch-settlement
deposit-time ABI encoding layer (ERC-3009 deposit nonce, ERC-3009
`collectorData`, EIP-2612 permit segment, Permit2 `collectorData`) under
`tests/fixtures/batch-settlement-byte-equivalence/v0/` (`L2.5` through
`L2.8`), plus a Python verifier
(`test_collector_data_fixtures.py`) that asserts the existing
`encoding.py` helpers produce byte-identical output to the TS SDK's
`viem.encodeAbiParameters` calls.

Depends on #2489. The `_generator.ts`, `README.md`, `package.json`, and
`.gitignore` for the fixture directory are intentionally not included
here — they are added by #2489 and would otherwise collide on the same
paths with disjoint content (digest-side `hashTypedData` vs
encoding-side `encodeAbiParameters`). Merge #2489 first; this PR adds
the L2.5–L2.8 JSON and the Python verifier only. After both PRs land, a
follow-up PR will extend `_generator.ts` to regenerate L2.5–L2.8 as
well — until then the drift-detection workflow's `L[0-9].[0-9]*.json`
glob will see the files but the digest-side generator will not touch
them, so the drift check passes vacuously for L2.5–L2.8.
