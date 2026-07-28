# Casper Speculative Execution Verification Design

## Summary

Add an optional final check to the TypeScript exact Casper facilitator `verify()` path. When the facilitator signer was created with a dedicated Casper speculative execution RPC endpoint, `verify()` simulates the same CEP-3009 `transfer_with_authorization` call that `settle()` would submit and only returns `isValid: true` when the simulation succeeds.

This closes gaps that targeted preflight checks can miss, such as contract-specific authorization logic, runtime argument incompatibilities, or payment amount issues that only appear during execution. The feature remains opt-in because not every Casper node exposes the speculative execution endpoint.

## Goals

- Keep existing facilitator behavior unchanged when no speculative RPC endpoint is configured.
- Reuse the current `transfer_with_authorization` transaction construction logic as closely as possible.
- Use the Casper JS SDK `SpeculativeClient` for the RPC call.
- Build a legacy deploy via `ContractCallBuilder.buildFor1_5()` because `SpeculativeClient.speculativeExec()` accepts a `Deploy`, not a `TransactionV1`.
- Fail closed when speculative execution is configured but cannot be completed or reports execution failure.
- Cover enabled, disabled, success, and failure paths with unit tests.

## Non-Goals

- Do not make speculative execution mandatory for Casper facilitators.
- Do not change the x402 wire format, `PaymentPayload`, `PaymentRequirements`, or the Casper scheme spec semantics.
- Do not replace the existing balance, authorization-state, contract-support, signature, or timestamp checks.
- Do not add a new package dependency.
- Do not change legacy/v1 packages.

## Current State

`typescript/packages/mechanisms/casper/src/exact/facilitator/scheme.ts` verifies Casper exact payments in this order:

1. Scheme and network checks.
2. Payload shape extraction.
3. Authorization field validation.
4. Signature and public-key validation.
5. Live preflight checks through the facilitator signer.
6. Return `{ isValid: true, payer }`.

Settlement in the same file constructs a Casper `ContractCallBuilder` call to `transfer_with_authorization`, signs it through `FacilitatorCasperSigner.signTransaction()`, submits it with `putTransaction()`, and waits for success.

`typescript/packages/mechanisms/casper/src/signer.ts` owns RPC client construction. It currently accepts an `rpcUrlConfig` for standard JSON-RPC and `preflightHooks` for live validation. It does not expose a speculative RPC URL or simulation hook.

The local `casper-js-sdk` dependency is `5.0.12`. Its docs and types expose:

- `SpeculativeClient.newSpeculativeClient(new HttpHandler(url))`
- `speculativeClient.speculativeExec(reqID, deploy, identifier?)`
- `ContractCallBuilder.buildFor1_5()`
- `Transaction.getDeploy()` and the wrapped deploy carried by a transaction built from a deploy

## Proposed API

Extend the Casper facilitator signer types with an optional simulation method:

```ts
import type { Deploy } from "casper-js-sdk";

export type CasperSpeculativeTransferParams = {
  network: Network;
  asset: string;
  deploy: Deploy;
};

export type FacilitatorCasperSigner = {
  // Existing fields remain unchanged.
  simulateTransferWithAuthorization?(params: CasperSpeculativeTransferParams): Promise<void>;
};
```

`simulateTransferWithAuthorization` is optional on the interface. Custom signers that do not support speculative execution keep compiling and keep current behavior.

Extend the signer factory configuration with a dedicated speculative RPC URL config:

```ts
export type RpcUrlConfig = Record<string, string>;
export type SpeculativeRpcUrlConfig = Record<string, string>;

export type FacilitatorCasperSignerOptions = {
  rpcUrlConfig?: RpcUrlConfig;
  preflightHooks?: PreflightHooks;
  speculativeRpcUrlConfig?: SpeculativeRpcUrlConfig;
};

export async function createFacilitatorCasperSigner(
  privateKey: string,
  algorithm: KeyAlgorithmType = KeyAlgorithm.ED25519,
  options: FacilitatorCasperSignerOptions = {},
): Promise<FacilitatorCasperSigner>;
```

Keep `privateKey` and `algorithm` positional because the algorithm is part of decoding the private key. Move the remaining signer configuration into `FacilitatorCasperSignerOptions` so standard RPC, preflight hooks, and speculative RPC cannot be confused by position.

`toFacilitatorCasperSigner()` should use a matching options object without `algorithm`:

```ts
export type ToFacilitatorCasperSignerOptions = FacilitatorCasperSignerOptions;

export async function toFacilitatorCasperSigner(
  privateKey: PrivateKeyType,
  options: ToFacilitatorCasperSignerOptions = {},
): Promise<FacilitatorCasperSigner>;
```

If `options.speculativeRpcUrlConfig[network]` exists for the requested network, the returned signer includes `simulateTransferWithAuthorization`. If it does not exist, the returned signer omits that method. This makes the condition explicit: speculative verification runs only when the dedicated speculative RPC endpoint was provided for that exact network at signer creation.

Example:

```ts
await createFacilitatorCasperSigner(privateKey, KeyAlgorithm.SECP256K1, {
  rpcUrlConfig: { "casper:casper-test": rpcUrl },
  preflightHooks,
  speculativeRpcUrlConfig: { "casper:casper-test": speculativeRpcUrl },
});
```

## Verify Flow

Add a final validation step after `validatePreflight()` and before the success response:

```ts
const simulationValidation = await this.validateSpeculativeExecution(exactPayload, requirements);
if (simulationValidation) {
  return simulationValidation;
}

return { isValid: true, payer };
```

`validateSpeculativeExecution()` should return `undefined` when `this.signer.simulateTransferWithAuthorization` is absent.

When the simulation hook exists, `validateSpeculativeExecution()`:

1. Resolves `networkConfig` with `this.signer.getNetworkConfig(requirements.network)`.
2. Builds the same `transfer_with_authorization` contract call as settlement, using the same facilitator public key, package hash, entry point, runtime args, chain name, and payment amount.
3. Calls `.buildFor1_5()` instead of `.build()`.
4. Signs the resulting transaction through `this.signer.signTransaction(transaction, requirements.network)`.
5. Extracts the deploy with `transaction.getDeploy()` or the SDK-supported equivalent.
6. Returns invalid if no deploy is available.
7. Calls `this.signer.simulateTransferWithAuthorization({ network: requirements.network, asset: requirements.asset, deploy })`.
8. Returns invalid on any thrown error.

Add a new invalid reason:

```ts
export const ErrSpeculativeExecutionFailed =
  "invalid_exact_casper_facilitator_speculative_execution_failed";
```

All simulation build, sign, extraction, transport, parse, and execution failures map to that reason. Include the thrown error message as `invalidMessage`.

## Signer Simulation Hook

In `signer.ts`, cache `SpeculativeClient` instances separately from standard `RpcClient` instances and key them by speculative RPC URL.

Resolution rules:

- `rpcUrlConfig` and `speculativeRpcUrlConfig` are explicit CAIP-2 network-to-URL maps.
- Standard RPC lookup uses `options.rpcUrlConfig?.[network] ?? NetworkConfigs[network]?.rpcUrl ?? ""`.
- Speculative RPC lookup uses `options.speculativeRpcUrlConfig?.[network]`.
- No speculative endpoint for the requested network means the signer does not expose `simulateTransferWithAuthorization`.

The hook implementation should:

1. Create or reuse `SpeculativeClient.newSpeculativeClient(new HttpHandler(speculativeRpcUrl))`.
2. Call `speculativeExec("1", deploy)`.
3. Treat `executionResultV1.failure` as failure and throw its `errorMessage` when present.
4. Treat `executionResult.errorMessage` as failure and throw that message.
5. Treat a response with neither a recognizable success nor a recognizable failure as failure, including raw JSON when useful.
6. Resolve successfully only when the speculative execution result is successful.

The request id can be a simple stable string such as `"1"` because it is only the JSON-RPC request id, not part of authorization replay protection.

## Transaction Builder Reuse

Avoid duplicating the long `ContractCallBuilder` chain in both `settle()` and speculative verification. Introduce a private helper in `scheme.ts`:

```ts
private async buildTransferWithAuthorizationTransaction(
  payload: ExactCasperPayload,
  requirements: PaymentRequirements,
  mode: "transaction-v1" | "deploy" = "transaction-v1",
): Promise<casperSdk.Transaction>
```

The helper should:

- Resolve the facilitator public key from `this.signer.getPublicKeyHex(requirements.network)`.
- Resolve the network chain name from `this.signer.getNetworkConfig(requirements.network)`.
- Build the `ContractCallBuilder` with the existing runtime args.
- Use `.build()` when `mode === "transaction-v1"` for settlement.
- Use `.buildFor1_5()` when `mode === "deploy"` for speculative execution.

Settlement continues to call the helper without a mode argument, then sign and submit the default `transaction-v1` transaction. Speculative verification explicitly passes `"deploy"`, signs that transaction, and extracts its wrapped `Deploy`.

## Error Handling

The feature is fail-open only when the signer has no speculative simulation hook. Once the hook exists, it is fail-closed:

- Missing speculative endpoint for a network: hook absent, simulation skipped.
- Speculative endpoint configured but transport fails: invalid verify response with `ErrSpeculativeExecutionFailed`.
- Speculative endpoint returns execution failure: invalid verify response with `ErrSpeculativeExecutionFailed`.
- `buildFor1_5()` returns a transaction without a deploy wrapper: invalid verify response with `ErrSpeculativeExecutionFailed`.
- Signing the deploy-form transaction fails: invalid verify response with `ErrSpeculativeExecutionFailed`.

This keeps opt-in behavior predictable: providing the endpoint means the facilitator asked for execution parity, so the check must succeed before `verify()` succeeds.

## Testing

Update `typescript/packages/mechanisms/casper/test/unit/facilitator.test.ts`:

- Existing `validates a correct payload` should continue passing with a signer that has no simulation hook.
- Add a test that a signer with `simulateTransferWithAuthorization` returning successfully produces a valid verify response and receives a deploy-bearing call after the existing preflight checks.
- Add a test that a throwing simulation hook returns `isValid: false` with `ErrSpeculativeExecutionFailed` and includes the thrown message.
- Add a test that simulation is skipped when the hook is absent.
- Add a test that settlement still uses the normal transaction path and still signs once during settlement.

Update `typescript/packages/mechanisms/casper/test/unit/signer.test.ts`:

- Add a signer factory test showing no simulation hook is present when no speculative RPC URL is provided.
- Add a signer factory test showing the hook is present when a speculative RPC URL is provided.
- Mock `SpeculativeClient`/`HttpHandler` to test that `speculativeExec("1", deploy)` is called.
- Test success for `executionResultV1.success`.
- Test failure for `executionResultV1.failure.errorMessage`.
- Test failure for `executionResult.errorMessage`.

Run:

```bash
pnpm --filter @x402/casper test
pnpm --filter @x402/casper build
```

## Documentation

Update `typescript/packages/mechanisms/casper/README.md` facilitator setup to show the new `FacilitatorCasperSignerOptions` object and optional `speculativeRpcUrlConfig`. Mention that the endpoint is commonly separate from standard node JSON-RPC and may use port `7778`.

No protocol spec update is required because `specs/schemes/exact/scheme_exact_casper.md` already defines speculative execution as an optional verification step.

## Migration

Update the existing repository call sites from `createFacilitatorCasperSigner(privateKey, algorithm, rpcUrlConfig, preflightHooks)` to `createFacilitatorCasperSigner(privateKey, algorithm, { rpcUrlConfig, preflightHooks })`.

This is a source-breaking change for callers, but the current Casper facilitator clients are in this repository and can be migrated in the same feature. They do not run speculative execution until they set `speculativeRpcUrlConfig`.

Custom facilitator signers continue working because `simulateTransferWithAuthorization` is optional.

Applications that opt in must ensure the configured speculative endpoint is available and accepts the legacy deploy produced by `buildFor1_5()`.

## Decisions

- `privateKey` and `algorithm` remain positional because they jointly decode the facilitator key.
- Standard RPC URLs, preflight hooks, and speculative RPC URLs live in a named options object to avoid a five-argument signer factory.
- Settlement continues submitting the normal transaction built with `.build()`. Only speculative verification uses `.buildFor1_5()` because only `SpeculativeClient.speculativeExec()` requires a legacy `Deploy`.
