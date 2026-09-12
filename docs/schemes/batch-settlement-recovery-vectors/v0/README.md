# batch-settlement recovery vectors (v0)

Machine-readable test vectors for the corrective-402 recovery contract specified in [`../batch-settlement-recovery.mdx`](../batch-settlement-recovery.mdx).

Each JSON file describes a single recovery scenario as a sequence of `(client request → server response)` pairs, plus the expected client behaviour and the wire-level invariants that must hold.

## Files

| File | Scenario | Recovery outcome |
| --- | --- | --- |
| `happy-path.json` | Stale local cumulative | Single retry succeeds |
| `invalid-corrective-state.json` | Onchain claimed exceeds server cumulative | Client emits hard error (`INVALID_CORRECTIVE_STATE`) without retry |
| `loop-guard.json` | Retry returns corrective 402 with an advanced cumulative | Client emits hard error (`PERSISTENT_STALE`) |
| `loop-guard-unchanged.json` | Retry returns corrective 402 with an unchanged cumulative | Client emits the same hard error (`PERSISTENT_STALE`) |
| `cas-conflict.json` | Concurrent same-channel requests, one wins | Loser recovers via single retry; CAS is an optional suspected cause |
| `transient-state-unavailable.json` | Onchain read needed to verify the snapshot is unavailable | Client emits non-terminal `TRANSIENT_STATE_UNAVAILABLE`; no mutation, signature, or retry, and no loop-guard attempt consumed |

## Vector schema

Each file has this shape:

```jsonc
{
  "scenario": "<id>",
  "description": "<human-readable summary>",
  "channel": {
    "channelId": "0x…",
    "domain": { "name": "x402 Batch Settlement", "version": "1", "chainId": 84532, "verifyingContract": "0x…" }
  },
  "initialState": {
    "onchainTotalClaimed": "<wei>",
    "serverChargedCumulative": "<wei>",
    "clientLocalCumulative": "<wei>",
    "onchainReadAvailable": <bool>,   /* optional, defaults to true; false pins that the trust-but-verify read cannot complete */
    "comment": "<optional human note about the precondition>"
  },
  "steps": [
    { "step": <n>, "actor": "client" | "clientA" | "clientB" | "server",
      "action": "<text>",
      "request": { … } /* OR */ "response": { … } }
  ],
  "expectedClientBehaviour": { "afterStep<n>": "<text>" },
  "invariants": [ "<text>" ]
}
```

`signature` fields are placeholders. EIP-712 signing is independently pinned by the [byte-equivalence fixtures](../../../../python/x402/tests/fixtures/batch-settlement-byte-equivalence/v0/) and does not affect the recovery state-machine. SDK integration tests can use any deterministic signing key; the recovery contract is independent of signature validity.

## How SDK integration tests use these vectors

A conformant SDK should read each `steps` entry in order and:

1. **`actor: "client"` with `request`** — construct the request shape from the vector, sign with a test key (any deterministic signer is fine), submit to a test server.
2. **`actor: "server"` with `response`** — assert the server's response matches the vector's status and `extra.channelState` shape, byte-by-byte where possible.
3. After each step, evaluate `expectedClientBehaviour.afterStep<n>` as the contract the SDK's client implementation must satisfy (e.g. parse and verify `channelState`, retry exactly once, emit a specific telemetry label, escalate to hard error).
4. At the end of the sequence, assert all `invariants` still hold for the captured state.

Two SDKs implementing the same vector will produce byte-identical request bodies (modulo signatures) and state transitions, and either both pass or both fail at the same step. That is the convergence property these vectors exist to provide.

## Version pinning

This directory is `v0/`. Breaking changes to the schema (new top-level fields, removed fields, semantics change) will be introduced as `v1/` rather than mutating `v0/`, so downstream SDK tests can pin the version they implement against. Adding new scenarios under the same schema is non-breaking and stays in `v0/`.

## Why vectors, not just spec prose

Spec prose tells implementers *what* the recovery contract is; the vectors fix *exactly* what each wire payload looks like, what state transitions occur, and what the client must do after each step. Two SDKs implementing the same prose can diverge in edge-case interpretation (is `totalClaimed > chargedCumulativeAmount` valid? does the loop guard apply when the second `chargedCumulativeAmount` is unchanged? can a client infer a CAS conflict from a wire-identical corrective response?). Two SDKs implementing the same vectors converge by construction.
