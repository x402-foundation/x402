# Shared test vectors

Machine-readable vectors for [`exact` on `lnbtc`](../scheme_exact_lnbtc.md). They
are an implementation aid: when this file and the specification disagree, the
specification governs.

SDKs load [`exact_lnbtc.json`](exact_lnbtc.json) in their own test suites, so
every SDK runs the same cases against the same expected results.

## Layout

| Section | Phase | Input |
|---|---|---|
| `http_binding` | `http:1` request hash from a request | method, URL, body bytes, header field lines, bound header names |
| `http_server_adapter` | A server adapter deriving the binding from a framework request | configured public origin, method, URL as the framework reports it, header field lines |
| `mcp_binding` | `mcp:1` request hash from a `tools/call` | server, `params`, bound metadata names |
| `client` | Client validation before and after paying | intended request, `PaymentRequired`, the payer adapter's result |
| `facilitator_settle` | Facilitator `/settle`, including replay | `PaymentRequirements`, `PaymentPayload`, settlement time, skew |

Each case has an `id`, a `note` explaining it, and an `expect`.

### Inputs

- `body_hex` is the content bytes in lowercase hexadecimal; `""` is an empty or
  absent body.
- `header_lines` is a list of `[name, value]` field lines in arrival order. Names
  are case-insensitive and values are given verbatim, including any whitespace
  or control characters. Implementations combine repeated lines as RFC 9421
  section 2.1 specifies.
- An HTTP helper that takes a configured origin is given the URL's own origin in
  `http_binding`. Origin policy is exercised only in `http_server_adapter`.
- `mcp_binding` gives `params` as a JSON value, or `params_json` as the raw text
  of the `params` object when the text itself is the point (number literals,
  escapes). Parse `params_json` with the SDK's normal JSON parser. If the parser
  refuses the text, the case counts as rejected.
- `client` and `facilitator_settle` cases are stored as a shared `base` document
  plus a JSON Patch (RFC 6902) that uses only `add`, `remove`, and `replace` on
  object members. Apply each patch to a fresh copy of `base`. In
  `facilitator_settle` the document is `{ requirements, payload }`. In `client`
  it is `{ intended_request, payment_required, payer_result }`, where
  `payer_result.amount_msat` is a decimal string.
- `facilitator_settle` cases run their `steps` in order against one empty,
  durable replay store, with the clock set to each step's `now`.

### Expectations

- `{ request_hash, canonical_description? }`: the binding succeeds with this
  digest. `canonical_description` is the JCS text whose SHA-256 is the digest.
- `{ error }`: the operation fails with this reason. For `client`,
  `payer_called` states whether the payer adapter was invoked first.
- `{ preimage }`: the client pays once and the payload carries this preimage.
- `{ success: true, transaction, network, replay_key, retain_until_at_least }`:
  settlement succeeds and the store records `replay_key` until at least the
  given Unix time. The response has no `payer`.
- `{ success: false, error_reason, step }`: settlement fails, nothing is
  recorded, and `step` is the numbered Facilitator Validation step that fails
  (`"replay"` for `duplicate_settlement`).
- `{ open, outcomes, forbidden_request_hash? }`: the specification does not yet
  decide this case. `open` names an entry in `open_questions`. An
  implementation must produce exactly one of the listed `outcomes`, and must
  never produce `forbidden_request_hash`. When a question is decided, its cases
  become ordinary expectations in the next `fixture_version`.

### Case groups

`facilitator_settle` cases carry a `group`:

- `single_fault` cases make one logical change to the spec example. That change
  can touch both sides, for example a field that is invalid on both.
- `order` cases combine two faults that fail in different numbered steps. The
  earlier step's reason is expected. No case combines two faults from the same
  step, so the order of checks within a step is not pinned.
- `valid` and `replay` cases cover success, duplicates, and failed proofs that
  must not consume the invoice.

## Not covered

- Concurrency and restart behavior of the replay store. These need a real store
  and belong in each SDK's own tests.
- A replay-store failure. Its reason is proposed separately in #3698.
- Invoice issuance, pricing, and transport middleware.

## Versioning

`fixture_version` increases whenever an expectation changes or a case is
removed. Adding a case does not change it. SDK loaders should pin the version
they target.
