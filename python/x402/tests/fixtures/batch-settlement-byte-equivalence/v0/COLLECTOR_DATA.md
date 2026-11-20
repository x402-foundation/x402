# Deposit collector ABI fixtures

L2.5-L2.8 pin the ERC-3009 deposit nonce, ERC-3009 collector data,
EIP-2612 permit segment, and Permit2 collector data against viem 2.48.11.
The Python test compares the existing `encoding.py` helpers with these
static reference bytes. Signatures are dummy bytes; these vectors do not
test signature validity or settlement.

The generator's ABI layouts match
[`batch-settlement/encoding.ts` at `faa1c694`](https://github.com/x402-foundation/x402/blob/faa1c694c66a3732aaabbce93bdae140e521a67d/typescript/packages/mechanisms/evm/src/batch-settlement/encoding.ts).
It reads the committed JSON inputs and recomputes `expected_bytes` with viem.
It does not import the TypeScript SDK or detect later SDK/spec changes.
Review the layouts and reference bytes explicitly when those change.
These files work independently of the L2.1-L2.4 digest fixtures in #2489.

## Reproduce without changing the checkout

Requires Node.js 22 or later and npm. From this directory:

```sh
fixture_tmp=$(mktemp -d)
cp _generate_collector_data.mjs L2.[5-8]-*.json "$fixture_tmp/"
npm install --prefix "$fixture_tmp" --no-save --package-lock=false --ignore-scripts viem@2.48.11
node "$fixture_tmp/_generate_collector_data.mjs"
for file in L2.[5-8]-*.json; do
  diff -u "$file" "$fixture_tmp/$file" || exit 1
done
```

All four diffs should be empty. The script regenerates only the expected
bytes and generator metadata; the JSON inputs remain the source for the
sample values. This is a manual reproduction check, not a CI drift job.

Run the Python verifier from `python/x402` after the normal development setup:

```sh
uv run pytest tests/unit/mechanisms/evm/batch_settlement/test_collector_data_fixtures.py
```
