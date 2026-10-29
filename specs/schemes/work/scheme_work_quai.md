# Scheme: `work` on `Quai`

## Scope

This document defines three version 1 profiles:

- `quai/sha256d-v1`
- `quai/scrypt-v1`
- `quai/kawpow-v1`

They carry Quai-native AuxPoW or KAWPOW jobs. Stratum, StratumX, pool, and solo
node RPC are source adapters and do not change the profile identifier.

All three profiles use:

- `network`: `quai:9` or `quai:15000`
- `asset`: `hash`
- `payTo`: the Quai reward address bound to the source job
- `amount`: nominal expected native proof evaluations, as defined by the `work` scheme

Hex strings MUST be lowercase and MUST NOT have an `0x` prefix inside
`job.work`. Solution fields MUST use a lowercase `0x` prefix.

## SHA-256d and Scrypt jobs

`quai/sha256d-v1` and `quai/scrypt-v1` share this work template:

```json
{
  "extraNonce1": "01020304",
  "extraNonce2Size": 4,
  "previousBlockHash": "0000000000000000000000000000000000000000000000000000000000000000",
  "coinbase1": "0102",
  "coinbase2": "000000000304",
  "merkleBranches": [
    "1111111111111111111111111111111111111111111111111111111111111111"
  ],
  "version": "20000000",
  "bits": "1d00ffff",
  "time": "65b00000"
}
```

The provider copies the `mining.notify` values without altering their bytes and
adds `extraNonce1` and `extraNonce2Size` from the same Stratum subscription.
Those subscription values are required because a notification alone is not a
self-contained SHA-256d or Scrypt job.

The fields are:

| Field                     | Rule                                           |
| ------------------------- | ---------------------------------------------- |
| `extraNonce1`             | Exactly 4 bytes                                |
| `extraNonce2Size`         | Integer `4`                                    |
| `previousBlockHash`       | Exactly 32 bytes in Stratum word-swapped order |
| `coinbase1`, `coinbase2`  | Even-length hex, at most 512 KiB combined      |
| `merkleBranches`          | At most 64 entries of 32 bytes each            |
| `version`, `bits`, `time` | Exactly 4 bytes                                |

No other fields are allowed.

The solution is:

```json
{
  "extraNonce2": "0x00000001",
  "time": "0x65b00000",
  "nonce": "0x00000002"
}
```

Each field is exactly 4 bytes. Version 1 does not permit time or version
rolling, so `solution.time` MUST equal `job.work.time`.

### Candidate construction

Let `wordSwap32` reverse each four-byte word of a 32-byte value. Construct:

```text
coinbase =
  hex(coinbase1) ||
  hex(extraNonce1) ||
  hex(solution.extraNonce2) ||
  hex(coinbase2)

merkle = SHA256d(coinbase)
for branch in merkleBranches:
  merkle = SHA256d(merkle || hex(branch))

header =
  uint32le(version) ||
  wordSwap32(hex(previousBlockHash)) ||
  merkle ||
  uint32le(solution.time) ||
  uint32le(bits) ||
  uint32le(solution.nonce)
```

For `quai/sha256d-v1`, the native digest is `SHA256d(header)`.

For `quai/scrypt-v1`, the native digest is
`scrypt(header, header, N=1024, r=1, p=1, dkLen=32)`.

For both profiles, reverse the 32 digest bytes and interpret the result as an
unsigned big-endian integer. That integer is the profile score.

## KAWPOW jobs

`quai/kawpow-v1` uses:

```json
{
  "headerHash": "1111111111111111111111111111111111111111111111111111111111111111",
  "seedHash": "2222222222222222222222222222222222222222222222222222222222222222",
  "height": 123456,
  "bits": "1d00ffff"
}
```

The provider copies `header_hash`, `seed_hash`, `height`, and `bits` from one
Quai KAWPOW `mining.notify` message without altering them. `job.id` carries its
`job_id`, `amount` derives the payment target, and job freshness carries the
invalidation semantics of `clean`. The Stratum target MUST NOT also appear in
`job.work`.

`headerHash` is the exact 32-byte input passed to the Quai KAWPOW kernel. For a
Quai Ravencoin-style header, it is the byte-reversed SHA256d digest of the
80-byte KAWPOW input that excludes nonce and mix hash. A solver MUST use these
bytes directly and MUST NOT reverse them again. This defines verification; the
provider MUST NOT recompute the source-issued value.

`seedHash` is exactly 32 bytes and MUST equal Quai KAWPOW `SeedHash(height)`.
Quai KAWPOW v1 uses 7,500 heights per epoch. `height` is a non-negative safe
integer. `bits` is the source job's 4-byte compact difficulty value, not the
x402 payment target. Hex is encoded according to this profile's common rules.
No other fields are allowed.

The solution is:

```json
{
  "nonce": "0x0000000000000001",
  "mixHash": "0x3333333333333333333333333333333333333333333333333333333333333333"
}
```

`nonce` is exactly 8 bytes and `mixHash` is exactly 32 bytes. Interpret `nonce`
as an unsigned 64-bit hexadecimal integer. Run Quai KAWPOW with the bytes of
`job.work.headerHash`, that nonce, and `job.work.height`. Let `digest` and
`result` be the raw KAWPOW outputs. The bytes of `solution.mixHash` MUST equal
`digest`. When using go-quai `VerifyKawpowShare`, reverse its returned
calculated mix hash before this comparison. Interpret `result` as an unsigned
big-endian integer; that integer is the profile score.

Implementations MUST use the Quai KAWPOW parameters for the network revision
identified by this profile. A generic Ethash or Ravencoin verifier is not
sufficient. Before proof evaluation, a verifier MUST reject a `seedHash` that
does not match `height`. The adapter MUST also confirm that `headerHash`,
`height`, and `bits` match its retained source job.

## Fingerprint

Before the expensive proof function, compute:

```text
fingerprint = SHA256(
  UTF8(profile) || 0x00 ||
  UTF8(network) || 0x00 ||
  candidate
)
```

For SHA-256d and Scrypt, `candidate` is the 80-byte header. For KAWPOW it is
`headerHash || uint64be(nonce) || mixHash`. Profile and network MUST contain no
NUL byte. The fingerprint identifies the computed work, not a source session
or transport job identifier. Job identity and reward binding are verified
separately.

## Source binding and settlement

The issuer MUST obtain the job for `payTo`. A Stratum adapter does this by
authorizing `payTo` as the account portion of the worker name and retaining the
authenticated session privately. A solo adapter does it by setting the native
work object's primary coinbase.

For all three Quai profiles, the verifier MUST establish that the mined
candidate commits to that primary coinbase. In SHA-256d and Scrypt, the
coinbase transaction commits the Quai seal hash containing the primary
coinbase. In KAWPOW, that commitment flows through the auxiliary coinbase
Merkle root into `job.work.headerHash`. Matching `job.id` alone is not reward
binding. A verifier using retained source state MUST compare the complete
public job to that retained job. A third-party verifier needs equivalent public
data or an authenticated issuer attestation.

After successful x402 settlement, the issuer may submit the exact verified
solution through the source session that produced the job:

| Profile            | Stratum `mining.submit` parameters             |
| ------------------ | ---------------------------------------------- |
| SHA-256d or Scrypt | `[worker, job.id, extraNonce2, time, nonce]`   |
| KAWPOW             | `[worker, job.id, nonce, job.work.headerHash, mixHash]` |

The `0x` prefix is removed from solution fields for Stratum submission.

An adapter MUST establish the current native workshare target independently of
the amount-derived payment target. A valid x402 payment meets the payment
target. When the same score also meets the native target, the adapter SHOULD
submit the exact solution for `payTo`. It MUST NOT submit easier payment shares
merely because a source may return `true` for liveness.

Native source rejection, timeout, or disconnection does not invalidate an
otherwise valid x402 payment. An invalid native proof, reward mismatch,
expired job, or replay still fails settlement before any source submission.
The successful `transaction` is the lowercase `0x`-prefixed SHA-256
fingerprint defined above. A provider MAY report confirmed native acceptance
as `extra.sourceAccepted`; this field is diagnostic only.
