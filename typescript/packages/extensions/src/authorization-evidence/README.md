# Authorization Evidence Extension

Pre-payment authorization evidence for agent-originated payments. Before a
payment is verified, the resource server checks an operator-signed spend
mandate through an [External Verifier Contract v1](https://github.com/bolyra/bolyra/blob/main/spec/external-verifier-contract-v1.md)
(EVC) verifier and fails closed on every abnormal path: a funded, signed
payment can still be denied because the agent was never authorized to spend
that amount with that payee.

Boundary versus adjacent extensions: `sign-in-with-x` authenticates *who* the
caller is; `offer-receipt` proves *what the server committed and delivered*;
`authorization-evidence` proves *what the caller's agent was allowed to
spend, before execution*. The three compose.

The verifier is a pluggable subprocess speaking the EVC: one JSON request on
stdin, one fail-closed verdict on stdout. Any conformant implementation works
(the reference is `bolyra verify` from `@bolyra/cli`); this extension's host
boundary passes the published 28-vector conformance suite
(`npx @bolyra/evc-conformance --host "<command>"`). EVC is an independent
third-party contract and is not part of x402.

See the [documentation](../../../../docs/extensions/authorization-evidence.mdx)
and [`specs/extensions/authorization_evidence.md`](../../../../../specs/extensions/authorization_evidence.md)
for the full protocol description.
