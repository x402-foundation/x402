# Security Policy

The Hoodgate team takes security seriously. Please do not file a public issue
discussing a potential vulnerability.

## Reporting a vulnerability

Report security issues privately to **security@hoodgate.example** (replace with
the real address before public launch), or via GitHub's private vulnerability
reporting on this repository (Security → Report a vulnerability).

Please include:

- A description of the vulnerability and its impact
- Steps to reproduce (proof-of-concept where possible)
- Affected component(s) — facilitator, demo-api, or client
- Any suggested remediation

## Scope

This project is **testnet only** at this stage. The facilitator holds a
funded signer key for the Robinhood Chain testnet (chainId 46630). Reports
concerning key handling, the `/verify` and `/settle` endpoints, EIP-3009
signature validation, and the `payTo` recipient check are especially welcome.

Mainnet is not yet supported; do not report against mainnet deployments.

## Response

We aim to acknowledge reports within 72 hours and provide a remediation
timeline after triage.
