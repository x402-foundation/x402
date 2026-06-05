# Go Sign-In-With-X Implementation Plan

## Current State

Branch: `feature/go-sign-in-with-x-extension`

Base: rebased onto `upstream/main` at `bf99a516` (`fix: preserve v1 path params in discovery (#2508)`).

The current PR adds a helper package under `go/extensions/signinwithx` with:

- extension declaration helpers
- `SIGN-IN-WITH-X` header encoding and parsing
- SIWE message construction for `eip155:*`
- SIWX payload validation
- EVM EOA EIP-191 signature verification
- unit tests for the helper surface

Maintainer feedback indicates this should not merge as helper-only. The target is full Go SDK parity with the existing TypeScript and Python SIWX extension surfaces, followed by cross-SDK testing.

## Decision

Continue on the existing PR branch and expand the implementation toward TS/Python parity before requesting review again.

Use Python PR #2393 and `typescript/packages/extensions/src/sign-in-with-x` as the reference implementation set.

## Scope

### 1. Server Extension

Add a Go `ResourceServerExtension` implementation for SIWX.

Planned files:

- `server.go`
- `hooks.go`
- possibly `storage.go`

Required behavior:

- expose `CreateSIWxResourceServerExtension`
- dynamically enrich the 402 `sign-in-with-x` declaration with:
  - `domain`
  - `uri`
  - `nonce`
  - `issuedAt`
  - optional `expirationTime`
  - `supportedChains`
  - JSON schema
- register an `OnAfterSettle` hook that records successful payments by resource path and payer address
- register an HTTP protected request hook that validates `SIGN-IN-WITH-X`
- grant access for auth-only routes (`Accepts` empty)
- grant access for paid routes when the verified address has already paid for the resource
- fail closed and fall back to normal payment flow for absent or invalid SIWX headers

### 2. Storage

Add SIWX payment tracking interfaces and a default in-memory implementation.

Required behavior:

- `HasPaid(resource, address) bool`
- `RecordPayment(resource, address) error`
- optional nonce tracking:
  - `HasUsedNonce(nonce) bool`
  - `RecordNonce(nonce) error`
- normalize EVM addresses case-insensitively
- preserve non-EVM address strings safely for future Solana support

### 3. Client-Side Auth Flow

Add Go client support for responding to SIWX challenges.

Open design point:

- existing `ClientExtension` enriches payment payloads, but SIWX needs an HTTP transport hook that can retry with `SIGN-IN-WITH-X` before creating a payment payload.

Likely implementation:

- add a small HTTP client extension/hook mechanism to `go/http/client.go`
- support an `OnPaymentRequired`-style hook that can return additional request headers
- implement `CreateSIWxClientHook`
- implement `CreateSIWxClientExtension`
- try compatible signers in order
- retry with `SIGN-IN-WITH-X` when the server advertises the extension
- continue to the normal payment flow if signing fails or the server rejects SIWX

### 4. Signing And Verification

Current support:

- EVM EOA EIP-191 verification

Planned support:

- EVM signer interface
- EVM address extraction
- EVM SIWE message signing
- SIWX header creation from a signer
- evaluate `github.com/signinwithethereum/siwe-go` for message parsing/formatting/verification alignment

Parity candidates:

- EIP-1271 smart wallet verification
- EIP-6492 counterfactual wallet verification
- Solana SIWS signing and verification

These should be included if feasible within the PR. If they are too large, explicitly document them as follow-up items and ask the maintainer to confirm the split.

### 5. Examples

Add Go examples mirroring Python/TS flows.

Candidate directories:

- `examples/go/servers/sign-in-with-x`
- `examples/go/clients/sign-in-with-x`

Example scenarios:

- auth-only route protected by SIWX
- paid route where the first request pays
- second request to the same paid route authenticates with SIWX instead of paying again
- EVM flow first
- Solana flow if implemented

### 6. Tests

Unit tests:

- declaration enrichment includes generated nonce and supported chains
- storage records and finds paid addresses
- storage handles address normalization
- nonce reuse is rejected when nonce tracking is enabled
- valid SIWX header grants auth-only access
- valid SIWX header grants paid-route access after payment was recorded
- valid SIWX header does not grant paid-route access before payment
- invalid header falls back to payment flow
- unsupported chain/signature type fails safely
- EVM signature signing and verification round trip

HTTP integration tests:

- server returns a SIWX challenge in `PAYMENT-REQUIRED`
- client retries with `SIGN-IN-WITH-X`
- auth-only route succeeds without `PAYMENT-SIGNATURE`
- paid route falls back to payment when SIWX auth is unavailable
- paid route uses SIWX on repeat access after a successful payment

Cross-SDK test matrix:

- Go client -> Go server
- TS client -> Go server
- Python client -> Go server
- Go client -> TS server
- Go client -> Python server

Start with EVM. Add Solana cases if Solana support lands in the same PR.

## Milestones

### Milestone 1: Server-Side Parity

Status: Completed

Deliverables:

- `SIWxStorage`
- `InMemorySIWxStorage`
- `CreateSIWxResourceServerExtension`
- request hook
- settle hook
- server unit tests

### Milestone 2: EVM Client Auth

Status: Completed

Deliverables:

- EVM signer abstraction
- SIWX payload creation from server challenge
- SIWX header creation
- client-side hook/extension API
- HTTP retry tests

### Milestone 3: Examples And Docs

Status: Completed for EVM auth-only flow

Deliverables:

- Go client example
- Go server example
- package README updated from helper-only wording to parity-oriented usage
- PR description updated with parity checklist and test matrix

### Milestone 4: Expanded Parity

Status: Not started

Deliverables:

- Solana support, if practical
- EIP-1271/EIP-6492 support, if practical
- cross-SDK test notes
- maintainer-facing summary comment

## Risks And Notes

- The largest design risk is client-side parity because Go currently lacks the same explicit HTTP `onPaymentRequired` extension hook that TS/Python use.
- Avoid overloading the existing `ClientExtension` payload enrichment path for SIWX auth-only retries unless it can be done cleanly.
- Keep invalid SIWX auth non-fatal: failed auth should usually fall back to payment, not break access.
- The package README should no longer say middleware integration and Solana are intentionally out of scope without maintainer confirmation.
- Rebase changed the local branch history. Updating the existing PR will require a force-with-lease push.

## Immediate Next Steps

1. Implement storage and server hooks.
2. Add server-side tests around paid-route and auth-only access.
3. Add EVM client signing and header generation.
4. Add HTTP client SIWX retry support.
5. Add examples and update README.
6. Run focused Go tests.
7. Push with `--force-with-lease` when ready to update the PR branch.
