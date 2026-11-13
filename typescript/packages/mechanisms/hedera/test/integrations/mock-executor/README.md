# Test executors for `transferExecutor`

> **Integration-test contracts only. Not audited. Do not use in production.**
>
> **Neither contract is representative of a real executor.** The spec
> ([`scheme_exact_hedera.md`](../../../../../../specs/schemes/exact/scheme_exact_hedera.md)) defines no
> canonical executor, and these are not references or templates. A real executor authenticates its
> caller's authorization and binds it to the transfer, and has policy, limits and a threat model of
> its own. These exist only to exercise the **facilitator** against a real network, and each one omits
> what a real executor needs. Do not copy them into a product, and do not read their behaviour as
> guidance on how an executor should be written.

Two contracts, one purpose each:

| Contract | What it lets the facilitator tests show |
| --- | --- |
| `MockTransferExecutor` | Misbehaviour. Its `authorization` picks a behaviour (revert, move nothing, overpay, emit a fake log, burn gas, ...) so the verify, settle and record checks can be driven through each failure on a real network. It does no authorization. |
| `SignedOwnerExecutor` | A signature and an allowance. It checks an owner signature on chain through HAS `isAuthorized` against the account's **current** key, and spends a HIP-336 HBAR allowance. It shows the simulation channel handling a system-contract authorization, a payer other than the executor in a real record, and a key rotation. |

## Quick start

Run everything from `typescript/packages/mechanisms/hedera`.

1. Copy `.env.example` to `.env.local` (gitignored, never commit it) and set a funded testnet ECDSA
   account (see [Testnet Faucet](../../../README.md#testnet-faucet)):

   ```
   HEDERA_FACILITATOR_ACCOUNT_ID=0.0.x
   HEDERA_FACILITATOR_PRIVATE_KEY=<DER or 0x-hex ECDSA key>
   ```

2. Build `@x402/core` once, since the tests import it from `dist`:

   ```bash
   pnpm --filter @x402/core build
   ```

3. Create a `payTo` account (the facilitator can't be its own `payTo`) and deploy the contracts:

   ```bash
   pnpm exec tsx --env-file=.env.local test/integrations/mock-executor/create-account.ts
   pnpm exec tsx --env-file=.env.local test/integrations/mock-executor/deploy.ts MockTransferExecutor
   pnpm exec tsx --env-file=.env.local test/integrations/mock-executor/deploy.ts SignedOwnerExecutor
   ```

   Each script prints the line to add to `.env.local`: `HEDERA_RESOURCE_SERVER_ACCOUNT_ID`,
   `HEDERA_TE_MOCK_EXECUTOR_ID` and `HEDERA_TE_SIGNED_EXECUTOR_ID`.

   `MockTransferExecutor` is funded with 20 HBAR (`HEDERA_TE_FUND_HBAR`) and given a recipient for
   its `EXTRA_CREDIT` mode, by default the deployer. To use a third account, create one with
   `create-account.ts` and pass it as `HEDERA_TE_EXTRA_RECIPIENT_ACCOUNT_ID`. The script resolves it to
   its alias address, because a native transfer to the long-zero form of an alias account fails.
   `SignedOwnerExecutor` holds no funds.

4. Run the suites. Each builds its own authorizations, so they can be run repeatedly:

   ```bash
   pnpm exec vitest run --config vitest.integration.config.ts \
     test/integrations/exact-hedera.transferExecutor.cornerCases.test.ts \
     test/integrations/exact-hedera.transferExecutor.signedOwner.test.ts \
     test/integrations/exact-hedera.transferExecutor.hts.test.ts
   ```

   Each suite skips, with no network access, unless its variables are set. The verify cases cost nothing.
   Each settle case spends the fee of one testnet contract call, and the signed suite also creates an
   owner account per test (2 HBAR, paid by the facilitator). The HTS suite creates two tokens and two payees per run, which costs a few HBAR in fees.

## `MockTransferExecutor` modes

`authorization = abi.encode(uint8 mode, uint256 validBefore, bytes32 binding, bytes32 nonce)`, built by
`authorize.ts [MODE]` or by the suite. The contract also reverts on an expired `validBefore`, on a
`binding` that doesn't match the call's `(from, asset, to, amount)`, and on a consumed authorization.

| Mode | What the mock does | What the facilitator should report |
| --- | --- | --- |
| `OK` | pays `amount`, consumes the authorization | success |
| `REVERT` | reverts | `simulation_reverted` |
| `NOOP` | returns, moves nothing | `settlement_payee_credit_mismatch` (SUCCESS receipt, no transfer) |
| `OVERPAY` | pays `amount + 1` | `settlement_payee_credit_mismatch` |
| `UNDERPAY` | pays `amount - 1` | `settlement_payee_credit_mismatch` |
| `EXTRA_CREDIT` | pays `amount`, then 1 more to a third account | `settlement_payer_debit_mismatch` |
| `LOG_CALLER_TRANSFER` | pays `amount`, emits a `Transfer` log whose sender is the caller | `settlement_unexpected_transfer` |
| `OK_NO_CONSUME` | pays `amount`, does not consume | success, and replayable (the facilitator can't detect this) |
| `BURN_GAS` | loops until it runs out of gas, with no revert reason | `simulation_reverted` |
| `OK_THEN_BURN_GAS` | pays, then spends gas down to a floor and succeeds | success; with a ceiling set, `simulation_gas_exceeded` |

## `SignedOwnerExecutor`

`authorization = abi.encode(uint256 validBefore, bytes32 nonce, bytes pubKey, bytes signature)`, where
`pubKey` is the 33-byte compressed secp256k1 key and `signature` is `r || s` over the digest
`abi.encode(DOMAIN, from, asset, to, amount, validBefore, nonce, chainid, executor)`. The owner
account is created per test with an alias, grants the executor an HBAR allowance, and signs with its
own key. HBAR and single-ECDSA-key owners only.

## Recorded fixtures (what runs in CI)

The live suites need testnet and funds, so they do not run in pull-request CI. To keep their findings
under test anyway, a live run can record what the facilitator read and returned:

```bash
RECORD_FIXTURES=1 pnpm exec vitest run --config vitest.integration.config.ts \
  test/integrations/exact-hedera.transferExecutor.cornerCases.test.ts \
  test/integrations/exact-hedera.transferExecutor.signedOwner.test.ts
```

This writes `test/fixtures/transferExecutor/*.json`: the Mirror Node responses, the result of the
submitted call, and the `verify` and `settle` outcomes of each case. `test/unit/transferExecutor.recorded.test.ts`
replays them through the real capabilities with a stubbed `fetch` and requires the same outcomes, with
no network and no credentials. Account lookups are cut to the fields the facilitator reads, because
the Mirror Node embeds an account's recent transactions in them. Only public testnet data is recorded.

Re-record after a deliberate change to how records, simulation errors or account lookups are
handled, and review the fixture diff. The concurrent-settle case is not recorded, because a replay
cannot reproduce its ordering.

## Rebuilding the contracts

`artifacts/*.json` (ABI and creation bytecode) are committed, so deploying needs no toolchain. After
editing `src/*.sol`, run `./build.sh` (needs [Foundry](https://getfoundry.sh)) and commit the new
artifacts. `foundry.toml` drops the metadata hash so the bytecode is reproducible.
