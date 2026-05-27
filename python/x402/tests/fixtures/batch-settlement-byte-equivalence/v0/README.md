# batch-settlement byte-equivalence fixtures (v0)

Cross-language EIP-712 byte-equivalence fixtures for the `batch-settlement`
EVM scheme. Each JSON file pins the exact 32-byte digest that the TypeScript
SDK (via `viem.hashTypedData`) produces for a given input. The Python SDK
`test_byte_equivalence_fixtures` test re-computes the digest from the same
input and asserts byte-for-byte equality.

A failure of the verifier — in either direction — means TS / Python / spec
drift has been introduced, and the operational invariant that
`ecrecover(digest_TS, sig)` and `ecrecover(digest_Py, sig)` resolve to the
same signer no longer holds.

## Vectors

| File                          | Vector | EIP-712 primary type | What it pins                                              |
| ----------------------------- | ------ | -------------------- | --------------------------------------------------------- |
| `L2.1-channel-config.json`    | L2.1   | `ChannelConfig`      | Flat scalar struct (also serves as channelId)             |
| `L2.2-voucher.json`           | L2.2   | `Voucher`            | Cumulative voucher (channelId + maxClaimableAmount)       |
| `L2.3-claim-batch.json`       | L2.3   | `ClaimBatch`         | Array of `ClaimEntry` (nested struct array)               |
| `L2.4-refund.json`            | L2.4   | `Refund`             | Cooperative refund (channelId + nonce + amount)           |

Each JSON file has the shape:

```jsonc
{
  "vector": "L2.x",
  "description": "…",
  "domain":      { "name": "x402 Batch Settlement", "version": "1", "chainId": 84532, "verifyingContract": "0x…" },
  "primaryType": "…",
  "types":       { "<TypeName>": [ { "name": "…", "type": "…" }, … ] },
  "input":       { … },
  "expected_digest": "0x…32 bytes…",
  "meta": { "generator": "_generator.ts", "generator_version": "1", "viem_version": "…" }
}
```

The `expected_digest` is the source-of-truth — it is produced by the TS-side
generator and the Python-side verifier must match it.

## Regenerating

The generator is self-contained: it imports only `viem` and inlines the
EIP-712 domain and type definitions. To regenerate:

```bash
cd python/x402/tests/fixtures/batch-settlement-byte-equivalence/v0
npm install
npx tsx _generator.ts
```

The CI workflow `check_byte_equivalence_fixtures` runs the same command on
every PR and fails if the regenerated JSON differs from what is committed —
so silent TS / spec drift is caught immediately.

`node_modules/` and `package-lock.json` are git-ignored locally; the
committed JSON files are the source-of-truth.

## When to update

Regenerate and commit the new JSON when any of the following change:

- TS SDK EIP-712 type definitions (`typescript/.../batch-settlement/constants.ts`)
- TS SDK EIP-712 domain (name / version / verifyingContract)
- `viem` major version in `package.json`
- This generator's inlined type / domain definitions

If you change the **input** values to keep the same shape but new mock
addresses, you must also regenerate. Both the input and the digest are part
of the contract.

## Version pinning

This directory is versioned as `v0/`. If a breaking change to the fixture
shape is required (e.g. new top-level fields, breaking JSON schema change),
introduce `v1/` rather than mutating `v0/` so downstream verifiers can
migrate explicitly.

`viem` is pinned exactly in `package.json` (`"viem": "2.48.11"`, no `^`) so
that re-running the generator on a fresh machine produces byte-identical
output.

## Why this exists

The Python SDK was added in #2402 as a single large PR and does not include
cross-language byte-equivalence tests against the TS SDK. Without such
tests, a `viem` change, a Python `eth_account` change, or a spec change
could silently shift one side's digest while the other stays stable —
breaking signature recovery in production. These fixtures + the
drift-detection CI job close that gap for the four signing-time primitives.
The complementary `collectorData` ABI-encoding equivalence (the 2-stage
encoding case) is tracked in a follow-up PR.

## Related

- Python digest API: `python/x402/mechanisms/evm/batch_settlement/digest.py`
- Python verifier test: `python/x402/tests/unit/mechanisms/evm/batch_settlement/test_byte_equivalence_fixtures.py`
- TS digest source: `typescript/packages/mechanisms/evm/src/batch-settlement/utils.ts`
  (uses `viem.hashTypedData`)
- TS EIP-712 type definitions: `typescript/packages/mechanisms/evm/src/batch-settlement/constants.ts`
- CI drift check: `.github/workflows/check_byte_equivalence_fixtures.yml`
