# Client-Side Proof Generation: `zk-relay`

## Overview

Unlike the `exact` scheme where the client signs a message with their wallet, `zk-relay` requires the client to generate a zero-knowledge proof entirely in the browser using WASM. This document describes the client-side proving pipeline.

## Pipeline

```
Note Data (secret, nullifier, amount, assetId)
          |
          v
    Commitment = Poseidon(secret, nullifier, amount, assetId)
          |
          v
    Merkle Proof = tree.getProof(leafIndex)
          |
          v
    Circuit Inputs = {
      root, nullifierHash, amount, assetId, recipient,
      secret, nullifier, pathElements, pathIndices
    }
          |
          v
    Noir Witness Generation (noir_js WASM)
          |
          v
    UltraHonk Proof Generation (bb.js WASM)
          |
          v
    { proof: Uint8Array, publicInputs: string[] }
```

## Dependencies

| Package              | Version            | Purpose                        |
|----------------------|--------------------|--------------------------------|
| `@noir-lang/noir_js` | `1.0.0-beta.18`   | Witness generation from Noir circuits |
| `@aztec/bb.js`       | `2.1.11`           | UltraHonk proof generation (WASM) |

Version alignment between these packages is critical. The Solidity verifier contract MUST be generated from the same `bb.js` version used for proof generation. Using `bb` CLI instead of `bb.js` will produce incompatible verifiers.

## Browser Requirements

### SharedArrayBuffer

The `bb.js` WASM backend uses multi-threading via `SharedArrayBuffer` for proof generation. This requires the page to be served with the following HTTP headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

If `crossOriginIsolated` is `false`, the prover falls back to single-threaded mode, which increases proof generation time from ~3 seconds to ~15 seconds.

### Common Reference String (CRS)

The UltraHonk proof system requires a Common Reference String (CRS). The `bb.js` library fetches it from `https://crs.aztec.network/` and caches it in IndexedDB.

For production deployments, the CRS SHOULD be pre-downloaded and served from the application's own domain to avoid cross-origin fetch failures. The CRS data consists of:

| File     | Size       | Description                              |
|----------|------------|------------------------------------------|
| `g1.dat` | ~2,097 KB  | G1 group elements (32769 points x 64 bytes) |
| `g2.dat` | 128 bytes  | G2 group element                         |

The CRS is stored in IndexedDB under the database `keyval-store`, object store `keyval`, with keys `g1Data` and `g2Data`.

## Circuit Compilation

Circuits are compiled with `nargo` (version 1.0.0-beta.18) to produce JSON artifacts containing the ACIR bytecode. These artifacts are served as static files and loaded by the client at proof generation time.

| Circuit    | Subgroup Size | CRS Points Required | Approximate Proof Time |
|------------|---------------|---------------------|------------------------|
| `shield`   | 2,048         | 2,049               | ~1.5s (multi-threaded) |
| `burn`     | 32,768        | 32,769              | ~3s (multi-threaded)   |
| `transfer` | 32,768        | 32,769              | ~3s (multi-threaded)   |

## Proof Format

The generated proof is a `Uint8Array` in the UltraHonk serialization format. To submit it to the facilitator, it is converted to a `0x`-prefixed hex string:

```javascript
const proofHex = '0x' + Array.from(proof).map(b => b.toString(16).padStart(2, '0')).join('')
```

The public inputs are returned as an array of field element strings. The order matches the circuit's public input declaration:

```
[root, nullifierHash, amount, assetId, recipient]
```
