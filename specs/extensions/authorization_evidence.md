# Extension: `authorization-evidence`

## Summary

Pre-payment authorization evidence for agent-originated payments. Before a
payment is verified, the resource server evaluates an operator-signed spend
mandate through an External Verifier Contract v1 (EVC) verifier and fails
closed on every abnormal path: a funded, correctly signed payment is still
denied when the presenting agent was never authorized to spend that amount
with that payee at that moment.

Boundary with adjacent extensions: `sign-in-with-x` authenticates *who* the
caller is; the `auth-hints` extension advertises *which* accepts entries
require authentication; `offer-receipt` proves *what the server committed and
delivered*. `authorization-evidence` answers a different question — *what the
caller's agent was allowed to spend, before execution* — and composes with
all three. The facilitator is not involved.

EVC is an independent, royalty-free third-party contract
(<https://github.com/bolyra/bolyra/blob/main/spec/external-verifier-contract-v1.md>,
IETF Internet-Draft `draft-kondoju-evc`) and is not part of x402. Any
conformant verifier works; the reference implementation is `bolyra verify`.
The extension implements the contract's HOST side, whose behavior is
mechanically testable: `npx @bolyra/evc-conformance --host "<command>"` runs
the published 28-vector host suite.

---

## PaymentRequired

Declaring the extension on a route makes evidence mandatory for that route.
The server advertises, per response:

```json
{
  "extensions": {
    "authorization-evidence": {
      "info": {
        "profile": "authorization-evidence/0",
        "nonce": "v0.1755900300.9f2c….3ab1…",
        "expiresAt": 1755900300
      },
      "schema": { "…": "JSON Schema for the info payload" }
    }
  }
}
```

- `profile` — the extension profile version.
- `nonce` — a fresh, single-use, HMAC-signed challenge minted per response.
  Stateless: the expiry is embedded and tamper-evident, so any server
  instance sharing the challenge secret can validate any instance's
  challenge. Declared as a dynamic info field (excluded from echo
  comparison).
- `expiresAt` — unix seconds after which the challenge is stale. Dynamic.

## PaymentPayload

The client echoes the advertised info and adds one field:

```json
{
  "extensions": {
    "authorization-evidence": {
      "info": {
        "profile": "authorization-evidence/0",
        "nonce": "v0.1755900300.9f2c….3ab1…",
        "expiresAt": 1755900300,
        "evidence": "<opaque mandate presentation>"
      }
    }
  }
}
```

- `evidence` — the opaque presentation of the operator-signed spend mandate.
  The extension never inspects it; it is the EVC `bundle`, owned by the
  verifier. There are no server-owned fields.

v1 payloads cannot carry extensions; on a declared route they are always
denied (`authorization_evidence_required`). This is deliberate fail-closed
behavior, not an oversight.

## Verification (server-side, `onBeforeVerify`)

Before facilitator verification, the server:

1. Extracts `evidence` and `nonce` from the echoed info; missing or empty →
   abort `authorization_evidence_required`.
2. Validates the challenge HMAC and freshness → abort
   `authorization_evidence_denied: expired`.
3. Checks its configured audience covers the selected requirement's `payTo`
   (byte-literal by default) → abort
   `authorization_evidence_denied: request_mismatch`.
4. Reserves the challenge nonce (reserve-before-act) → replay aborts
   `authorization_evidence_denied: nonce_replayed`.
5. Builds one EVC request — the x402 context (resource, amount, asset,
   network, payee, challenge) rides as an envelope-level `x402_evc` member
   that profile-unaware conformant verifiers ignore — and spawns the
   configured verifier: one JSON request on stdin, one closed verdict on
   stdout.
6. A schema-valid verifier deny is relayed unchanged
   (`authorization_evidence_denied: <code>`); every abnormal verifier
   behavior (timeout, output overflow, signal death, non-zero exit,
   malformed or out-of-registry verdict) fails closed
   (`authorization_evidence_denied: verifier_<class>`).

An allow returns control to the normal payment flow: evidence authorizes the
spend, it never substitutes for payment.

## Responsibilities

- **Server** — mint challenges; enforce audience/payee coverage, challenge
  freshness, and reserve-before-act; enforce every EVC host obligation on the
  spawned verifier; never fail open.
- **Client** — obtain the mandate presentation from its operator tooling,
  echo the advertised info, attach `evidence`.
- **Verifier** (external, pluggable) — validate the mandate cryptographically
  (signature, audience, capability tier, expiry) and return one closed
  verdict.
- **Facilitator** — not involved.
