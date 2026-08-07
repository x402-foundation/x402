# New mechanism implementation

Checklist for adding a new payment mechanism / scheme. Follow the [general contributing rules](../SKILL.md) as well.

## Spec first

- A spec file must exist. If it does not, write it first.
- The spec must be approved by maintainers (merged into upstream `main`). If it is not, open a PR with the spec only first (`specs/schemes/...`).
- The implementation must follow the spec file exactly. Facilitator verification rules are security-critical. 
- The wire formats `PAYMENT-REQUIRED` (in particular the `extra` field), `PAYMENT-RESPONSE` and facilitator `supported/` output must match the spec strictly. Include only fields actually consumed downstream or required by the scheme. Don't add purely informational fields.
- Spec amendments and edits are allowed, but must be well justified.

## Scope

- One language per PR. Never implement the mechanism in more than one SDK (TypeScript, Python, Go) in a single PR.
- If a reference implementation already exists in another SDK, cross-check against it; otherwise yours is the reference and the spec is the only source of truth.
- Implement v2 only. Common v1 tells (see the [V1→V2 migration guide](../../../../docs/guides/migration-v1-to-v2.mdx)): `maxAmount` in payment requirements, `X-PAYMENT`/`X-PAYMENT-RESPONSE` headers (v2 uses `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`), string network names like `base-sepolia` (v2 uses CAIP-2 like `eip155:84532`) or `x402Version: 1`.

## Code patterns

- Wire schemes with the builder pattern, not `register*` helpers. A new v2-only mechanism registers its scheme under the family wildcard: `client.register("<family>:*", new Exact<Chain>Scheme(...))` (and the same on `x402ResourceServer`). Do NOT implement a `registerExact<Chain>Scheme` helper. Those exist only in the EVM/SVM mechanisms to also register the legacy v1 schemes for backward compat.
- Reuse core utilities instead of reimplementing them. For example, import `convertToTokenAmount`, `numberToDecimalString`, and `parseMoneyString` from `@x402/core/utils` for TS or similar for Go/python SDKs.
- Do NOT modify other packages (core, http, ...). If this is deemed necessary, discuss with maintainers first.

## Tests

### Unit tests

Pure-logic tests that run offline with no live RPC or network calls. Add them with comparable coverage to the EVM reference under **TS** `typescript/packages/mechanisms/<chain>/test/unit/`; **Go** `go/mechanisms/<chain>/` or **Py** `python/x402/tests/unit/mechanisms/<chain>/`. Run them and confirm all pass.

```bash
# typescript/
pnpm --filter @x402/<chain> test
# go/
make test
# python/x402/
uv run pytest
```

### Integration tests

- In-process client/server/facilitator flow tests within the SDK that exercise real RPC endpoints and may submit onchain transactions. Requires funded testnet accounts. 
- Add them with comparable coverage to the EVM reference under **TS** `typescript/packages/mechanisms/<chain>/test/integrations/` (see `exact-evm.test.ts`); **Go** `go/test/integration/`; **Py** `python/x402/tests/integrations/`. Suites skip when required env vars are missing. 
- Run them and confirm all pass.

```bash
# typescript/
pnpm --filter @x402/<chain> test:integration
# go/
make test-integration
# python/x402/
uv run pytest tests/integrations/
```

### E2E tests

- The `e2e/` harness runs every client × server × facilitator combination. Requires funded testnet accounts.
- Register the network signer in the facilitator and all client frameworks. 
- Add protected routes for all server frameworks. 
- Run them and confirm all pass.

```bash
# from e2e/
pnpm install:all && pnpm test --testnet --min --families=<chain> --versions=2
```

## Examples

- Add network to server, client and facilitator examples under `examples/<sdk>/*/advanced/all_networks`. 
- Manually confirm a successful payment by running facilitator, server and client examples locally.

## Docs

- Add READMEs for the SDK and all examples.
- Include link to a testnet faucet and detail all necessecary setup steps (e.g. token association/opt-ins or minimum balance requirements).

## Publishing scripts

Mirror the EVM setup per SDK:

- **TS**: Add `publish_npm_scoped_x402_<chain>.yml` workflow and add package to `publish_npm_scoped_x402_all.yml`.
- **Py**: Add an optional extra in `python/x402/pyproject.toml`; uses existing `publish_pypi_x402.yml`.
- **Go**: no new workflow required; ships with the `go/` module.
