# EIP-712 reference fixtures

L2.1-L2.4 pin the `ChannelConfig`, `Voucher`, `ClaimBatch`, and `Refund`
digests against viem 2.48.11. The Python tests exercise the existing
`compute_channel_id`, `sign_voucher`, `sign_claim_batch`, and `sign_refund`
functions. For the signing functions, a test signer captures the actual
SDK domain, types and message; the test hashes those values with
`eth_account` and compares the result with the reference digest.

The reference digests were checked against the TypeScript signing paths
at [`faa1c694`](https://github.com/x402-foundation/x402/tree/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/batch-settlement).
using the same inputs. The generator reads the JSON fields; it does not import the SDK or detect
later TypeScript/spec changes. Review the reference data explicitly when
those change. These are digest checks, not signature or settlement tests.

This PR is independent of the deposit ABI fixtures in #2499.

## Reproduce without changing the checkout

Requires Node.js 22 or later and npm. From this directory:

```sh
fixture_tmp=$(mktemp -d)
cp _generate_digests.mjs L2.[1-4]-*.json "$fixture_tmp/"
npm install --prefix "$fixture_tmp" --no-save --package-lock=false --ignore-scripts viem@2.48.11
node "$fixture_tmp/_generate_digests.mjs"
for file in L2.[1-4]-*.json; do
  diff -u "$file" "$fixture_tmp/$file" || exit 1
done
```

All four diffs should be empty. The generator recomputes only
`expected_digest` and generator metadata from the committed JSON data.
This is a manual reproduction check, not a CI drift job.

Run the Python verifier from `python/x402` after the normal development setup:

```sh
uv run pytest tests/unit/mechanisms/evm/batch_settlement/test_byte_equivalence_fixtures.py
```
