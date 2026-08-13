# New extension implementation

Checklist for adding a new extension. Follow the [general contributing rules](../SKILL.md) as well.

## Spec first

- A spec file must exist. If it does not, write it first.
- The spec must be approved by maintainers (merged into upstream `main`). If it is not, open a PR with the spec only first (`specs/extensions/...`).
- The implementation must follow the spec file exactly.
- The wire formats `PAYMENT-REQUIRED` (in particular the extension field), `PAYMENT-RESPONSE` and facilitator `supported/` output must match the spec strictly. Include only fields actually consumed downstream or required by the extension. Don't add purely informational fields.
- Spec amendments and edits are allowed, but must be well justified.

## Scope

- One language per PR. Never implement the extension in more than one SDK (TS, Python, Go) in a single PR.
- Implement v2 only. Common v1 tells (see the [V1→V2 migration guide](../../../../docs/guides/migration-v1-to-v2.mdx)): `maxAmount` in payment requirements, `X-PAYMENT`/`X-PAYMENT-RESPONSE` headers (v2 uses `PAYMENT-SIGNATURE`/`PAYMENT-RESPONSE`), string network names like `base-sepolia` (v2 uses CAIP-2 like `eip155:84532`) or `x402Version: 1`.

## Code patterns

- Wire extensions with lifecycle hooks via the extension-hooks adapter pattern.
- Reuse core and extension utilities instead of reimplementing them.
- Do NOT modify other packages (core, http, ...). If this is deemed necessary, discuss with maintainers first.

## Tests

### Unit tests

Pure-logic tests that run offline. Add them under **TS** `typescript/packages/extensions/test/`; **Go** `go/extensions/<extension>/`; or **Py** `python/x402/tests/unit/extensions/<extension>/`. Run them and confirm all pass.

```bash
# from typescript/
pnpm --filter @x402/extensions test
# go/
make test
# python/x402/
uv run pytest tests/unit/extensions/
```

### Integration tests

- In-process client/server/facilitator flow tests within the SDK. Requires funded testnet accounts.
- Add them under **TS** `typescript/packages/extensions/test/integrations/`; **Go** `go/extensions/<extension>/`; or **Py** `python/x402/tests/integrations/`. Suites skip when required env vars are missing.
- Run them and confirm all pass.

```bash
# from typescript/
pnpm --filter @x402/extensions test:integration
# go/
make test-integration
# python/x402/
uv run pytest tests/integrations/
```

## Examples

Add server, client, and facilitator examples (as appropriate). Manually confirm a successful payment by running facilitator server and client examples locally.

## Docs

- Add READMEs for the SDK and all examples.
